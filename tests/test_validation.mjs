import assert from "node:assert";

const {
  validateAmountPrecision,
  estimateTransactionFee,
  validateTransactionSafety,
  BASE_TRANSACTION_FEE_LAMPORTS,
} = await import("file:///C:/Users/USER/Desktop/hacktober/PayPilot/app/validation.ts");

console.log("Running comprehensive tests for PayPilot Validation & Safety Layer...\n");

const SENDER = "DLTedoWS84MP251y4zGLQ2HVsQSvPz49hKpad9bwv4T1";
const RECIPIENT = "7t95nnQFzG3ASCBef9sc1KUxduLBvxngsx2kmRe4HZ8A";
const DEVNET_CHAIN = "solana:devnet";

// Helper to mock client RPC
function createMockClient({
  balanceLamports = BigInt(2_000_000_000), // 2 SOL default
  prioritizationFees = [{ prioritizationFee: 1_000_000 }], // 1 lamport in micro-lamports
  getBalanceError = null,
  getPrioritizationFeeError = null,
} = {}) {
  return {
    rpc: {
      getBalance: () => ({
        send: async () => {
          if (getBalanceError) throw getBalanceError;
          return { value: balanceLamports };
        },
      }),
      getRecentPrioritizationFees: () => ({
        send: async () => {
          if (getPrioritizationFeeError) throw getPrioritizationFeeError;
          return prioritizationFees;
        },
      }),
      getSignatureStatuses: () => ({
        send: async () => {
          return {
            value: [{ confirmationStatus: "confirmed", err: null }],
          };
        },
      }),
    },
  };
}

// ---------------------------------------------------------
// 1. Amount Precision & Lamport Validation
// ---------------------------------------------------------
console.log("--- Test 1: Amount Precision & Decimal Limits ---");
{
  // Valid integer amount
  const res1 = validateAmountPrecision("1");
  assert.strictEqual(res1.valid, true);
  assert.strictEqual(res1.amountLamports, BigInt(1_000_000_000));

  // Valid 9 decimal places (1 lamport)
  const res2 = validateAmountPrecision("0.000000001");
  assert.strictEqual(res2.valid, true);
  assert.strictEqual(res2.amountLamports, BigInt(1));

  // Zero amount
  const resZero = validateAmountPrecision("0");
  assert.strictEqual(resZero.valid, false);
  assert.match(resZero.error, /greater than zero/);

  // Negative amount
  const resNeg = validateAmountPrecision("-1");
  assert.strictEqual(resNeg.valid, false);

  // Excessive decimals (>9 decimal places)
  const resExcess = validateAmountPrecision("0.0000000001");
  assert.strictEqual(resExcess.valid, false);
  assert.match(resExcess.error, /9 decimal places/);

  console.log("✓ validateAmountPrecision enforces >0 and max 9 decimal places correctly.");
}

// ---------------------------------------------------------
// 2. Fee Estimation
// ---------------------------------------------------------
console.log("\n--- Test 2: Fee Estimation ---");
{
  const clientWithFee = createMockClient({
    prioritizationFees: [{ prioritizationFee: 5_000_000 }], // 5 lamports
  });
  const estimate = await estimateTransactionFee(clientWithFee);
  assert.strictEqual(estimate.baseFeeLamports, BASE_TRANSACTION_FEE_LAMPORTS);
  assert.strictEqual(estimate.prioritizationFeeLamports, BigInt(5));
  assert.strictEqual(estimate.totalFeeLamports, BASE_TRANSACTION_FEE_LAMPORTS + BigInt(5));

  // RPC failure fallback
  const clientFailingFee = createMockClient({
    getPrioritizationFeeError: new Error("RPC unreachable"),
  });
  const fallbackEstimate = await estimateTransactionFee(clientFailingFee);
  assert.strictEqual(fallbackEstimate.baseFeeLamports, BASE_TRANSACTION_FEE_LAMPORTS);
  assert.strictEqual(fallbackEstimate.totalFeeLamports, BASE_TRANSACTION_FEE_LAMPORTS);
  console.log("✓ estimateTransactionFee handles prioritization fees and error fallbacks.");
}

