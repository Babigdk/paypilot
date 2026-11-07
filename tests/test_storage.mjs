import assert from "node:assert";

// Mock localStorage
class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

// Set up global window and localStorage
const mockStorage = new MockLocalStorage();
globalThis.window = {
  localStorage: mockStorage,
};

// Now import from storage.ts
const {
  loadTransactionHistory,
  saveTransactionHistory,
  validateTransactionHistory,
  isValidTransactionRecord,
} = await import("file:///C:/Users/USER/Desktop/hacktober/PayPilot/app/storage.ts");

console.log("Running comprehensive tests for PayPilot persistent transaction history...");

// Test 1: Record Validation
console.log("\n--- Test 1: Record Validation ---");
assert.strictEqual(
  isValidTransactionRecord({
    signature: "sig1",
    amount: "0.5",
    recipient: "recip1",
    timestamp: 1700000000000,
  }),
  true,
  "Valid record should pass"
);

assert.strictEqual(
  isValidTransactionRecord({
    signature: "",
    amount: "0.5",
    recipient: "recip1",
    timestamp: 1700000000000,
  }),
  false,
  "Empty signature should fail"
);

assert.strictEqual(
  isValidTransactionRecord({
    signature: "sig1",
    amount: "   ",
    recipient: "recip1",
    timestamp: 1700000000000,
  }),
  false,
  "Whitespace amount should fail"
);

assert.strictEqual(
  isValidTransactionRecord({
    signature: "sig1",
    amount: "0.5",
    recipient: "",
    timestamp: 1700000000000,
  }),
  false,
  "Empty recipient should fail"
);

assert.strictEqual(
  isValidTransactionRecord({
    signature: "sig1",
    amount: "0.5",
    recipient: "recip1",
    timestamp: -100,
  }),
  false,
  "Negative timestamp should fail"
);

assert.strictEqual(
  isValidTransactionRecord({
    signature: "sig1",
    amount: "0.5",
    recipient: "recip1",
    timestamp: NaN,
  }),
  false,
  "NaN timestamp should fail"
);

assert.strictEqual(isValidTransactionRecord(null), false, "null should fail");
assert.strictEqual(isValidTransactionRecord("string"), false, "string should fail");
assert.strictEqual(isValidTransactionRecord([]), false, "array should fail");
console.log("✓ Record validation tests passed.");

// Test 2: Validation, Deduplication, Sorting, and 20-Item Cap
console.log("\n--- Test 2: Validation, Deduplication, Sorting, and 20-Item Cap ---");
const rawList = [];
for (let i = 1; i <= 30; i++) {
  rawList.push({
    signature: `sig_${i}`,
    amount: `0.${i}`,
    recipient: `wallet_${i}`,
    timestamp: 1000 + i * 10,
  });
}
// Add duplicates
rawList.push({
  signature: "sig_30",
  amount: "0.30",
  recipient: "wallet_30",
  timestamp: 1300,
});
// Add invalid item
rawList.push({ signature: "invalid" });

const validated = validateTransactionHistory(rawList);
assert.strictEqual(validated.length, 20, "Should cap at MAX_HISTORY_ITEMS (20)");
assert.strictEqual(validated[0].signature, "sig_30", "Should be sorted newest first (timestamp 1300)");
assert.strictEqual(validated[19].signature, "sig_11", "20th item should be sig_11 (timestamp 1110)");
console.log("✓ Validation, deduplication, sorting, and cap tests passed.");

// Test 3: Per-Wallet Storage Isolation
console.log("\n--- Test 3: Per-Wallet Storage Isolation ---");
mockStorage.clear();
const walletA = "WalletAddressAAAAAAAAAAAAAAAAAAAAAAAA";
const walletB = "WalletAddressBBBBBBBBBBBBBBBBBBBBBBBB";

const txA = [
  {
    signature: "tx_a_1",
    amount: "1.0",
    recipient: "recipient_a",
    timestamp: 2000,
  },
];
const txB = [
  {
    signature: "tx_b_1",
    amount: "2.5",
    recipient: "recipient_b",
    timestamp: 3000,
  },
];

saveTransactionHistory(walletA, txA);
saveTransactionHistory(walletB, txB);

const loadedA = loadTransactionHistory(walletA);
const loadedB = loadTransactionHistory(walletB);

assert.strictEqual(loadedA.length, 1);
assert.strictEqual(loadedA[0].signature, "tx_a_1");
assert.strictEqual(loadedB.length, 1);
assert.strictEqual(loadedB[0].signature, "tx_b_1");

// Verify separate keys exist in localStorage
assert(mockStorage.getItem(`paypilot_transactions_${walletA}`) !== null);
assert(mockStorage.getItem(`paypilot_transactions_${walletB}`) !== null);

// Verify global dictionary compatibility also exists
const globalData = JSON.parse(mockStorage.getItem("paypilot_transactions"));
assert.strictEqual(globalData[walletA][0].signature, "tx_a_1");
assert.strictEqual(globalData[walletB][0].signature, "tx_b_1");
console.log("✓ Per-wallet storage isolation tests passed.");

// Test 4: Graceful handling of corrupted localStorage
console.log("\n--- Test 4: Handling Corrupted localStorage ---");
const walletC = "WalletAddressCCCCCCCCCCCCCCCCCCCCCCCC";

// Test invalid JSON string
mockStorage.setItem(`paypilot_transactions_${walletC}`, "{ corrupted json... ");
const corruptedResult1 = loadTransactionHistory(walletC);
assert.deepStrictEqual(corruptedResult1, [], "Corrupted JSON should return empty array gracefully");

// Test non-array JSON
mockStorage.setItem(`paypilot_transactions_${walletC}`, JSON.stringify({ not: "an array" }));
const corruptedResult2 = loadTransactionHistory(walletC);
assert.deepStrictEqual(corruptedResult2, [], "Non-array JSON should return empty array gracefully");

// Test array with corrupted records
mockStorage.setItem(
  `paypilot_transactions_${walletC}`,
  JSON.stringify([
    { signature: "valid_sig", amount: "0.1", recipient: "dest", timestamp: 12345 },
    { signature: "", amount: "0.1", recipient: "dest", timestamp: 12345 }, // invalid
    null,
    "garbage",
  ])
);
const corruptedResult3 = loadTransactionHistory(walletC);
assert.strictEqual(corruptedResult3.length, 1);
assert.strictEqual(corruptedResult3[0].signature, "valid_sig");
console.log("✓ Corrupted storage handling tests passed.");

// Test 5: Storage Unavailable Graceful Degradation
console.log("\n--- Test 5: Storage Unavailable Handling ---");
// Simulate localStorage throwing on getItem/setItem (e.g. private browsing quota/security error)
const brokenStorage = {
  getItem() {
    throw new Error("SecurityError: Access is denied");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};
globalThis.window.localStorage = brokenStorage;

// Should not throw
const brokenLoad = loadTransactionHistory("AnyWallet");
assert.deepStrictEqual(brokenLoad, [], "Should gracefully return empty array if storage throws");

assert.doesNotThrow(() => {
  saveTransactionHistory("AnyWallet", txA);
}, "saveTransactionHistory should not throw when storage throws");

console.log("✓ Storage unavailable graceful degradation tests passed.");

console.log("\nALL TESTS PASSED SUCCESSFULLY! ✓\n");
