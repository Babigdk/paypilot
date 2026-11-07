import { address } from "@solana/kit";
import {
  defaultPaymentParser,
  type PaymentIntentParser,
  type PaymentAction,
} from "./parser.ts";
import {
  validateAmountPrecision,
  estimateTransactionFee,
  BASE_TRANSACTION_FEE_LAMPORTS,
} from "./validation.ts";
import type { TransactionRecord } from "./storage";
import type { AppClient } from "./providers";

export type AssistantIntentType =
  | "payment_preview"
  | "missing_payment_info"
  | "invalid_payment"
  | "balance_inquiry"
  | "fee_inquiry"
  | "history_inquiry"
  | "help_inquiry"
  | "general_chat";

export interface PreparedPayment {
  amount: string;
  recipient: string;
  action?: PaymentAction;
  asset?: "SOL";
  network?: "Solana Devnet";
  estimatedFeeSol?: string;
  totalDeductionSol?: string;
}

export interface AssistantWalletContext {
  isWalletConnected: boolean;
  walletAddress?: string;
  solBalance?: string;
  balanceLoading?: boolean;
  balanceError?: boolean;
  transactions?: TransactionRecord[];
  client?: AppClient;
}

export interface AssistantResponse {
  id: string;
  sender: "assistant";
  text: string;
  intentType: AssistantIntentType;
  preparedPayment?: PreparedPayment;
  suggestions?: string[];
  timestamp: number;
  provider?: "gemini" | "local";
  isFallback?: boolean;
}

export interface ChatMessage {
  id: string;
  sender: "user" | "assistant";
  text: string;
  intentType?: AssistantIntentType;
  preparedPayment?: PreparedPayment;
  suggestions?: string[];
  timestamp: number;
  provider?: "gemini" | "local";
  isFallback?: boolean;
}

export interface AssistantService {
  processMessage(
    userMessage: string,
    context: AssistantWalletContext
  ): Promise<AssistantResponse>;
}

export function sanitizeSuggestions(
  suggestions: string[] | undefined,
  connectedWalletAddress?: string
): string[] {
  if (!suggestions) return [];
  const normalizedConnected = connectedWalletAddress?.toLowerCase();
  return suggestions.filter((s) => {
    if (!normalizedConnected) return true;
    return !s.toLowerCase().includes(normalizedConnected);
  });
}

function isAttemptedSolanaAddress(token: string): boolean {
  const clean = token.replace(/[.,;:!?)]+$/, "").toLowerCase();
  const commonWords = new Set([
    "sol",
    "solana",
    "make",
    "send",
    "transfer",
    "pay",
    "do",
    "get",
    "check",
    "view",
    "see",
    "this",
    "a",
    "an",
    "some",
    "my",
    "the",
    "me",
    "us",
    "another",
    "recipient",
    "wallet",
    "address",
  ]);
  if (commonWords.has(clean) || /^\d+(\.\d+)?$/.test(clean)) {
    return false;
  }
  return clean.length >= 6 || /[0-9]/.test(clean);
}