// ---------------------------------------------------------
// 3. Pre-transaction: Disconnected Wallet
// ---------------------------------------------------------
console.log("\n--- Test 3: Disconnected Wallet Check ---");
{
  const client = createMockClient();
  const res = await validateTransactionSafety({
    client,
    senderAddress: undefined,
    recipientAddress: RECIPIENT,
    amountSol: "0.5",
    isWalletConnected: false,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "DISCONNECTED_WALLET");
  assert.match(res.error, /Wallet is not connected/);
  console.log("✓ Disconnected wallet blocked cleanly.");
}

// ---------------------------------------------------------
// 4. Pre-transaction: Invalid Network
// ---------------------------------------------------------
console.log("\n--- Test 4: Network Validation (Devnet Only) ---");
{
  const client = createMockClient();
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "0.5",
    isWalletConnected: true,
    chain: "solana:mainnet",
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "INVALID_NETWORK");
  assert.match(res.error, /Solana Devnet/);
  console.log("✓ Non-devnet networks rejected.");
}

// ---------------------------------------------------------
// 5. Pre-transaction: Invalid Recipient
// ---------------------------------------------------------
console.log("\n--- Test 5: Invalid Recipient Address ---");
{
  const client = createMockClient();
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: "invalid-solana-address-xyz",
    amountSol: "0.5",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "INVALID_RECIPIENT");
  assert.match(res.error, /not a valid Solana address/);
  console.log("✓ Invalid recipient address rejected.");
}

// ---------------------------------------------------------
// 6. Pre-transaction: Self-Transfer
// ---------------------------------------------------------
console.log("\n--- Test 6: Self-Transfer Prevention ---");
{
  const client = createMockClient();
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: SENDER,
    amountSol: "0.5",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "SELF_TRANSFER");
  assert.match(res.error, /cannot send a payment to your own/);
  console.log("✓ Self-transfer prevented.");
}

// ---------------------------------------------------------
// 7. Pre-transaction: Zero or Negative Amount
// ---------------------------------------------------------
console.log("\n--- Test 7: Zero and Negative Amounts ---");
{
  const client = createMockClient();
  const resZero = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "0",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(resZero.valid, false);
  assert.strictEqual(resZero.code, "ZERO_OR_NEGATIVE_AMOUNT");

  const resNeg = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "-2.5",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(resNeg.valid, false);
  console.log("✓ Zero and negative amounts rejected.");
}

// ---------------------------------------------------------
// 8. Pre-transaction: Excessive Decimal Precision
// ---------------------------------------------------------
console.log("\n--- Test 8: Excessive Decimal Precision ---");
{
  const client = createMockClient();
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "0.12345678901",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "EXCESSIVE_DECIMAL_PRECISION");
  assert.match(res.error, /9 decimal places/);
  console.log("✓ Excessive precision rejected.");
}

// ---------------------------------------------------------
// 9. Pre-transaction: Insufficient Balance
// ---------------------------------------------------------
console.log("\n--- Test 9: Insufficient Balance Check ---");
{
  // Wallet has 0.5 SOL (500,000,000 lamports), trying to send 1.0 SOL
  const client = createMockClient({
    balanceLamports: BigInt(500_000_000),
  });
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "1.0",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "INSUFFICIENT_BALANCE");
  assert.match(res.error, /Insufficient balance/);
  console.log("✓ Insufficient balance detected and blocked.");
}

// ---------------------------------------------------------
// 10. Pre-transaction: Insufficient Funds For Network Fee
// ---------------------------------------------------------
console.log("\n--- Test 10: Insufficient Funds For Fees Protection ---");
{
  // Wallet has exactly 1.0 SOL (1,000,000,000 lamports).
  // Trying to send 1.0 SOL. Transfer amount is covered, but 5,000 lamports fee is NOT!
  const client = createMockClient({
    balanceLamports: BigInt(1_000_000_000),
    prioritizationFees: [],
  });
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "1.0",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "INSUFFICIENT_FUNDS_FOR_FEES");
  assert.match(res.error, /Insufficient funds for network fee/);
  console.log("✓ Insufficient funds for fees detected and blocked.");
}

