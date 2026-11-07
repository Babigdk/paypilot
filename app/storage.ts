export type TransactionRecord = {
  signature: string;
  amount: string;
  recipient: string;
  sender?: string;
  direction?: "incoming" | "outgoing";
  status?: "confirmed" | "finalized" | "failed" | "confirming";
  timestamp: number;
};

export const MAX_HISTORY_ITEMS = 20;
export const STORAGE_KEY_PREFIX = "paypilot_transactions_";
export const GLOBAL_STORAGE_KEY = "paypilot_transactions";
export const ALT_STORAGE_KEY_PREFIX = "paypilot_tx_history_";

/**
 * Checks if browser localStorage is available and writable.
 */
export function isStorageAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const testKey = "__paypilot_storage_test__";
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates whether an unknown value conforms to TransactionRecord.
 */
export function isValidTransactionRecord(item: unknown): item is TransactionRecord {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const record = item as Record<string, unknown>;
  return (
    typeof record.signature === "string" &&
    record.signature.trim().length > 0 &&
    typeof record.amount === "string" &&
    record.amount.trim().length > 0 &&
    typeof record.recipient === "string" &&
    record.recipient.trim().length > 0 &&
    typeof record.timestamp === "number" &&
    Number.isFinite(record.timestamp) &&
    record.timestamp >= 0 &&
    (record.sender === undefined || typeof record.sender === "string") &&
    (record.direction === undefined ||
      record.direction === "incoming" ||
      record.direction === "outgoing") &&
    (record.status === undefined || typeof record.status === "string")
  );
}

/**
 * Validates, deduplicates, sorts (descending by timestamp), and caps an array of transactions to 20.
 */
export function validateTransactionHistory(data: unknown): TransactionRecord[] {
  if (!Array.isArray(data)) {
    return [];
  }

  const validRecords: TransactionRecord[] = [];
  const seenSignatures = new Set<string>();

  for (const item of data) {
    if (isValidTransactionRecord(item)) {
      const trimmedSignature = item.signature.trim();
      if (!seenSignatures.has(trimmedSignature)) {
        seenSignatures.add(trimmedSignature);
        validRecords.push({
          signature: trimmedSignature,
          amount: item.amount.trim(),
          recipient: item.recipient.trim(),
          sender: typeof item.sender === "string" ? item.sender.trim() : undefined,
          direction: item.direction,
          status: item.status as TransactionRecord["status"],
          timestamp: item.timestamp,
        });
      }
    }
  }

  // Sort descending by timestamp (newest first)
  validRecords.sort((a, b) => b.timestamp - a.timestamp);

  // Keep a maximum of 20 most recent transactions
  return validRecords.slice(0, MAX_HISTORY_ITEMS);
}

/**
 * Merges locally persisted transaction records with blockchain retrieved records.
 * Authoritative on-chain data takes precedence for status and blockTime while preserving
 * existing local data when on-chain data is incomplete. Deduplicates by signature and caps at 20.
 */
export function mergeTransactionHistories(
  localRecords: TransactionRecord[],
  onChainRecords: TransactionRecord[]
): TransactionRecord[] {
  const map = new Map<string, TransactionRecord>();

  // 1. Add valid local records
  for (const record of localRecords) {
    if (isValidTransactionRecord(record)) {
      map.set(record.signature, record);
    }
  }

  // 2. Merge on-chain records
  for (const onChain of onChainRecords) {
    if (isValidTransactionRecord(onChain)) {
      const existing = map.get(onChain.signature);
      if (existing) {
        map.set(onChain.signature, {
          signature: onChain.signature,
          amount:
            onChain.amount &&
            onChain.amount !== "0" &&
            onChain.amount !== "0.0000" &&
            onChain.amount !== "—"
              ? onChain.amount
              : existing.amount,
          recipient:
            onChain.recipient &&
            onChain.recipient !== "Unknown" &&
            onChain.recipient !== "N/A"
              ? onChain.recipient
              : existing.recipient,
          sender:
            onChain.sender &&
            onChain.sender !== "Unknown" &&
            onChain.sender !== "N/A"
              ? onChain.sender
              : existing.sender,
          direction: onChain.direction ?? existing.direction,
          status: onChain.status ?? existing.status ?? "confirmed",
          timestamp: onChain.timestamp > 0 ? onChain.timestamp : existing.timestamp,
        });
      } else {
        map.set(onChain.signature, onChain);
      }
    }
  }

  const merged = Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
  return merged.slice(0, MAX_HISTORY_ITEMS);
}

