import assert from "node:assert";

const { NaturalLanguagePaymentParser } = await import(
  "file:///C:/Users/USER/Desktop/hacktober/PayPilot/app/parser.ts"
);

console.log("Running comprehensive tests for NaturalLanguagePaymentParser...\n");

const parser = new NaturalLanguagePaymentParser();
const testAddress1 = "7t95nnQFzG3ASCBef9sc1KUxduLBvxngsx2kmRe4HZ8A";
const testAddress2 = "3kj7QNS2TE5AHwQPJpZhNU6HmcFEdbudShcjm7gXtFze";
const connectedWallet = "DLTedoWS84MP251y4zGLQ2HVsQSvPz49hKpad9bwv4T1";

// 1. Valid instructions from the user prompt
console.log("--- Test 1: User prompt examples ---");
const ex1 = parser.parse(`Send 0.5 SOL to ${testAddress1}`);
assert.strictEqual(ex1.success, true);
assert.strictEqual(ex1.intent.amount, "0.5");
assert.strictEqual(ex1.intent.recipient, testAddress1);
assert.strictEqual(ex1.intent.asset, "SOL");
assert.strictEqual(ex1.intent.action, "send");
assert.strictEqual(ex1.intent.network, "Solana Devnet");

const ex2 = parser.parse(`Transfer 1 SOL to ${testAddress2}`);
assert.strictEqual(ex2.success, true);
assert.strictEqual(ex2.intent.amount, "1");
assert.strictEqual(ex2.intent.recipient, testAddress2);
assert.strictEqual(ex2.intent.action, "transfer");

const ex3 = parser.parse(`Pay 0.25 SOL to ${testAddress2}`);
assert.strictEqual(ex3.success, true);
assert.strictEqual(ex3.intent.amount, "0.25");
assert.strictEqual(ex3.intent.recipient, testAddress2);
assert.strictEqual(ex3.intent.action, "pay");

const ex4 = parser.parse(`I want to send 0.1 SOL to this wallet: ${testAddress2}`);
assert.strictEqual(ex4.success, true);
assert.strictEqual(ex4.intent.amount, "0.1");
assert.strictEqual(ex4.intent.recipient, testAddress2);
assert.strictEqual(ex4.intent.action, "send");
console.log("✓ All 4 user prompt examples parsed successfully.");

// 2. Different natural-language sentence structures
console.log("\n--- Test 2: Diverse sentence structures ---");
const v1 = parser.parse(`Please transfer 2.5 sol to recipient ${testAddress1}`);
assert.strictEqual(v1.success, true);
assert.strictEqual(v1.intent.amount, "2.5");
assert.strictEqual(v1.intent.recipient, testAddress1);

const v2 = parser.parse(`Send .75 solana to address: ${testAddress2}`);
assert.strictEqual(v2.success, true);
assert.strictEqual(v2.intent.amount, "0.75");
assert.strictEqual(v2.intent.recipient, testAddress2);

const v3 = parser.parse(`To ${testAddress1}, please pay 0.005 SOL.`);
assert.strictEqual(v3.success, true);
assert.strictEqual(v3.intent.amount, "0.005");
assert.strictEqual(v3.intent.recipient, testAddress1);

const v4 = parser.parse(`Wire 10 SOL to wallet ${testAddress2}!`);
assert.strictEqual(v4.success, true);
assert.strictEqual(v4.intent.amount, "10");
assert.strictEqual(v4.intent.recipient, testAddress2);
console.log("✓ Diverse sentence structures parsed successfully.");

// 3. Missing recipient
console.log("\n--- Test 3: Missing recipient ---");
const missRecip1 = parser.parse("Send 0.5 SOL");
assert.strictEqual(missRecip1.success, false);
assert.strictEqual(missRecip1.field, "recipient");
console.log("Error message:", missRecip1.error);

const missRecip2 = parser.parse("Please transfer 1 SOL to");
assert.strictEqual(missRecip2.success, false);
assert.strictEqual(missRecip2.field, "recipient");
console.log("✓ Missing recipient caught cleanly.");

// 4. Missing amount
console.log("\n--- Test 4: Missing amount ---");
const missAmt = parser.parse(`Send SOL to ${testAddress1}`);
assert.strictEqual(missAmt.success, false);
assert.strictEqual(missAmt.field, "amount");
console.log("Error message:", missAmt.error);
console.log("✓ Missing amount caught cleanly.");

// 5. Invalid recipient address
console.log("\n--- Test 5: Invalid recipient address ---");
const invRecip = parser.parse("Send 0.5 SOL to 12345NotAnAddress");
assert.strictEqual(invRecip.success, false);
assert.strictEqual(invRecip.field, "recipient");
console.log("Error message:", invRecip.error);
console.log("✓ Invalid recipient address caught cleanly.");

// 6. Unsupported assets
console.log("\n--- Test 6: Unsupported assets ---");
const usdc = parser.parse(`Send 50 USDC to ${testAddress1}`);
assert.strictEqual(usdc.success, false);
assert.strictEqual(usdc.field, "asset");
console.log("USDC Error message:", usdc.error);

const eth = parser.parse(`Transfer 2.5 ETH to ${testAddress1}`);
assert.strictEqual(eth.success, false);
assert.strictEqual(eth.field, "asset");
console.log("ETH Error message:", eth.error);

const btc = parser.parse(`Pay 0.1 BTC to ${testAddress1}`);
assert.strictEqual(btc.success, false);
assert.strictEqual(btc.field, "asset");
console.log("BTC Error message:", btc.error);
console.log("✓ Unsupported assets rejected with clear explanations.");

// 7. Invalid amounts (zero, negative)
console.log("\n--- Test 7: Zero and negative amounts ---");
const zeroAmt = parser.parse(`Send 0 SOL to ${testAddress1}`);
assert.strictEqual(zeroAmt.success, false);
assert.strictEqual(zeroAmt.field, "amount");
console.log("Zero amount error:", zeroAmt.error);

const zeroDecimal = parser.parse(`Transfer 0.000000000 SOL to ${testAddress1}`);
assert.strictEqual(zeroDecimal.success, false);
assert.strictEqual(zeroDecimal.field, "amount");
console.log("Zero decimal error:", zeroDecimal.error);
console.log("✓ Zero amounts rejected cleanly.");

// 8. Excessive decimal precision
console.log("\n--- Test 8: Excessive decimal precision (> 9 decimals) ---");
const tooPrecise = parser.parse(`Send 0.123456789123 SOL to ${testAddress1}`);
assert.strictEqual(tooPrecise.success, false);
assert.strictEqual(tooPrecise.field, "amount");
console.log("Excessive precision error:", tooPrecise.error);

const maxPrecisionValid = parser.parse(`Send 0.123456789 SOL to ${testAddress1}`);
assert.strictEqual(maxPrecisionValid.success, true);
assert.strictEqual(maxPrecisionValid.intent.amount, "0.123456789");
console.log("✓ Precision limits enforced (max 9 decimals for SOL).");

// 9. Sending to own wallet
console.log("\n--- Test 9: Sending to own wallet ---");
const selfSend = parser.parse(`Send 0.5 SOL to ${connectedWallet}`, connectedWallet);
assert.strictEqual(selfSend.success, false);
assert.strictEqual(selfSend.field, "recipient");
console.log("Self send error:", selfSend.error);
console.log("✓ Sending to own connected wallet rejected.");

console.log("\nALL TESTS PASSED SUCCESSFULLY! ✓\n");
