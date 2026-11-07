import assert from "node:assert";

const { LocalPaymentAssistant } = await import(
  "file:///C:/Users/USER/Desktop/hacktober/PayPilot/app/assistant.ts"
);

console.log("Running comprehensive tests for PayPilot AI Payment Assistant...\n");

const assistant = new LocalPaymentAssistant();
const SENDER = "DLTedoWS84MP251y4zGLQ2HVsQSvPz49hKpad9bwv4T1";
const RECIPIENT = "7t95nnQFzG3ASCBef9sc1KUxduLBvxngsx2kmRe4HZ8A";
const OTHER_WALLET = "3kj7QNS2TE5AHwQPJpZhNU6HmcFEdbudShcjm7gXtFze";

// Helper to create mock context
function createContext({
  isWalletConnected = true,
  walletAddress = SENDER,
  solBalance = "2.4500",
  balanceLoading = false,
  balanceError = false,
  transactions = [],
  client = undefined,
} = {}) {
  return {
    isWalletConnected,
    walletAddress,
    solBalance,
    balanceLoading,
    balanceError,
    transactions,
    client,
  };
}

// -------------------------------------------------------------
// 1. Payment Intent Recognition
// -------------------------------------------------------------
console.log("--- Test 1: Payment Intent Recognition ---");
{
  const ctx = createContext();
  const res = await assistant.processMessage(
    `Send 0.5 SOL to ${RECIPIENT}`,
    ctx
  );
  assert.strictEqual(res.intentType, "payment_preview");
  assert.ok(res.preparedPayment);
  assert.strictEqual(res.preparedPayment.amount, "0.5");
  assert.strictEqual(res.preparedPayment.recipient, RECIPIENT);
  assert.strictEqual(res.preparedPayment.network, "Solana Devnet");
  assert.strictEqual(res.preparedPayment.asset, "SOL");
  assert.match(res.text, /prepared your transfer of \*\*0\.5 SOL\*\*/);
  assert.match(res.text, /Total Estimated Deduction/);
  console.log("✓ Valid payment command parsed into structured payment preview.");
}

// -------------------------------------------------------------
// 2. Balance Questions
// -------------------------------------------------------------
console.log("\n--- Test 2: Balance Questions ---");
{
  // When connected with available balance
  const ctxWithBalance = createContext({ solBalance: "3.7500" });
  const res1 = await assistant.processMessage("What's my balance?", ctxWithBalance);
  assert.strictEqual(res1.intentType, "balance_inquiry");
  assert.match(res1.text, /3\.7500 SOL/);

  const res2 = await assistant.processMessage("How much SOL do I have?", ctxWithBalance);
  assert.strictEqual(res2.intentType, "balance_inquiry");
  assert.match(res2.text, /3\.7500 SOL/);

  console.log("✓ Balance queries report exact live balance.");
}

// -------------------------------------------------------------
// 3. Fee Questions
// -------------------------------------------------------------
console.log("\n--- Test 3: Transaction Fee Questions ---");
{
  const ctx = createContext();
  const res1 = await assistant.processMessage("What are transaction fees?", ctx);
  assert.strictEqual(res1.intentType, "fee_inquiry");
  assert.match(res1.text, /5,000 lamports/);
  assert.match(res1.text, /0\.000005 SOL/);

  const res2 = await assistant.processMessage("Explain transaction fees", ctx);
  assert.strictEqual(res2.intentType, "fee_inquiry");
  assert.match(res2.text, /Prioritization Fee/);

  console.log("✓ Fee questions provide clear breakdown of base & prioritization fees.");
}

// -------------------------------------------------------------
// 4. Transaction History Questions
// -------------------------------------------------------------
console.log("\n--- Test 4: Transaction History Questions ---");
{
  const mockTxs = [
    {
      signature: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYj7UtDPPo",
      amount: "0.25",
      recipient: RECIPIENT,
      sender: SENDER,
      direction: "outgoing",
      status: "confirmed",
      timestamp: Date.now() - 60000,
    },
    {
      signature: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
      amount: "1.0",
      recipient: SENDER,
      sender: OTHER_WALLET,
      direction: "incoming",
      status: "confirmed",
      timestamp: Date.now() - 120000,
    },
  ];

  const ctxWithTxs = createContext({ transactions: mockTxs });
  const res = await assistant.processMessage("Show me my recent transactions", ctxWithTxs);
  assert.strictEqual(res.intentType, "history_inquiry");
  assert.match(res.text, /0\.25 SOL/);
  assert.match(res.text, /1\.0 SOL/);
  assert.match(res.text, /Solana Devnet/);

  // When empty
  const ctxEmpty = createContext({ transactions: [] });
  const resEmpty = await assistant.processMessage("What are my recent payments?", ctxEmpty);
  assert.strictEqual(resEmpty.intentType, "history_inquiry");
  assert.match(resEmpty.text, /No recent transactions were found/);

  console.log("✓ Transaction history queries correctly summarize past transactions.");
}

