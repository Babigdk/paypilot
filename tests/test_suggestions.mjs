import assert from "node:assert";
import fs from "node:fs";
import { sanitizeSuggestions } from "file:///c:/Users/USER/Desktop/hacktober/PayPilot/app/assistant.ts";

console.log("=== Testing Suggestions Sanitization & Quick-Prompts ===");

// 1. Check dashboard.tsx INITIAL_MESSAGE
const dashboardSrc = fs.readFileSync("app/dashboard.tsx", "utf8");
assert.ok(!dashboardSrc.includes('"Send 0.5 SOL to 7t95nnQFzG3ASCBef9sc1KUxduLBvxngsx2kmRe4HZ8A"'), "Old payment suggestion should be removed from dashboard.tsx");
assert.ok(dashboardSrc.includes('"What\'s my balance?"'), "Balance suggestion should be preserved");
assert.ok(dashboardSrc.includes('"What are transaction fees?"'), "Fee suggestion should be preserved");
assert.ok(dashboardSrc.includes('"How do I send SOL?"'), "Help suggestion should be preserved");
console.log("✓ Initial dashboard quick-prompts verified.");

// 2. Test sanitizeSuggestions
const myWallet = "3kj7QNS2TE5AHwQPJpZhNU6HmcFEdbudShcjm7gXtFze";
const suggestionsWithOwnWallet = [
  "What's my balance?",
  "What are transaction fees?",
  `Send 0.5 SOL to ${myWallet}`,
  "How do I send SOL?",
  `Pay 1 SOL to ${myWallet.toLowerCase()}`
];

const cleaned = sanitizeSuggestions(suggestionsWithOwnWallet, myWallet);
console.log("Cleaned suggestions:", cleaned);
assert.strictEqual(cleaned.length, 3);
assert.ok(!cleaned.some(s => s.toLowerCase().includes(myWallet.toLowerCase())));
assert.deepStrictEqual(cleaned, [
  "What's my balance?",
  "What are transaction fees?",
  "How do I send SOL?",
]);
console.log("✓ sanitizeSuggestions prevents connected wallet self-transfer suggestions.");

// 3. Test that dashboard filters own wallet address when rendering
assert.ok(dashboardSrc.includes("includes(walletAddress.toLowerCase())"), "Dashboard must filter out connected wallet address from rendered suggestions");
console.log("✓ Dashboard client-side filter verified.");

console.log("\nALL SUGGESTION TESTS PASSED! ✓");