export function truncateAddress(addr?: string): string {
  if (!addr) return "";
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

/**
 * Local AI Payment Assistant implementation for PayPilot.
 * Designed modularly to allow future integration with server-side LLMs.
 */
export class LocalPaymentAssistant implements AssistantService {
  private parser: PaymentIntentParser;

  constructor(parser: PaymentIntentParser = defaultPaymentParser) {
    this.parser = parser;
  }

  async processMessage(
    userMessage: string,
    context: AssistantWalletContext
  ): Promise<AssistantResponse> {
    const res = await this.evaluateMessage(userMessage, context);
    return {
      ...res,
      suggestions: sanitizeSuggestions(res.suggestions, context.walletAddress),
    };
  }

  private async evaluateMessage(
    userMessage: string,
    context: AssistantWalletContext
  ): Promise<AssistantResponse> {
    const raw = userMessage ? userMessage.trim() : "";
    const id = `asst-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = Date.now();

    if (!raw) {
      return {
        id,
        sender: "assistant",
        text: "Please type a message, describe a payment, or ask a question about your wallet.",
        intentType: "general_chat",
        suggestions: [
          "What's my balance?",
          "What are transaction fees?",
          "How do I send SOL?",
        ],
        timestamp,
      };
    }

    // 1. Check for Balance Questions
    if (this.isBalanceQuestion(raw)) {
      return this.handleBalanceQuestion(id, timestamp, context);
    }

    // 2. Check for Transaction Fee Questions
    if (this.isFeeQuestion(raw)) {
      return this.handleFeeQuestion(id, timestamp, context);
    }

    // 3. Check for Transaction History Questions
    if (this.isHistoryQuestion(raw)) {
      return this.handleHistoryQuestion(id, timestamp, context);
    }

    // 4. Check for Help / How-To Questions
    if (this.isHelpQuestion(raw)) {
      return this.handleHelpQuestion(id, timestamp);
    }

    // 5. Check for Incomplete Payment Instructions (missing amount or recipient)
    const incompleteCheck = this.checkIncompletePayment(
      raw,
      context.walletAddress
    );
    if (incompleteCheck) {
      return {
        id,
        sender: "assistant",
        text: incompleteCheck.text,
        intentType: "missing_payment_info",
        suggestions: incompleteCheck.suggestions,
        timestamp,
      };
    }

    // 6. Attempt full payment intent parsing
    const isPaymentAttempt = this.looksLikePaymentAttempt(raw);
    if (isPaymentAttempt) {
      return await this.handlePaymentAttempt(id, timestamp, raw, context);
    }

    // 7. Check for Greetings
    if (this.isGreeting(raw)) {
      return {
        id,
        sender: "assistant",
        text: "Hello! I'm PayPilot, your AI payment assistant on Solana Devnet. How can I help you today? You can ask me to prepare a transfer, check your balance, or explain network fees.",
        intentType: "general_chat",
        suggestions: [
          "What's my balance?",
          "What are transaction fees?",
          "How do I send SOL?",
        ],
        timestamp,
      };
    }

    // 8. General conversational fallback
    return {
      id,
      sender: "assistant",
      text: "I can help you prepare SOL payments, check your wallet balance, explain network fees, or view your transaction history. How would you like to proceed?",
      intentType: "general_chat",
      suggestions: [
        "What's my balance?",
        "What are transaction fees?",
        "How do I send SOL?",
      ],
      timestamp,
    };
  }

  private isBalanceQuestion(text: string): boolean {
    return /\b(balance|how much (sol|money|funds)|check (my )?balance|what('?s| is) my balance|how many sol|my balance)\b/i.test(
      text
    );
  }

  private isFeeQuestion(text: string): boolean {
    // Check if the user is asking about fees as an inquiry, rather than asking to send a payment
    const feeInquiry =
      /\b(fee|fees|cost|network fee|transaction fee|prioritization fee|gas)\b/i.test(
        text
      );
    const sendCommand = /\b(send|transfer|pay|wire)\s+\d+/i.test(text);
    return feeInquiry && !sendCommand;
  }

  private isHistoryQuestion(text: string): boolean {
    return /\b(history|recent transactions?|past transactions?|previous payments?|transaction history|show (my )?transactions?|view transactions?|my transfers|recent payments?)\b/i.test(
      text
    );
  }

  private isHelpQuestion(text: string): boolean {
    return /\b(how (do|can) I (send|transfer|pay|use)|how to send|help|what can you do|how does (this|paypilot) work|guide)\b/i.test(
      text
    );
  }

  private isGreeting(text: string): boolean {
    return /^(hi|hello|hey|greetings|good (morning|afternoon|evening)|yo)\b/i.test(
      text.trim()
    );
  }

  private looksLikePaymentAttempt(text: string): boolean {
    return (
      /\b(send|transfer|pay|wire|forward|transmit)\b/i.test(text) ||
      /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(text) ||
      /\b\d+(\.\d+)?\s*(sol|solana)\b/i.test(text)
    );
  }

  private checkIncompletePayment(
    text: string,
    walletAddress?: string
  ): { text: string; suggestions?: string[] } | null {
    const hasAction = /\b(send|transfer|pay|wire|forward|payment)\b/i.test(text);
    if (!hasAction) return null;

    // Check if recipient address exists (base58 32-44 characters)
    const base58Candidates =
      text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];
    const hasRecipient = base58Candidates.length > 0;

    // If no valid base58 recipient was found, check if user attempted to supply an address
    // (e.g. after 'to', 'wallet:', etc.). If so, let full parser explain the invalid address.
    if (!hasRecipient) {
      const pseudoAddressMatch = text.match(
        /(?:to|wallet|address|recipient)\s*:?\s*([^\s,;]+)/i
      );
      if (pseudoAddressMatch) {
        const attempted = pseudoAddressMatch[1];
        if (isAttemptedSolanaAddress(attempted)) {
          return null;
        }
      }
    }

    // Check if a numerical amount exists
    const firstCandidate = base58Candidates[0];
    const textWithoutAddress = firstCandidate
      ? text.replace(firstCandidate, "")
      : text;
    const hasNumber = /\b\d+(\.\d+)?\b/.test(textWithoutAddress);

    // Scenario A: Missing both amount and recipient
    // e.g. "Send some SOL", "I want to make a payment", "Transfer SOL", "Send payment"
    if (!hasNumber && !hasRecipient) {
      return {
        text: "I can help you prepare a SOL transfer! However, your instruction is missing both the **amount** and the **recipient address**.\n\nPlease provide:\n• The amount of SOL to transfer (e.g. `0.5 SOL`)\n• The recipient's Solana address\n\n**Example:** *\"Send 0.5 SOL to 7t95nnQFzG3ASCBef9sc1KUxduLBvxngsx2kmRe4HZ8A\"*",
        suggestions: [
          "What are transaction fees?",
          "What's my balance?",
          "How do I send SOL?",
        ],
      };
    }

    // Scenario B: Has recipient address, but missing amount
    // e.g. "Transfer SOL to this address: 7t95..."
    if (firstCandidate && !hasNumber) {
      if (
        walletAddress &&
        firstCandidate.toLowerCase() === walletAddress.toLowerCase()
      ) {
        return {
          text: "You provided your own connected wallet address. You cannot send payments to yourself on Solana.\n\nPlease specify a different recipient address.",
          suggestions: [
            "What's my balance?",
            "What are transaction fees?",
            "How do I send SOL?",
          ],
        };
      }
      const recipientShort = truncateAddress(firstCandidate);
      return {
        text: `You provided the recipient address (\`${recipientShort}\`), but didn't specify an amount. How much SOL would you like to send?\n\n**Example:** *\"Send 0.5 SOL to ${firstCandidate}\"*`,
        suggestions: [
          `Send 0.1 SOL to ${firstCandidate}`,
          `Send 0.5 SOL to ${firstCandidate}`,
          `Send 1 SOL to ${firstCandidate}`,
        ],
      };
    }

    // Scenario C: Has amount, but missing recipient
    // e.g. "Send 0.5 SOL", "Transfer 1 sol", "Pay 0.25"
    if (hasNumber && !hasRecipient) {
      const amountMatch = textWithoutAddress.match(/\b\d+(\.\d+)?\b/);
      const amount = amountMatch ? amountMatch[0] : "";
      return {
        text: `You specified ${amount ? `**${amount} SOL**` : "an amount"}, but didn't provide a recipient wallet address. What Solana address would you like to send it to?\n\n**Example:** *\"Send ${amount || "0.5"} SOL to <recipient-address>\"*`,
        suggestions: [
          "What are transaction fees?",
          "What's my balance?",
          "How do I send SOL?",
        ],
      };
    }

    return null;
  }

  private handleBalanceQuestion(
    id: string,
    timestamp: number,
    context: AssistantWalletContext
  ): AssistantResponse {
    if (!context.isWalletConnected || !context.walletAddress) {
      return {
        id,
        sender: "assistant",
        text: "You don't have a wallet connected yet. Please connect your Phantom wallet using the overview button above to check your live Solana Devnet balance.",
        intentType: "balance_inquiry",
        suggestions: [
          "How do I send SOL?",
          "What are transaction fees?",
          "How does PayPilot work?",
        ],
        timestamp,
      };
    }

    if (context.balanceLoading) {
      return {
        id,
        sender: "assistant",
        text: `Your connected wallet (\`${truncateAddress(context.walletAddress)}\`) balance is currently loading from Solana Devnet. Please check back in a few seconds or click **Refresh balance**.`,
        intentType: "balance_inquiry",
        timestamp,
      };
    }

    if (context.balanceError) {
      return {
        id,
        sender: "assistant",
        text: `I couldn't retrieve the Devnet balance for wallet \`${truncateAddress(context.walletAddress)}\` right now. Devnet might be experiencing high latency. Try clicking **Refresh balance** above.`,
        intentType: "balance_inquiry",
        timestamp,
      };
    }

    if (context.solBalance !== undefined) {
      return {
        id,
        sender: "assistant",
        text: `Your connected wallet has an available balance of **${context.solBalance} SOL** on Solana Devnet.\n\nAddress: \`${context.walletAddress}\``,
        intentType: "balance_inquiry",
        suggestions: [
          "Show my recent transactions",
          "What are transaction fees?",
          "How do I send SOL?",
        ],
        timestamp,
      };
    }

    return {
      id,
      sender: "assistant",
      text: `Your wallet is connected (\`${truncateAddress(context.walletAddress)}\`), but balance information is not available at the moment.`,
      intentType: "balance_inquiry",
      timestamp,
    };
  }

  private async handleFeeQuestion(
    id: string,
    timestamp: number,
    context: AssistantWalletContext
  ): Promise<AssistantResponse> {
    let feeEstimateText = "~0.000005 SOL (5,000 lamports)";

    if (context.client) {
      try {
        const fee = await estimateTransactionFee(context.client);
        feeEstimateText = `~${fee.totalFeeSol} SOL (${fee.totalFeeLamports.toString()} lamports)`;
      } catch {
        // Fallback default
      }
    }

    return {
      id,
      sender: "assistant",
      text:
        `On Solana Devnet, every transaction requires a small network fee paid in SOL:\n\n` +
        `• **Base Signature Fee**: 5,000 lamports (0.000005 SOL) per transaction.\n` +
        `• **Prioritization Fee**: Optional micro-lamport fee during high network congestion (typically 0 on Devnet).\n` +
        `• **Current Estimated Fee**: ${feeEstimateText}.\n\n` +
        `PayPilot automatically calculates and displays network fees before you confirm any payment, ensuring your balance covers both the transfer and network fees.`,
      intentType: "fee_inquiry",
      suggestions: [
        "What's my balance?",
        "How do I send SOL?",
        "Show my recent transactions",
      ],
      timestamp,
    };
  }

  private handleHistoryQuestion(
    id: string,
    timestamp: number,
    context: AssistantWalletContext
  ): AssistantResponse {
    if (!context.isWalletConnected || !context.walletAddress) {
      return {
        id,
        sender: "assistant",
        text: "Please connect your Phantom wallet to view your persistent on-chain transaction history.",
        intentType: "history_inquiry",
        suggestions: ["How do I send SOL?", "What are transaction fees?"],
        timestamp,
      };
    }

    const txs = context.transactions || [];
    if (txs.length === 0) {
      return {
        id,
        sender: "assistant",
        text: `No recent transactions were found for your wallet (\`${truncateAddress(context.walletAddress)}\`) on Solana Devnet yet. Once you make or receive transfers, they will automatically appear here.`,
        intentType: "history_inquiry",
        suggestions: [
          "What's my balance?",
          "What are transaction fees?",
          "How do I send SOL?",
        ],
        timestamp,
      };
    }

    const topTxs = txs.slice(0, 3);
    const summaryList = topTxs
      .map((tx, idx) => {
        const direction = tx.direction === "incoming" ? "Received" : "Sent";
        const sign = tx.direction === "incoming" ? "+" : "-";
        const otherParty =
          tx.direction === "incoming"
            ? `from ${truncateAddress(tx.sender)}`
            : `to ${truncateAddress(tx.recipient)}`;
        return `${idx + 1}. **${direction}**: ${sign}${tx.amount} SOL ${otherParty} (${tx.status})`;
      })
      .join("\n");

    return {
      id,
      sender: "assistant",
      text:
        `Here are your latest transactions on Solana Devnet:\n\n` +
        `${summaryList}\n\n` +
        `You can see your full persistent transaction history and Solana Explorer links below in the Transaction History section.`,
      intentType: "history_inquiry",
      suggestions: [
        "What's my balance?",
        "What are transaction fees?",
        "How do I send SOL?",
      ],
      timestamp,
    };
  }

  private handleHelpQuestion(id: string, timestamp: number): AssistantResponse {
    return {
      id,
      sender: "assistant",
      text:
        `Here is how you can use PayPilot to make intelligent, secure payments:\n\n` +
        `1. **Connect Phantom**: Use the overview panel above to connect your Phantom wallet set to Solana Devnet.\n` +
        `2. **Describe Payments Naturally**: Type instructions like *\"Send 0.5 SOL to 7t95nnQFzG3ASCBef9sc1KUxduLBvxngsx2kmRe4HZ8A\"* or *\"Transfer 1 SOL to <address>\"*.\n` +
        `3. **Review Preview & Fees**: PayPilot validates the address, verifies your balance, and calculates network fees.\n` +
        `4. **Approve via Phantom**: Click **Confirm & Send SOL** to securely sign in Phantom. PayPilot never touches your private keys.\n\n` +
        `You can also ask me about your balance, network fees, or past transactions!`,
      intentType: "help_inquiry",
      suggestions: [
        "What's my balance?",
        "What are transaction fees?",
        "Show my recent transactions",
      ],
      timestamp,
    };
  }

  private async handlePaymentAttempt(
    id: string,
    timestamp: number,
    instruction: string,
    context: AssistantWalletContext
  ): Promise<AssistantResponse> {
    const parseResult = await this.parser.parse(
      instruction,
      context.walletAddress
    );

    if (!parseResult.success) {
      return {
        id,
        sender: "assistant",
        text: `⚠️ ${parseResult.error}`,
        intentType: "invalid_payment",
        suggestions: [
          "What are transaction fees?",
          "What's my balance?",
          "How do I send SOL?",
        ],
        timestamp,
      };
    }

    const { amount, recipient, action, asset, network } = parseResult.intent;

    // Validate precision and representability in lamports
    const precisionCheck = validateAmountPrecision(amount);
    if (!precisionCheck.valid || precisionCheck.amountLamports === undefined) {
      return {
        id,
        sender: "assistant",
        text: `⚠️ ${precisionCheck.error || "Invalid transfer amount."}`,
        intentType: "invalid_payment",
        timestamp,
      };
    }

    // Estimate network fee
    let feeSol = "0.000005";
    let totalDeductionSol = amount;

    if (context.client) {
      try {
        const feeEstimate = await estimateTransactionFee(context.client);
        feeSol = feeEstimate.totalFeeSol;
        const totalLamports =
          precisionCheck.amountLamports + feeEstimate.totalFeeLamports;
        totalDeductionSol = (Number(totalLamports) / 1_000_000_000).toFixed(6);
      } catch {
        const fallbackLamports =
          precisionCheck.amountLamports + BASE_TRANSACTION_FEE_LAMPORTS;
        totalDeductionSol = (Number(fallbackLamports) / 1_000_000_000).toFixed(6);
      }
    } else {
      const fallbackLamports =
        precisionCheck.amountLamports + BASE_TRANSACTION_FEE_LAMPORTS;
      totalDeductionSol = (Number(fallbackLamports) / 1_000_000_000).toFixed(6);
    }

    const preparedPayment: PreparedPayment = {
      amount,
      recipient,
      action,
      asset,
      network: network || "Solana Devnet",
      estimatedFeeSol: feeSol,
      totalDeductionSol,
    };

    return {
      id,
      sender: "assistant",
      text:
        `I've prepared your transfer of **${amount} SOL** to \`${recipient}\` on Solana Devnet.\n\n` +
        `• Estimated Network Fee: ~${feeSol} SOL\n` +
        `• Total Estimated Deduction: ~${totalDeductionSol} SOL\n\n` +
        `Please review the payment preview card below and click **Confirm & Send SOL** to approve the transaction in Phantom.`,
      intentType: "payment_preview",
      preparedPayment,
      timestamp,
      provider: "local",
      isFallback: false,
    };
  }
}

