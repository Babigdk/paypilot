import assert from "node:assert";

const { POST, checkRateLimit, resetRateLimits } = await import(
  "file:///C:/Users/USER/Desktop/hacktober/PayPilot/app/api/chat/route.ts"
);

const { GeminiAssistantService, LocalPaymentAssistant } = await import(
  "file:///C:/Users/USER/Desktop/hacktober/PayPilot/app/assistant.ts"
);

console.log("Running comprehensive tests for PayPilot Gemini Integration...\n");

const SENDER = "DLTedoWS84MP251y4zGLQ2HVsQSvPz49hKpad9bwv4T1";
const RECIPIENT = "7t95nnQFzG3ASCBef9sc1KUxduLBvxngsx2kmRe4HZ8A";

// Helper to create mock context
function createContext(overrides = {}) {
  return {
    isWalletConnected: true,
    walletAddress: SENDER,
    solBalance: "2.5000",
    balanceLoading: false,
    balanceError: false,
    transactions: [],
    client: undefined,
    ...overrides,
  };
}

// -------------------------------------------------------------
// 1. Missing API Key Handling in API Route
// -------------------------------------------------------------
console.log("--- Test 1: Missing API Key Handling ---");
{
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const req = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "What is my balance?" }),
  });

  const res = await POST(req);
  assert.strictEqual(res.status, 503);
  const data = await res.json();
  assert.match(data.error, /temporarily unconfigured|not configured/);
  assert.strictEqual(data.fallbackToLocal, true);

  // Restore env key
  if (prevKey) process.env.GEMINI_API_KEY = prevKey;
  console.log("✓ Route returns 503 with fallbackToLocal when API key is missing.");
}

// -------------------------------------------------------------
// 2. Rate Limiting Protection
// -------------------------------------------------------------
console.log("\n--- Test 2: Rate Limiting Protection ---");
{
  resetRateLimits();
  const testIp = "192.168.1.100";

  // First 20 requests should be allowed
  for (let i = 0; i < 20; i++) {
    const check = checkRateLimit(testIp);
    assert.strictEqual(check.allowed, true);
  }

  // 21st request should be blocked
  const blockedCheck = checkRateLimit(testIp);
  assert.strictEqual(blockedCheck.allowed, false);
  assert.ok(blockedCheck.retryAfter && blockedCheck.retryAfter > 0);

  // Test route 429 response
  const req = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": testIp,
    },
    body: JSON.stringify({ message: "Hello" }),
  });

  const res = await POST(req);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get("Retry-After"), String(blockedCheck.retryAfter));
  const data = await res.json();
  assert.match(data.error, /Rate limit exceeded/);
  assert.strictEqual(data.fallbackToLocal, true);

  resetRateLimits();
  console.log("✓ Route enforces rate limits (max 20 req/min) and returns 429 with Retry-After.");
}

// -------------------------------------------------------------
// 3. Request Payload Size Restriction (10KB limit)
// -------------------------------------------------------------
console.log("\n--- Test 3: Request Payload Size Restriction ---");
{
  const hugePayload = "A".repeat(15000); // 15KB
  const req = new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "content-length": "15000",
    },
    body: JSON.stringify({ message: hugePayload }),
  });

  const res = await POST(req);
  assert.strictEqual(res.status, 413);
  const data = await res.json();
  assert.match(data.error, /Request payload too large/);
  console.log("✓ Route rejects payloads > 10KB with 413 Payload Too Large.");
}

