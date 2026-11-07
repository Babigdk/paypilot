import { address } from "@solana/kit";
import type { AppClient } from "./providers";

export const BASE_TRANSACTION_FEE_LAMPORTS = BigInt(5000); // 0.000005 SOL
export const LAMPORTS_PER_SOL = BigInt(1_000_000_000);
export const DEVNET_CHAIN = "solana:devnet";

export type FeeEstimate = {
  baseFeeLamports: bigint;
  prioritizationFeeLamports: bigint;
  totalFeeLamports: bigint;
  totalFeeSol: string;
};

export type PreTransactionValidationResult =
  | {
      valid: true;
      amountLamports: bigint;
      feeEstimate: FeeEstimate;
      totalDeductionLamports: bigint;
      totalDeductionSol: string;
      currentBalanceLamports: bigint;
      currentBalanceSol: string;
    }
  | {
      valid: false;
      error: string;
      code:
        | "DISCONNECTED_WALLET"
        | "INVALID_NETWORK"
        | "INVALID_RECIPIENT"
        | "SELF_TRANSFER"
        | "INVALID_AMOUNT"
        | "ZERO_OR_NEGATIVE_AMOUNT"
        | "EXCESSIVE_DECIMAL_PRECISION"
        | "INSUFFICIENT_BALANCE"
        | "INSUFFICIENT_FUNDS_FOR_FEES"
        | "RPC_ERROR";
    };

/**
 * Validates whether an amount string conforms to Solana's decimal precision.
 */
export function validateAmountPrecision(amount: string): {
  valid: boolean;
  error?: string;
  amountLamports?: bigint;
} {
  const trimmed = amount.trim();
  if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) {
    return {
      valid: false,
      error: "Please enter a valid positive number for the amount.",
    };
  }

  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > 9) {
    return {
      valid: false,
      error:
        "Amount exceeds Solana's precision limit of 9 decimal places (1 lamport = 0.000000001 SOL).",
    };
  }

  try {
    const wholeBig = BigInt(whole);
    const fractionBig = BigInt(fraction.padEnd(9, "0"));
    const lamports = wholeBig * LAMPORTS_PER_SOL + fractionBig;

    if (lamports <= BigInt(0)) {
      return {
        valid: false,
        error: "Payment amount must be greater than zero.",
      };
    }

    return { valid: true, amountLamports: lamports };
  } catch {
    return {
      valid: false,
      error: "Amount cannot be safely represented in lamports.",
    };
  }
}

/**
 * Estimates network transaction fees using supported Solana Kit RPC methods.
 */
export async function estimateTransactionFee(
  client: AppClient
): Promise<FeeEstimate> {
  let prioritizationFeeLamports = BigInt(0);

  try {
    const recentFees = await client.rpc.getRecentPrioritizationFees().send();
    if (Array.isArray(recentFees) && recentFees.length > 0) {
      // Find maximum prioritization fee from the most recent slots
      const maxFee = recentFees.slice(0, 5).reduce((max, item) => {
        const fee = BigInt(item.prioritizationFee ?? 0);
        return fee > max ? fee : max;
      }, BigInt(0));
      // Prioritization fee is in micro-lamports (1 lamport = 1,000,000 micro-lamports)
      prioritizationFeeLamports = maxFee / BigInt(1_000_000);
    }
  } catch {
    // If prioritization fee query fails, proceed with base transaction fee
    prioritizationFeeLamports = BigInt(0);
  }

  const totalFeeLamports =
    BASE_TRANSACTION_FEE_LAMPORTS + prioritizationFeeLamports;
  const totalFeeSol = (Number(totalFeeLamports) / 1_000_000_000).toFixed(6);

  return {
    baseFeeLamports: BASE_TRANSACTION_FEE_LAMPORTS,
    prioritizationFeeLamports,
    totalFeeLamports,
    totalFeeSol,
  };
}

/**
 * Performs comprehensive independent pre-transaction validation.
 */
