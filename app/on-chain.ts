import { address, signature } from "@solana/kit";
import type { AppClient } from "./providers";
import type { TransactionRecord } from "./storage";

type ParsedInstructionInfo = {
  source?: string;
  destination?: string;
  lamports?: number | string | bigint;
};

type ParsedInstruction = {
  program?: string;
  parsed?: {
    type?: string;
    info?: ParsedInstructionInfo;
  };
};

type InnerInstructionGroup = {
  instructions?: readonly (ParsedInstruction | unknown)[];
};

type ParsedAccountItem = {
  pubkey?: string;
};

type ParsedTransactionResponse = {
  transaction?: {
    message?: {
      accountKeys?: readonly (ParsedAccountItem | string)[];
      instructions?: readonly (ParsedInstruction | unknown)[];
    };
  };
  meta?: {
    err?: unknown;
    fee?: number | bigint;
    preBalances?: readonly (number | bigint)[];
    postBalances?: readonly (number | bigint)[];
    innerInstructions?: readonly InnerInstructionGroup[] | null;
  } | null;
};

/**
 * Extracts SOL transfer details from a jsonParsed transaction.
 */
function extractSolTransfer(
  tx: ParsedTransactionResponse,
  walletAddress: string
): {
  amount: string;
  sender: string;
  recipient: string;
  direction: "incoming" | "outgoing";
} | null {
  if (!tx || !tx.meta) {
    return null;
  }

  // 1. Check top-level and inner instructions for parsed system transfer
  const instructions: unknown[] = [];
  if (Array.isArray(tx.transaction?.message?.instructions)) {
    instructions.push(...tx.transaction.message.instructions);
  }
  if (Array.isArray(tx.meta?.innerInstructions)) {
    for (const inner of tx.meta.innerInstructions) {
      if (Array.isArray(inner?.instructions)) {
        instructions.push(...inner.instructions);
      }
    }
  }

  for (const item of instructions) {
    if (item && typeof item === "object") {
      const ix = item as ParsedInstruction;
      if (
        ix.program === "system" &&
        ix.parsed &&
        (ix.parsed.type === "transfer" || ix.parsed.type === "transferChecked")
      ) {
        const info = ix.parsed.info;
        if (info && info.source && info.destination) {
          const lamportsVal = BigInt(info.lamports ?? 0);
          if (lamportsVal > BigInt(0)) {
            if (info.source === walletAddress) {
              return {
                amount: (Number(lamportsVal) / 1_000_000_000).toFixed(4),
                sender: info.source,
                recipient: info.destination,
                direction: "outgoing",
              };
            }
            if (info.destination === walletAddress) {
              return {
                amount: (Number(lamportsVal) / 1_000_000_000).toFixed(4),
                sender: info.source,
                recipient: info.destination,
                direction: "incoming",
              };
            }
          }
        }
      }
    }
  }

  // 2. Fallback to balance differences in transaction metadata
  const accountKeys = tx.transaction?.message?.accountKeys || [];
  const walletIdx = accountKeys.findIndex((k) => {
    const pub = typeof k === "string" ? k : k?.pubkey;
    return pub === walletAddress;
  });

  if (
    walletIdx !== -1 &&
    Array.isArray(tx.meta?.preBalances) &&
    Array.isArray(tx.meta?.postBalances)
  ) {
    const pre = BigInt(tx.meta.preBalances[walletIdx] ?? 0);
    const post = BigInt(tx.meta.postBalances[walletIdx] ?? 0);
    const diff = post - pre;
    const fee = walletIdx === 0 ? BigInt(tx.meta.fee ?? 0) : BigInt(0);

    if (diff > BigInt(0)) {
      // Incoming transfer
      const senderKey = accountKeys[0];
      const sender =
        (typeof senderKey === "string" ? senderKey : senderKey?.pubkey) ||
        "Unknown";
      return {
        amount: (Number(diff) / 1_000_000_000).toFixed(4),
        sender,
        recipient: walletAddress,
        direction: "incoming",
      };
    }

    if (diff < BigInt(0)) {
      const sent = -diff - fee;
      if (sent > BigInt(0)) {
        // Outgoing transfer: find recipient account whose balance increased
        let recipient = "Unknown";
        for (let i = 0; i < accountKeys.length; i++) {
          if (i !== walletIdx) {
            const rPre = BigInt(tx.meta.preBalances[i] ?? 0);
            const rPost = BigInt(tx.meta.postBalances[i] ?? 0);
            if (rPost > rPre) {
              const k = accountKeys[i];
              recipient =
                (typeof k === "string" ? k : k?.pubkey) || "Unknown";
              break;
            }
          }
        }
        return {
          amount: (Number(sent) / 1_000_000_000).toFixed(4),
          sender: walletAddress,
          recipient,
          direction: "outgoing",
        };
      }
    }
  }

  return null;
}

/**
 * Retrieves previous transactions for a wallet directly from Solana Devnet.
 * Automatically identifies SOL transfers, direction, amount, status, and participants.
 */
export async function fetchOnChainTransactions(
  client: AppClient,
  walletAddress: string
): Promise<TransactionRecord[]> {
  if (!walletAddress) {
    return [];
  }

  const cleanAddress = walletAddress.trim();
  if (!cleanAddress) {
    return [];
  }

  // 1. Fetch recent transaction signatures from Devnet
  const signaturesResponse = await client.rpc
    .getSignaturesForAddress(address(cleanAddress), { limit: 20 })
    .send();

  if (!Array.isArray(signaturesResponse) || signaturesResponse.length === 0) {
    return [];
  }

  const records: TransactionRecord[] = [];

  // 2. Fetch transaction details in batches of 5 to avoid Devnet rate-limits
  const batchSize = 5;
  for (let i = 0; i < signaturesResponse.length; i += batchSize) {
    const batch = signaturesResponse.slice(i, i + batchSize);

    const batchResults = await Promise.allSettled(
      batch.map(async (sigInfo): Promise<TransactionRecord | null> => {
        const sigStr = sigInfo.signature as string;
        const timestamp =
          sigInfo.blockTime != null
            ? Number(sigInfo.blockTime) * 1000
            : Date.now();

        const status: TransactionRecord["status"] = sigInfo.err
          ? "failed"
          : (sigInfo.confirmationStatus as TransactionRecord["status"]) ||
            "confirmed";

        try {
          const tx = (await client.rpc
            .getTransaction(signature(sigStr), {
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
            })
            .send()) as ParsedTransactionResponse | null;

          if (tx) {
            const transfer = extractSolTransfer(tx, cleanAddress);
            if (transfer) {
              return {
                signature: sigStr,
                amount: transfer.amount,
                sender: transfer.sender,
                recipient: transfer.recipient,
                direction: transfer.direction,
                status: tx.meta?.err ? "failed" : status,
                timestamp,
              };
            }
          }
        } catch {
          // Unsupported transaction version or temporary RPC issue: handled gracefully
        }

        // If the transaction failed on-chain, display with failed status
        if (sigInfo.err) {
          return {
            signature: sigStr,
            amount: "0.0000",
            sender: cleanAddress,
            recipient: "Unknown",
            direction: "outgoing",
            status: "failed",
            timestamp,
          };
        }

        return null;
      })
    );

    for (const res of batchResults) {
      if (res.status === "fulfilled" && res.value !== null) {
        records.push(res.value);
      }
    }
  }

  return records;
}
