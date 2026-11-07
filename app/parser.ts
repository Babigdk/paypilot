import { address } from "@solana/kit";

export type PaymentAction = "send" | "transfer" | "pay";

export type ParsedPaymentIntent = {
  action: PaymentAction;
  amount: string;
  asset: "SOL";
  recipient: string;
  network: "Solana Devnet";
  rawInstruction: string;
};

export type ParseSuccess = {
  success: true;
  intent: ParsedPaymentIntent;
};

export type ParseError = {
  success: false;
  error: string;
  field?: "action" | "amount" | "asset" | "recipient" | "syntax";
};

export type ParseResult = ParseSuccess | ParseError;

export interface PaymentIntentParser {
  parse(
    instruction: string,
    senderAddress?: string
  ): Promise<ParseResult> | ParseResult;
}

const COMMON_UNSUPPORTED_ASSETS = [
  "USDC",
  "USDT",
  "ETH",
  "BTC",
  "BONK",
  "RAY",
  "JUP",
  "USD",
  "EUR",
  "DAI",
  "WBTC",
  "WETH",
];

/**
 * Natural language parser for extracting payment intents from user instructions.
 */
export class NaturalLanguagePaymentParser implements PaymentIntentParser {
  parse(instruction: string, senderAddress?: string): ParseResult {
    const raw = instruction ? instruction.trim() : "";
    if (!raw) {
      return {
        success: false,
        error: "Please enter a payment instruction (e.g., 'Send 0.5 SOL to <address>').",
        field: "syntax",
      };
    }

    // 1. Detect unsupported assets (e.g. USDC, BTC, ETH)
    for (const unsupported of COMMON_UNSUPPORTED_ASSETS) {
      const regex = new RegExp(`\\b${unsupported}\\b`, "i");
      if (regex.test(raw)) {
        return {
          success: false,
          error: `Unsupported asset: PayPilot only supports SOL transfers on Solana Devnet. Currency '${unsupported}' is not supported.`,
          field: "asset",
        };
      }
    }

    // 2. Identify payment action
    const actionMatch = raw.match(/\b(send|transfer|pay)\b/i);
    let action: PaymentAction = "send";
    if (actionMatch) {
      const matched = actionMatch[1].toLowerCase();
      if (matched === "transfer" || matched === "pay" || matched === "send") {
        action = matched as PaymentAction;
      }
    } else {
      // Check for conversational variations like "wire", "forward"
      const altMatch = raw.match(/\b(wire|forward|transmit|give)\b/i);
      if (altMatch) {
        action = "send";
      } else {
        return {
          success: false,
          error:
            "Could not determine payment action. Please specify an action like 'send', 'transfer', or 'pay'.",
          field: "action",
        };
      }
    }

    // 3. Extract recipient address
    // Solana addresses are base58 strings between 32 and 44 characters (excluding 0, O, I, l)
    const base58Candidates = raw.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];

    if (base58Candidates.length === 0) {
      // Check if user attempted to provide an invalid address
      const pseudoAddressMatch = raw.match(
        /(?:to|wallet|address|recipient)\s*:?\s*([^\s,;]+)/i
      );
      if (pseudoAddressMatch) {
        const attempted = pseudoAddressMatch[1].replace(/[.,;:!?)]+$/, "");
        if (
          attempted.toLowerCase() !== "sol" &&
          attempted.toLowerCase() !== "solana" &&
          !/^\d+(\.\d+)?$/.test(attempted)
        ) {
          return {
            success: false,
            error: `The recipient address '${attempted}' is not a valid Solana address.`,
            field: "recipient",
          };
        }
      }