/**
 * Retrieves and validates the transaction history for a specific wallet address from localStorage.
 */
export function loadTransactionHistory(walletAddress: string): TransactionRecord[] {
  if (!walletAddress || !isStorageAvailable()) {
    return [];
  }

  const cleanAddress = walletAddress.trim();
  if (!cleanAddress) {
    return [];
  }

  try {
    // 1. Try per-wallet key (e.g. paypilot_transactions_<address>)
    const perWalletKey = `${STORAGE_KEY_PREFIX}${cleanAddress}`;
    const rawPerWallet = window.localStorage.getItem(perWalletKey);
    if (rawPerWallet) {
      try {
        const parsed = JSON.parse(rawPerWallet);
        const validated = validateTransactionHistory(parsed);
        if (validated.length > 0) {
          return validated;
        }
      } catch {
        // Corrupted JSON in per-wallet key
      }
    }

    // 2. Try alternate per-wallet key (e.g. paypilot_tx_history_<address>)
    const altKey = `${ALT_STORAGE_KEY_PREFIX}${cleanAddress}`;
    const rawAlt = window.localStorage.getItem(altKey);
    if (rawAlt) {
      try {
        const parsed = JSON.parse(rawAlt);
        const validated = validateTransactionHistory(parsed);
        if (validated.length > 0) {
          return validated;
        }
      } catch {
        // Corrupted JSON in alternate key
      }
    }

    // 3. Try global dictionary key (e.g. paypilot_transactions)
    const rawGlobal = window.localStorage.getItem(GLOBAL_STORAGE_KEY);
    if (rawGlobal) {
      try {
        const parsed = JSON.parse(rawGlobal);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const walletData = (parsed as Record<string, unknown>)[cleanAddress];
          const validated = validateTransactionHistory(walletData);
          if (validated.length > 0) {
            return validated;
          }
        }
      } catch {
        // Corrupted JSON in global dictionary key
      }
    }
  } catch {
    // Graceful fallback on unexpected storage exceptions
  }

  return [];
}

/**
 * Saves validated transaction history for a specific wallet address to localStorage.
 */
export function saveTransactionHistory(
  walletAddress: string,
  history: TransactionRecord[]
): void {
  if (!walletAddress || !isStorageAvailable()) {
    return;
  }

  const cleanAddress = walletAddress.trim();
  if (!cleanAddress) {
    return;
  }

  try {
    const validated = validateTransactionHistory(history);
    const serialized = JSON.stringify(validated);

    // Save to primary per-wallet key
    window.localStorage.setItem(`${STORAGE_KEY_PREFIX}${cleanAddress}`, serialized);

    // Also update global dictionary key for broader compatibility
    try {
      const rawGlobal = window.localStorage.getItem(GLOBAL_STORAGE_KEY);
      let map: Record<string, unknown> = {};
      if (rawGlobal) {
        try {
          const parsed = JSON.parse(rawGlobal);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            map = parsed as Record<string, unknown>;
          }
        } catch {
          map = {};
        }
      }
      map[cleanAddress] = validated;
      window.localStorage.setItem(GLOBAL_STORAGE_KEY, JSON.stringify(map));
    } catch {
      // Ignore secondary map update errors
    }
  } catch {
    // Gracefully handle storage errors (e.g. QuotaExceededError)
  }
}