// -------------------------------------------------------------
// 5. Incomplete Payment Details
// -------------------------------------------------------------
console.log("\n--- Test 5: Incomplete Payment Instructions ---");
{
  const ctx = createContext();

  // Missing both amount and recipient
  const resBoth = await assistant.processMessage("Send some SOL.", ctx);
  assert.strictEqual(resBoth.intentType, "missing_payment_info");
  assert.match(resBoth.text, /missing both the \*\*amount\*\* and the \*\*recipient address\*\*/);

  const resPayment = await assistant.processMessage("I want to make a payment.", ctx);
  assert.strictEqual(resPayment.intentType, "missing_payment_info");
  assert.match(resPayment.text, /missing both/);

  // Missing amount (has recipient)
  const resAmount = await assistant.processMessage(
    `Transfer SOL to this address: ${RECIPIENT}`,
    ctx
  );
  assert.strictEqual(resAmount.intentType, "missing_payment_info");
  assert.match(resAmount.text, /didn't specify an amount/);

  // Missing recipient (has amount)
  const resRecipient = await assistant.processMessage("Send 0.5 SOL", ctx);
  assert.strictEqual(resRecipient.intentType, "missing_payment_info");
  assert.match(resRecipient.text, /didn't provide a recipient wallet address/);

  console.log("✓ Incomplete instructions explain exactly what information is missing.");
}

// -------------------------------------------------------------
// 6. Invalid Payment Instructions
// -------------------------------------------------------------
console.log("\n--- Test 6: Invalid Payment Instructions ---");
{
  const ctx = createContext();

  // Invalid recipient address
  const resInvalidAddr = await assistant.processMessage(
    "Send 0.5 SOL to NotAValidSolanaAddress123",
    ctx
  );
  assert.strictEqual(resInvalidAddr.intentType, "invalid_payment");
  assert.match(resInvalidAddr.text, /not a valid Solana address/);

  // Self-transfer attempt
  const resSelf = await assistant.processMessage(
    `Send 0.5 SOL to ${SENDER}`,
    ctx
  );
  assert.strictEqual(resSelf.intentType, "invalid_payment");
  assert.match(resSelf.text, /cannot send a payment to your own/);

  // Unsupported asset
  const resAsset = await assistant.processMessage(
    `Send 50 USDC to ${RECIPIENT}`,
    ctx
  );
  assert.strictEqual(resAsset.intentType, "invalid_payment");
  assert.match(resAsset.text, /Unsupported asset/);

  // Excessive decimals
  const resDecimals = await assistant.processMessage(
    `Send 0.1234567891 SOL to ${RECIPIENT}`,
    ctx
  );
  assert.strictEqual(resDecimals.intentType, "invalid_payment");
  assert.match(resDecimals.text, /9 decimal places/);

  console.log("✓ Invalid instructions rejected with clear explanatory messages.");
}

// -------------------------------------------------------------
// 7. Wallet Disconnected State
// -------------------------------------------------------------
console.log("\n--- Test 7: Wallet Disconnected State ---");
{
  const disconnectedCtx = createContext({
    isWalletConnected: false,
    walletAddress: undefined,
    solBalance: undefined,
  });

  const resBal = await assistant.processMessage("What is my balance?", disconnectedCtx);
  assert.strictEqual(resBal.intentType, "balance_inquiry");
  assert.match(resBal.text, /don't have a wallet connected yet/);

  const resHist = await assistant.processMessage("Show my history", disconnectedCtx);
  assert.strictEqual(resHist.intentType, "history_inquiry");
  assert.match(resHist.text, /connect your Phantom wallet/);

  console.log("✓ Disconnected wallet queries prompt the user to connect Phantom.");
}

// -------------------------------------------------------------
// 8. Assistant Responses When Data is Unavailable
// -------------------------------------------------------------
console.log("\n--- Test 8: Data Unavailable State (Loading & Error) ---");
{
  // Balance loading
  const loadingCtx = createContext({
    balanceLoading: true,
    solBalance: undefined,
  });
  const resLoading = await assistant.processMessage("What's my balance?", loadingCtx);
  assert.strictEqual(resLoading.intentType, "balance_inquiry");
  assert.match(resLoading.text, /currently loading from Solana Devnet/);

  // Balance error
  const errorCtx = createContext({
    balanceError: true,
    solBalance: undefined,
  });
  const resError = await assistant.processMessage("What's my balance?", errorCtx);
  assert.strictEqual(resError.intentType, "balance_inquiry");
  assert.match(resError.text, /couldn't retrieve the Devnet balance/);

  console.log("✓ Loading and error states handled gracefully without fabricating data.");
}

// -------------------------------------------------------------
// 9. How to Send SOL & General Help
// -------------------------------------------------------------
console.log("\n--- Test 9: How to Send SOL & General Help ---");
{
  const ctx = createContext();
  const resHelp = await assistant.processMessage("How do I send SOL?", ctx);
  assert.strictEqual(resHelp.intentType, "help_inquiry");
  assert.match(resHelp.text, /Connect Phantom/);
  assert.match(resHelp.text, /Describe Payments Naturally/);
  assert.match(resHelp.text, /Approve via Phantom/);

  const resGreeting = await assistant.processMessage("Hello!", ctx);
  assert.strictEqual(resGreeting.intentType, "general_chat");
  assert.match(resGreeting.text, /I'm PayPilot/);

  console.log("✓ Help and conversational greetings handled smoothly.");
}

console.log("\n=======================================================");
console.log("ALL 9 ASSISTANT TEST SUITES PASSED SUCCESSFULLY! ✓");
console.log("=======================================================");