      return {
        success: false,
        error:
          "Missing recipient address. Please include a valid Solana recipient address in your instruction.",
        field: "recipient",
      };
    }

    // Validate the candidate addresses with Solana Kit's address helper
    let validRecipient: string | null = null;
    let candidateError: string | null = null;

    // Prioritize candidate located after "to", "wallet:", "address:", etc.
    const toMatch = raw.match(
      /(?:to|wallet|address|recipient)\s*:?\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i
    );
    const preferredCandidate =
      toMatch && toMatch[1] ? toMatch[1] : base58Candidates[0];

    if (preferredCandidate) {
      try {
        address(preferredCandidate);
        validRecipient = preferredCandidate;
      } catch {
        candidateError = `The recipient address '${preferredCandidate}' is not a valid Solana address.`;
      }
    }

    if (!validRecipient) {
      for (const candidate of base58Candidates) {
        try {
          address(candidate);
          validRecipient = candidate;
          candidateError = null;
          break;
        } catch {
          candidateError = `The recipient address '${candidate}' is not a valid Solana address.`;
        }
      }
    }

    if (!validRecipient) {
      return {
        success: false,
        error:
          candidateError ||
          "The recipient address provided is not a valid Solana address.",
        field: "recipient",
      };
    }

    // Validate recipient is not the connected wallet
    if (senderAddress && validRecipient === senderAddress) {
      return {
        success: false,
        error: "You cannot send a payment to your own connected wallet.",
        field: "recipient",
      };
    }

    // 4. Extract amount
    // Remove the valid recipient address from the string to avoid number collisions inside addresses
    const textWithoutAddress = raw.replace(validRecipient, "");

    // Look for numbers explicitly followed or preceded by SOL/sol/solana or standalone
    let amountCandidate: string | null = null;

    // A: Look for number right before or after SOL/solana
    const solNumberMatch = textWithoutAddress.match(
      /([0-9]*\.?[0-9]+)\s*(?:sol|solana)\b/i
    );
    if (solNumberMatch && solNumberMatch[1]) {
      amountCandidate = solNumberMatch[1];
    } else {
      // B: Look for number after "amount" or "amount of"
      const amountKeywordMatch = textWithoutAddress.match(
        /(?:amount|value)(?:\s+of)?\s*:?\s*([0-9]*\.?[0-9]+)/i
      );
      if (amountKeywordMatch && amountKeywordMatch[1]) {
        amountCandidate = amountKeywordMatch[1];
      } else {
        // C: Look for any standalone numeric token
        const generalNumberMatch = textWithoutAddress.match(
          /\b([0-9]+\.?[0-9]*|\.[0-9]+)\b/
        );
        if (generalNumberMatch && generalNumberMatch[1]) {
          amountCandidate = generalNumberMatch[1];
        }
      }
    }

    if (!amountCandidate || amountCandidate === ".") {
      return {
        success: false,
        error:
          "Missing payment amount. Please specify how much SOL to send (e.g., '0.5 SOL').",
        field: "amount",
      };
    }

    // Normalize leading dot (e.g. ".5" -> "0.5")
    if (amountCandidate.startsWith(".")) {
      amountCandidate = `0${amountCandidate}`;
    }
    // Remove trailing dot if any (e.g. "1." -> "1")
    if (amountCandidate.endsWith(".")) {
      amountCandidate = amountCandidate.slice(0, -1);
    }

    // Validate decimal format
    if (!/^\d+(\.\d+)?$/.test(amountCandidate)) {
      return {
        success: false,
        error: "Invalid amount format. Please enter a valid decimal number.",
        field: "amount",
      };
    }

    const [whole, fraction = ""] = amountCandidate.split(".");

    // Validate precision (at most 9 decimal places for Solana lamports)
    if (fraction.length > 9) {
      return {
        success: false,
        error:
          "Amount exceeds Solana's precision limit of 9 decimal places (1 lamport = 0.000000001 SOL).",
        field: "amount",
      };
    }

    const amountLamports =
      BigInt(whole) * BigInt(1_000_000_000) +
      BigInt(fraction.padEnd(9, "0"));

    if (amountLamports <= BigInt(0)) {
      return {
        success: false,
        error: "Payment amount must be greater than zero.",
        field: "amount",
      };
    }

    return {
      success: true,
      intent: {
        action,
        amount: amountCandidate,
        asset: "SOL",
        recipient: validRecipient,
        network: "Solana Devnet",
        rawInstruction: raw,
      },
    };
  }
}

export const defaultPaymentParser = new NaturalLanguagePaymentParser();