export async function validateTransactionSafety({
  client,
  senderAddress,
  recipientAddress,
  amountSol,
  isWalletConnected,
  chain = DEVNET_CHAIN,
}: {
  client: AppClient;
  senderAddress?: string;
  recipientAddress: string;
  amountSol: string;
  isWalletConnected: boolean;
  chain?: string;
}): Promise<PreTransactionValidationResult> {
  // 1. Verify wallet is connected
  if (!isWalletConnected || !senderAddress) {
    return {
      valid: false,
      code: "DISCONNECTED_WALLET",
      error:
        "Wallet is not connected. Please connect your Phantom wallet to continue.",
    };
  }

  // 2. Verify network is Solana Devnet
  if (chain !== DEVNET_CHAIN) {
    return {
      valid: false,
      code: "INVALID_NETWORK",
      error:
        "Application is configured for Solana Devnet. Other networks are not supported.",
    };
  }

  // 3. Validate recipient address
  if (!recipientAddress || !recipientAddress.trim()) {
    return {
      valid: false,
      code: "INVALID_RECIPIENT",
      error: "Recipient address is required.",
    };
  }

  try {
    address(recipientAddress.trim());
  } catch {
    return {
      valid: false,
      code: "INVALID_RECIPIENT",
      error: `The recipient address '${recipientAddress}' is not a valid Solana address.`,
    };
  }

  // 4. Prevent self-transfer
  if (senderAddress.trim() === recipientAddress.trim()) {
    return {
      valid: false,
      code: "SELF_TRANSFER",
      error: "You cannot send a payment to your own connected wallet.",
    };
  }

  // 5. Validate amount precision and safety
  const precisionCheck = validateAmountPrecision(amountSol);
  if (!precisionCheck.valid || precisionCheck.amountLamports === undefined) {
    return {
      valid: false,
      code: precisionCheck.error?.includes("9 decimal")
        ? "EXCESSIVE_DECIMAL_PRECISION"
        : precisionCheck.error?.includes("greater than zero")
        ? "ZERO_OR_NEGATIVE_AMOUNT"
        : "INVALID_AMOUNT",
      error: precisionCheck.error || "Invalid transfer amount.",
    };
  }
  const amountLamports = precisionCheck.amountLamports;

  // 6. Estimate network fee
  const feeEstimate = await estimateTransactionFee(client);

  // 7. Retrieve the freshest on-chain balance immediately before transaction construction
  let currentBalanceLamports: bigint;
  try {
    const balanceResponse = await client.rpc
      .getBalance(address(senderAddress))
      .send();
    currentBalanceLamports = BigInt(balanceResponse.value);
  } catch (err) {
    return {
      valid: false,
      code: "RPC_ERROR",
      error:
        err instanceof Error
          ? `Could not retrieve latest wallet balance: ${err.message}`
          : "Could not connect to Solana Devnet to verify balance.",
    };
  }

  const currentBalanceSol = (
    Number(currentBalanceLamports) / 1_000_000_000
  ).toFixed(4);
  const totalDeductionLamports =
    amountLamports + feeEstimate.totalFeeLamports;
  const totalDeductionSol = (
    Number(totalDeductionLamports) / 1_000_000_000
  ).toFixed(6);

  // 8. Check if sender has enough balance for amount
  if (currentBalanceLamports < amountLamports) {
    return {
      valid: false,
      code: "INSUFFICIENT_BALANCE",
      error: `Insufficient balance: You have ${currentBalanceSol} SOL available, which is less than the ${amountSol} SOL requested.`,
    };
  }

  // 9. Check if sender has enough balance to cover amount + network fees
  if (currentBalanceLamports < totalDeductionLamports) {
    return {
      valid: false,
      code: "INSUFFICIENT_FUNDS_FOR_FEES",
      error: `Insufficient funds for network fee: You have ${currentBalanceSol} SOL. While you have enough for the ${amountSol} SOL transfer, you need ~${feeEstimate.totalFeeSol} SOL for the network transaction fee (Total required: ${totalDeductionSol} SOL).`,
    };
  }

  return {
    valid: true,
    amountLamports,
    feeEstimate,
    totalDeductionLamports,
    totalDeductionSol,
    currentBalanceLamports,
    currentBalanceSol,
  };
}