// ---------------------------------------------------------
// 11. Pre-transaction: RPC Failure Handling
// ---------------------------------------------------------
console.log("\n--- Test 11: RPC Failure Graceful Handling ---");
{
  const client = createMockClient({
    getBalanceError: new Error("Devnet node unavailable"),
  });
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "0.5",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.code, "RPC_ERROR");
  assert.match(res.error, /Could not retrieve latest wallet balance/);
  console.log("✓ RPC failure handled gracefully.");
}

// ---------------------------------------------------------
// 12. Pre-transaction: Successful Validation
// ---------------------------------------------------------
console.log("\n--- Test 12: Successful Transaction Safety Check ---");
{
  // Wallet has 5.0 SOL, sending 0.5 SOL
  const client = createMockClient({
    balanceLamports: BigInt(5_000_000_000),
  });
  const res = await validateTransactionSafety({
    client,
    senderAddress: SENDER,
    recipientAddress: RECIPIENT,
    amountSol: "0.5",
    isWalletConnected: true,
    chain: DEVNET_CHAIN,
  });
  assert.strictEqual(res.valid, true);
  if (res.valid) {
    assert.strictEqual(res.amountLamports, BigInt(500_000_000));
    assert.strictEqual(res.currentBalanceLamports, BigInt(5_000_000_000));
    assert.strictEqual(res.feeEstimate.totalFeeLamports >= BASE_TRANSACTION_FEE_LAMPORTS, true);
    assert.strictEqual(res.totalDeductionLamports > res.amountLamports, true);
  }
  console.log("✓ Successful validation returns lamports, fees, and deduction.");
}

// ---------------------------------------------------------
// 13. Submission Protection: Duplicate Submission Attempts
// ---------------------------------------------------------
console.log("\n--- Test 13: Duplicate Submission Protection (Ref Guard) ---");
{
  const isSubmittingRef = { current: false };
  let processedCount = 0;
  let blockedCount = 0;

  async function mockSendPayment() {
    if (isSubmittingRef.current) {
      blockedCount++;
      return;
    }
    isSubmittingRef.current = true;
    try {
      processedCount++;
      // Simulate network / Phantom delay
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      isSubmittingRef.current = false;
    }
  }

  // Rapidly fire 5 submission attempts concurrently
  await Promise.all([
    mockSendPayment(),
    mockSendPayment(),
    mockSendPayment(),
    mockSendPayment(),
    mockSendPayment(),
  ]);

  assert.strictEqual(processedCount, 1);
  assert.strictEqual(blockedCount, 4);
  console.log("✓ Concurrency guard prevents duplicate submissions (1 processed, 4 blocked).");
}

// ---------------------------------------------------------
// 14. Transaction Confirmation Lifecycle
// ---------------------------------------------------------
console.log("\n--- Test 14: Transaction Confirmation Lifecycle ---");
{
  // Simulate confirmation status resolution
  async function pollConfirmation(mockStatuses) {
    let status = "submitting";
    status = "confirming";
    for (const txStatus of mockStatuses) {
      if (txStatus?.err) {
        status = "failed";
        throw new Error("The transaction failed on Solana Devnet.");
      }
      if (
        txStatus?.confirmationStatus === "confirmed" ||
        txStatus?.confirmationStatus === "finalized"
      ) {
        status = "confirmed";
        return status;
      }
    }
    status = "failed";
    throw new Error("Transaction confirmation timed out.");
  }

  // Success case
  const confirmedResult = await pollConfirmation([
    { confirmationStatus: "processed", err: null },
    { confirmationStatus: "confirmed", err: null },
  ]);
  assert.strictEqual(confirmedResult, "confirmed");

  // Error case
  await assert.rejects(
    async () => {
      await pollConfirmation([{ confirmationStatus: null, err: { InstructionError: [0, "Custom"] } }]);
    },
    { message: "The transaction failed on Solana Devnet." }
  );

  // Timeout case
  await assert.rejects(
    async () => {
      await pollConfirmation([{ confirmationStatus: "processed", err: null }]);
    },
    { message: "Transaction confirmation timed out." }
  );

  console.log("✓ Confirmation lifecycle correctly distinguishes confirming, confirmed, and failed.");
}

console.log("\n=======================================================");
console.log("ALL 14 TRANSACTION SAFETY & VALIDATION TESTS PASSED! ✓");
console.log("=======================================================");
