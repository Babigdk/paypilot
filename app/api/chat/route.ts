import { NextRequest, NextResponse } from "next/server.js";
import { GoogleGenAI } from "@google/genai";

// In-memory rate limiting state
interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 20;
const MAX_PAYLOAD_BYTES = 10 * 1024; // 10KB
const GEMINI_REQUEST_TIMEOUT_MS = 10000; // 10 seconds

// Safe server-side diagnostic logging (never logs API keys, headers, or sensitive user data)
function logDiagnostic(
  event: string,
  details: {
    status?: number;
    category?: string;
    durationMs?: number;
    model?: string;
  }
) {
  const timestamp = new Date().toISOString();
  console.info(
    `[PayPilot-AI-Diagnostic] [${timestamp}] event=${event} status=${details.status ?? 200} category=${details.category ?? "success"} model=${details.model ?? "default"} duration=${details.durationMs ?? 0}ms`
  );
}

function sanitizeErrorCategory(err: unknown): {
  status: number;
  category: string;
} {
  if (err instanceof Error && err.message === "GEMINI_REQUEST_TIMEOUT") {
    return { status: 504, category: "timeout" };
  }
  const status = (err as { status?: number })?.status;
  if (status === 401 || status === 403) {
    return { status, category: "auth_error" };
  }
  if (status === 404) {
    return { status, category: "model_not_found" };
  }
  if (status === 429) {
    return { status, category: "quota_exceeded" };
  }
  if (status === 503) {
    return { status, category: "upstream_unavailable" };
  }
  return { status: status || 502, category: "network_error" };
}