/**
 * Hybrid Assistant Service integrating Google Gemini with automatic local fallback.
 */
export class GeminiAssistantService implements AssistantService {
  private localFallback: AssistantService;
  private apiEndpoint: string;
  private timeoutMs: number;

  constructor(
    localFallback: AssistantService = new LocalPaymentAssistant(),
    apiEndpoint = "/api/chat",
    timeoutMs = 12000
  ) {
    this.localFallback = localFallback;
    this.apiEndpoint = apiEndpoint;
    this.timeoutMs = timeoutMs;
  }

  async processMessage(
    userMessage: string,
    context: AssistantWalletContext
  ): Promise<AssistantResponse> {
    try {
      const recentSummary = (context.transactions || []).slice(0, 3).map((tx) => ({
        direction: tx.direction,
        amount: tx.amount,
        sender: tx.sender,
        recipient: tx.recipient,
        status: tx.status,
      }));

      const controller =
        typeof AbortController !== "undefined" ? new AbortController() : null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (controller) {
        timer = setTimeout(() => controller.abort(), this.timeoutMs);
      }

      let endpoint = this.apiEndpoint;
      if (typeof window === "undefined" && endpoint.startsWith("/")) {
        const host = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000";
        endpoint = `${host}${endpoint}`;
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          context: {
            walletAddress: context.walletAddress,
            solBalance: context.solBalance,
            recentTransactions: recentSummary,
          },
        }),
        signal: controller ? controller.signal : undefined,
      });

      if (timer) clearTimeout(timer);

      if (!res.ok) {
        // Fall back gracefully to local assistant
        const localResponse = await this.localFallback.processMessage(
          userMessage,
          context
        );
        return {
          ...localResponse,
          provider: "local",
          isFallback: true,
        };
      }

      const data = await res.json();
      if (!data || typeof data.text !== "string") {
        throw new Error("Invalid response format from Gemini API endpoint.");
      }

      let preparedPayment: PreparedPayment | undefined = undefined;
      let intentType: AssistantIntentType =
        (data.intentType as AssistantIntentType) || "general_chat";
      let responseText = data.text;

      // STRICT INDEPENDENT TRANSACTION VALIDATION:
      // Never trust AI-generated recipient addresses or amounts without independent validation!
      if (data.paymentIntent && typeof data.paymentIntent === "object") {
        const { amount, recipient, action, asset } = data.paymentIntent;

        if (asset && asset.toUpperCase() !== "SOL") {
          intentType = "invalid_payment";
          responseText = `⚠️ Unsupported asset: PayPilot only supports SOL transfers on Solana Devnet. Currency '${asset}' is not supported.`;
        } else {
          // 1. Validate amount precision
          const precisionCheck = validateAmountPrecision(amount || "");
          let isValidAddress = false;
          try {
            if (recipient) {
              address(recipient);
              isValidAddress = true;
            }
          } catch {
            isValidAddress = false;
          }

          const isSelfTransfer = Boolean(
            context.walletAddress && recipient === context.walletAddress
          );

          if (!precisionCheck.valid || !isValidAddress || isSelfTransfer) {
            intentType = "invalid_payment";
            if (!precisionCheck.valid) {
              responseText = `⚠️ ${precisionCheck.error || "Invalid transfer amount."}`;
            } else if (!isValidAddress) {
              responseText = `⚠️ The recipient address '${recipient}' is not a valid Solana address.`;
            } else if (isSelfTransfer) {
              responseText =
                "⚠️ You cannot send a payment to your own connected wallet address.";
            }
          } else if (precisionCheck.amountLamports !== undefined) {
            // Calculate fees independently
            let feeSol = "0.000005";
            let totalDeductionSol = amount;

            if (context.client) {
              try {
                const feeEstimate = await estimateTransactionFee(
                  context.client
                );
                feeSol = feeEstimate.totalFeeSol;
                const totalLamports =
                  precisionCheck.amountLamports + feeEstimate.totalFeeLamports;
                totalDeductionSol = (
                  Number(totalLamports) / 1_000_000_000
                ).toFixed(6);
              } catch {
                const fallbackLamports =
                  precisionCheck.amountLamports + BASE_TRANSACTION_FEE_LAMPORTS;
                totalDeductionSol = (
                  Number(fallbackLamports) / 1_000_000_000
                ).toFixed(6);
              }
            } else {
              const fallbackLamports =
                precisionCheck.amountLamports + BASE_TRANSACTION_FEE_LAMPORTS;
              totalDeductionSol = (
                Number(fallbackLamports) / 1_000_000_000
              ).toFixed(6);
            }

            preparedPayment = {
              amount,
              recipient,
              action: action || "send",
              asset: "SOL",
              network: "Solana Devnet",
              estimatedFeeSol: feeSol,
              totalDeductionSol,
            };
            intentType = "payment_preview";
          }
        }
      }

      return {
        id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        sender: "assistant",
        text: responseText,
        intentType,
        preparedPayment,
        suggestions: sanitizeSuggestions(
          Array.isArray(data.suggestions)
            ? data.suggestions
            : [
                "What's my balance?",
                "What are transaction fees?",
                "How do I send SOL?",
              ],
          context.walletAddress
        ),
        timestamp: Date.now(),
        provider: "gemini",
        isFallback: false,
      };
    } catch {
      // Graceful fallback to local assistant whenever server API is unavailable
      const fallbackResponse = await this.localFallback.processMessage(
        userMessage,
        context
      );
      return {
        ...fallbackResponse,
        provider: "local",
        isFallback: true,
      };
    }
  }
}

export const defaultPaymentAssistant = new GeminiAssistantService();