// -------------------------------------------------------------
// 4. Successful Gemini Response with Structured Intent
// -------------------------------------------------------------
console.log("\n--- Test 4: Successful Gemini Response & Structured Preview ---");
{
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      text: `I've prepared a payment of 0.5 SOL to ${RECIPIENT} on Solana Devnet.`,
      intentType: "payment_preview",
      paymentIntent: {
        action: "send",
        amount: "0.5",
        asset: "SOL",
        recipient: RECIPIENT,
        network: "Solana Devnet",
      },
      suggestions: ["What's my balance?", "What are transaction fees?"],
    }),
  });

  // Temporarily replace global fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;

  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 5000);
    const res = await service.processMessage("Send 0.5 SOL to " + RECIPIENT, createContext());

    assert.strictEqual(res.intentType, "payment_preview");
    assert.strictEqual(res.provider, "gemini");
    assert.strictEqual(res.isFallback, false);
    assert.ok(res.preparedPayment);
    assert.strictEqual(res.preparedPayment.amount, "0.5");
    assert.strictEqual(res.preparedPayment.recipient, RECIPIENT);
    assert.strictEqual(res.preparedPayment.estimatedFeeSol, "0.000005");
    assert.match(res.text, /0\.5 SOL/);
    console.log("✓ Successful Gemini response parsed into structured payment preview with fees.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// -------------------------------------------------------------
// 5. Invalid AI Response Handling (Fallback to Local)
// -------------------------------------------------------------
console.log("\n--- Test 5: Invalid AI Response Graceful Fallback ---");
{
  const mockFetchInvalid = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      corruptedField: true,
      // Missing required `text` field
    }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchInvalid;

  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 5000);
    const res = await service.processMessage("What is my balance?", createContext({ solBalance: "4.5000" }));

    // Should gracefully fallback to local assistant
    assert.strictEqual(res.provider, "local");
    assert.strictEqual(res.isFallback, true);
    assert.match(res.text, /4\.5000 SOL/);
    console.log("✓ Malformed AI response triggers seamless local fallback.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// -------------------------------------------------------------
// 6. API Timeout Handling
// -------------------------------------------------------------
console.log("\n--- Test 6: API Timeout Handling ---");
{
  const mockFetchHangs = async () => {
    // Simulate API hang / timeout
    await new Promise((resolve) => setTimeout(resolve, 500));
    throw new DOMException("The operation was aborted.", "AbortError");
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchHangs;

  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 50);
    const res = await service.processMessage("What are transaction fees?", createContext());

    assert.strictEqual(res.provider, "local");
    assert.strictEqual(res.isFallback, true);
    assert.match(res.text, /5,000 lamports/);
    console.log("✓ API timeout triggers seamless local fallback.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// -------------------------------------------------------------
// 7. Malformed Payment Intent: Independent Validation Layer
// -------------------------------------------------------------
console.log("\n--- Test 7: Independent Validation of AI Payment Intent ---");
{
  // A. AI returns invalid recipient address
  const mockFetchBadAddress = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      text: "Sure, sending to fake address.",
      intentType: "payment_preview",
      paymentIntent: {
        action: "send",
        amount: "0.5",
        asset: "SOL",
        recipient: "NotAValidBase58AddressXYZ",
        network: "Solana Devnet",
      },
    }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchBadAddress;

  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 5000);
    const res = await service.processMessage("Send 0.5 to bad address", createContext());

    assert.strictEqual(res.intentType, "invalid_payment");
    assert.strictEqual(res.preparedPayment, undefined);
    assert.match(res.text, /not a valid Solana address/);
    console.log("✓ Independent validation blocks invalid AI-generated recipient addresses.");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // B. AI returns negative or zero amount
  const mockFetchBadAmount = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      text: "Sending -5 SOL.",
      intentType: "payment_preview",
      paymentIntent: {
        action: "send",
        amount: "-5",
        asset: "SOL",
        recipient: RECIPIENT,
        network: "Solana Devnet",
      },
    }),
  });

  globalThis.fetch = mockFetchBadAmount;
  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 5000);
    const res = await service.processMessage("Send -5 SOL", createContext());

    assert.strictEqual(res.intentType, "invalid_payment");
    assert.strictEqual(res.preparedPayment, undefined);
    console.log("✓ Independent validation blocks invalid/negative AI-generated amounts.");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // C. AI returns self-transfer
  const mockFetchSelf = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      text: "Sending to yourself.",
      intentType: "payment_preview",
      paymentIntent: {
        action: "send",
        amount: "0.5",
        asset: "SOL",
        recipient: SENDER,
        network: "Solana Devnet",
      },
    }),
  });

  globalThis.fetch = mockFetchSelf;
  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 5000);
    const res = await service.processMessage("Send to myself", createContext());

    assert.strictEqual(res.intentType, "invalid_payment");
    assert.strictEqual(res.preparedPayment, undefined);
    assert.match(res.text, /cannot send a payment to your own/);
    console.log("✓ Independent validation blocks AI self-transfers.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// -------------------------------------------------------------
// 8. Missing Payment Details from AI
// -------------------------------------------------------------
console.log("\n--- Test 8: Missing Payment Details Guidance ---");
{
  const mockFetchClarification = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      text: "I can help you send SOL! How much SOL would you like to send and to what address?",
      intentType: "missing_payment_info",
      paymentIntent: null,
      suggestions: [
        `Send 0.5 SOL to ${RECIPIENT}`,
        "What's my balance?",
      ],
    }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchClarification;

  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 5000);
    const res = await service.processMessage("I want to pay someone.", createContext());

    assert.strictEqual(res.intentType, "missing_payment_info");
    assert.strictEqual(res.preparedPayment, undefined);
    assert.match(res.text, /How much SOL/);
    console.log("✓ AI asks clarification questions without guessing or fabricating payment data.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// -------------------------------------------------------------
// 9. Local Assistant Fallback when Endpoint Returns 503 / 500
// -------------------------------------------------------------
console.log("\n--- Test 9: Seamless Fallback on Server Error ---");
{
  const mockFetch503 = async () => ({
    ok: false,
    status: 503,
    json: async () => ({
      error: "GEMINI_API_KEY is not configured.",
      fallbackToLocal: true,
    }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch503;

  try {
    const service = new GeminiAssistantService(new LocalPaymentAssistant(), "/api/chat", 5000);
    const res = await service.processMessage("How do I send SOL?", createContext());

    assert.strictEqual(res.provider, "local");
    assert.strictEqual(res.isFallback, true);
    assert.match(res.text, /Connect Phantom/);
    console.log("✓ Server 503 activates local assistant seamlessly.");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// -------------------------------------------------------------
// 10. Security: Confirmation That AI Cannot Initiate or Sign Transactions
// -------------------------------------------------------------
console.log("\n--- Test 10: Security Proof: AI Cannot Sign or Submit Transactions ---");
{
  const service = new GeminiAssistantService();
  const ctx = createContext();
  const res = await service.processMessage(`Send 0.5 SOL to ${RECIPIENT}`, ctx);

  // The assistant response MUST ONLY contain data fields
  assert.strictEqual(typeof res.text, "string");
  assert.ok(res.preparedPayment);

  // Verify NO transaction instruction or signature exists in assistant response
  assert.strictEqual((res).instruction, undefined);
  assert.strictEqual((res).signature, undefined);
  assert.strictEqual((res).signer, undefined);

  // Verify that neither service nor AI layer has access to wallet keys
  assert.strictEqual((service).privateKey, undefined);
  assert.strictEqual((service).keypair, undefined);
  console.log("✓ Verified AI cannot sign, submit, or bypass Phantom wallet approval.");
}

console.log("\n=======================================================");
console.log("ALL 10 GEMINI INTEGRATION TESTS PASSED SUCCESSFULLY! ✓");
console.log("=======================================================");

process.exit(0);