export function checkRateLimit(ip: string): {
  allowed: boolean;
  retryAfter?: number;
} {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (record.count >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  record.count += 1;
  return { allowed: true };
}

export function resetRateLimits(): void {
  rateLimitMap.clear();
}

export async function POST(req: NextRequest) {
  // 1. Restrict Request Payload Size (max 10KB)
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      {
        error: "Request payload too large (maximum 10KB allowed).",
        fallbackToLocal: true,
      },
      { status: 413 }
    );
  }

  // 2. Rate Limiting Protection (max 20 requests/minute per client IP)
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "127.0.0.1";

  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    logDiagnostic("rate_limit_exceeded", {
      status: 429,
      category: "rate_limited",
    });
    return NextResponse.json(
      {
        error: `Rate limit exceeded. Please wait ${rateCheck.retryAfter || 60} seconds before sending another message.`,
        fallbackToLocal: true,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateCheck.retryAfter || 60),
        },
      }
    );
  }

  // 3. Verify Server-side Gemini API Key
  const apiKey = process.env.GEMINI_API_KEY;
  if (
    !apiKey ||
    apiKey.trim() === "" ||
    apiKey === "your_gemini_api_key_here"
  ) {
    logDiagnostic("api_key_unconfigured", {
      status: 503,
      category: "auth_error",
    });
    return NextResponse.json(
      {
        error: "AI service is temporarily unconfigured or unavailable.",
        fallbackToLocal: true,
      },
      { status: 503 }
    );
  }

  // 4. Validate Request Body
  let body: {
    message?: string;
    context?: {
      walletAddress?: string;
      solBalance?: string;
      recentTransactions?: Array<{
        direction?: string;
        amount?: string;
        sender?: string;
        recipient?: string;
        status?: string;
      }>;
    };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body.", fallbackToLocal: true },
      { status: 400 }
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json(
      { error: "Message is required.", fallbackToLocal: true },
      { status: 400 }
    );
  }

  if (message.length > 1000) {
    return NextResponse.json(
      {
        error: "Message is too long (maximum 1,000 characters).",
        fallbackToLocal: true,
      },
      { status: 400 }
    );
  }

  // 5. Security Guard: Prevent sharing of credentials or private keys
  if (
    /\b(private\s*key|recovery\s*phrase|seed\s*phrase|mnemonic|secret\s*key)\b/i.test(
      message
    )
  ) {
    return NextResponse.json({
      text: "🔒 **Security Notice**: PayPilot never asks for your private keys, recovery phrase, or seed words. Please never share them with anyone or input them into chat.",
      intentType: "general_chat",
      paymentIntent: null,
      suggestions: [
        "What's my balance?",
        "How do I send SOL?",
        "What are transaction fees?",
      ],
    });
  }

  // 6. Invoke Google Gen AI SDK
  const ai = new GoogleGenAI({ apiKey });

  const systemInstruction = `You are PayPilot's AI assistant, an intelligent payments and blockchain assistant for Solana Devnet.
You help users describe SOL transfers, understand wallet balances, explain network fees, and interpret wallet activity.

Current user context:
- Connected Wallet: ${body.context?.walletAddress || "Not connected"}
- Available Balance: ${body.context?.solBalance ? `${body.context.solBalance} SOL` : "Unknown / Not connected"}
- Network: Solana Devnet
- Recent Transactions: ${JSON.stringify(body.context?.recentTransactions || [])}

Strict Security & Operational Rules:
1. You can NEVER access private keys, sign transactions, or execute payments. You are purely an interpreter and explainer.
2. Answer user questions about Solana Devnet, balances, network fees (base 5,000 lamports / 0.000005 SOL), transaction confirmation status ("confirmed" = supermajority votes, "finalized" = 31+ confirmed blocks, irreversible), and wallet activity.
3. When a user wants to send or transfer SOL:
   - If BOTH a valid amount (positive number) and recipient (Solana base58 address) are present:
     Set intentType to "payment_preview" and extract paymentIntent: { "action": "send" | "transfer" | "pay", "amount": "<amount as string>", "asset": "SOL", "recipient": "<base58 address>", "network": "Solana Devnet" }.
   - If the instruction is INCOMPLETE (missing amount, missing recipient, or both):
     Set intentType to "missing_payment_info", explain exactly what is missing, and ask a clarification question. NEVER guess or invent amounts or addresses!
   - If the instruction specifies an unsupported asset (e.g. USDC, ETH, BTC) or self-transfer:
     Set intentType to "invalid_payment" and explain why it's not supported.
   - NEVER suggest a payment instruction or quick-prompt using the connected wallet's own address as a recipient.
4. Output must be strictly valid JSON conforming to the following structure:
{
  "text": "<Markdown response to display to the user>",
  "intentType": "payment_preview" | "missing_payment_info" | "invalid_payment" | "balance_inquiry" | "fee_inquiry" | "history_inquiry" | "help_inquiry" | "general_chat",
  "paymentIntent": {
    "action": "send" | "transfer" | "pay",
    "amount": "0.5",
    "asset": "SOL",
    "recipient": "<base58 address>",
    "network": "Solana Devnet"
  } | null,
  "suggestions": ["<suggestion 1>", "<suggestion 2>", "<suggestion 3>"]
}`;

  const startTime = Date.now();
  const primaryModel = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  let usedModel = primaryModel;

  try {
    const createTimeout = (ms: number) =>
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("GEMINI_REQUEST_TIMEOUT")), ms);
      });

    let result: { text?: string } | null = null;
    try {
      result = await Promise.race([
        ai.models.generateContent({
          model: primaryModel,
          contents: message,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            temperature: 0.2,
          },
        }),
        createTimeout(GEMINI_REQUEST_TIMEOUT_MS),
      ]);
    } catch (primaryErr) {
      const errInfo = sanitizeErrorCategory(primaryErr);
      logDiagnostic("primary_model_failed", {
        status: errInfo.status,
        category: errInfo.category,
        model: primaryModel,
        durationMs: Date.now() - startTime,
      });

      // If the primary model encounters 404 (unavailable) or 503 (demand spike), retry with secondary candidate
      if (errInfo.status === 404 || errInfo.status === 503) {
        usedModel = "gemini-3.1-flash-lite";
        result = await Promise.race([
          ai.models.generateContent({
            model: usedModel,
            contents: message,
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              temperature: 0.2,
            },
          }),
          createTimeout(GEMINI_REQUEST_TIMEOUT_MS),
        ]);
      } else {
        throw primaryErr;
      }
    }

    if (!result) {
      throw new Error("No response from AI model");
    }

    const rawText = result.text || "";
    const cleanedText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed: {
      text?: string;
      intentType?: string;
      paymentIntent?: {
        action?: string;
        amount?: string;
        asset?: string;
        recipient?: string;
        network?: string;
      } | null;
      suggestions?: string[];
    };

    try {
      parsed = JSON.parse(cleanedText);
    } catch {
      logDiagnostic("response_parse_failed", {
        status: 502,
        category: "parse_error",
        model: usedModel,
        durationMs: Date.now() - startTime,
      });
      return NextResponse.json(
        {
          error: "Failed to parse structured response from Gemini.",
          fallbackToLocal: true,
        },
        { status: 502 }
      );
    }

    if (!parsed || typeof parsed.text !== "string") {
      logDiagnostic("response_invalid_structure", {
        status: 502,
        category: "parse_error",
        model: usedModel,
        durationMs: Date.now() - startTime,
      });
      return NextResponse.json(
        {
          error: "Invalid AI response structure.",
          fallbackToLocal: true,
        },
        { status: 502 }
      );
    }

    logDiagnostic("gemini_call_success", {
      status: 200,
      category: "success",
      model: usedModel,
      durationMs: Date.now() - startTime,
    });

    const rawSuggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
      : [];
    const connectedWallet = body.context?.walletAddress?.toLowerCase();
    const safeSuggestions = rawSuggestions.filter(
      (s) =>
        typeof s === "string" &&
        (!connectedWallet || !s.toLowerCase().includes(connectedWallet))
    );

    return NextResponse.json({
      text: parsed.text,
      intentType: parsed.intentType || "general_chat",
      paymentIntent: parsed.paymentIntent || null,
      suggestions: safeSuggestions,
    });
  } catch (err: unknown) {
    const errInfo = sanitizeErrorCategory(err);
    logDiagnostic("gemini_call_failed", {
      status: errInfo.status,
      category: errInfo.category,
      model: usedModel,
      durationMs: Date.now() - startTime,
    });
    return NextResponse.json(
      {
        error:
          errInfo.category === "timeout"
            ? "AI request timed out."
            : "An error occurred while contacting the AI service.",
        fallbackToLocal: true,
      },
      { status: errInfo.status }
    );
  }
}
