
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { address, lamports } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { useClient, useRequest } from "@solana/react";
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWallets,
  useWalletStatus,
} from "@solana/kit-plugin-wallet/react";
import type { AppClient } from "./providers";
import {
  loadTransactionHistory,
  saveTransactionHistory,
  validateTransactionHistory,
  mergeTransactionHistories,
  type TransactionRecord,
} from "./storage";
import { fetchOnChainTransactions } from "./on-chain";
import { validateTransactionSafety } from "./validation";
import {
  defaultPaymentAssistant,
  type ChatMessage,
  type PreparedPayment,
} from "./assistant";

export type { TransactionRecord };

function getCurrentTimestamp(): number {
  return Date.now();
}

function generateMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function WalletBalance({
  owner,
  refreshKey,
}: {
  owner: string;
  refreshKey: number;
}) {
  const client = useClient<AppClient>();

  const balanceRequest = useMemo(
    () => client.rpc.getBalance(address(owner)),
    [client, owner]
  );

  const { data, status, refresh } = useRequest(balanceRequest);

  useEffect(() => {
    if (refreshKey > 0) {
      void refresh();
    }
  }, [refreshKey, refresh]);
  if (status === "fetching") {
    return <p className="mt-3 text-zinc-400">Loading balance...</p>;
  }

  if (status === "error") {
    return (
      <div className="mt-3">
        <p className="text-sm text-red-400">
          Could not load your SOL balance.
        </p>
        <button
          onClick={() => refresh()}
          className="mt-2 text-sm text-purple-400 hover:text-purple-300"
        >
          Try again
        </button>
      </div>
    );
  }

  const solBalance = data
    ? (Number(data.value) / 1_000_000_000).toFixed(4)
    : "0.0000";

  return (
    <div className="mt-3">
      <p className="text-3xl font-bold text-white">{solBalance} SOL</p>
      <button
        onClick={() => refresh()}
        className="mt-2 text-sm text-purple-400 hover:text-purple-300"
      >
        Refresh balance
      </button>
    </div>
  );
}


function FormattedText({ text }: { text: string }) {
  const paragraphs = text.split("\n\n");
  return (
    <div className="space-y-2">
      {paragraphs.map((p, pIdx) => {
        const lines = p.split("\n");
        return (
          <div key={pIdx}>
            {lines.map((line, lIdx) => {
              const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
              return (
                <p key={lIdx} className={lIdx > 0 ? "mt-1" : ""}>
                  {parts.map((part, partIdx) => {
                    if (part.startsWith("**") && part.endsWith("**")) {
                      return (
                        <strong
                          key={partIdx}
                          className="font-semibold text-white"
                        >
                          {part.slice(2, -2)}
                        </strong>
                      );
                    }
                    if (part.startsWith("`") && part.endsWith("`")) {
                      return (
                        <code
                          key={partIdx}
                          className="rounded bg-black/40 px-1 py-0.5 font-mono text-xs text-purple-300"
                        >
                          {part.slice(1, -1)}
                        </code>
                      );
                    }
                    return <span key={partIdx}>{part}</span>;
                  })}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const INITIAL_MESSAGE: ChatMessage = {
  id: "initial-assistant-msg",
  sender: "assistant",
  text:
    "Hello! I'm PayPilot, your AI payment assistant on Solana Devnet.\n\n" +
    "You can describe payments naturally (e.g., *\"Send 0.5 SOL to <address>\"*), check your wallet balance, ask about transaction fees, or view your transaction history. How can I help you today?",
  intentType: "general_chat",
  suggestions: [
    "What's my balance?",
    "What are transaction fees?",
    "How do I send SOL?",
    "Show my recent transactions",
  ],
  timestamp: Date.now(),
};

function PaymentComposer({
  onPaymentConfirmed,
}: {
  onPaymentConfirmed: () => void;
}) {
  const client = useClient<AppClient>();
  const connected = useConnectedWallet(client);
  const walletAddress = connected?.account.address;
  const isSubmittingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Balance query for assistant context
  const balanceRequest = useMemo(
    () =>
      walletAddress ? client.rpc.getBalance(address(walletAddress)) : null,
    [client, walletAddress]
  );
  const balanceQuery = useRequest(balanceRequest);
  const solBalance = balanceQuery.data
    ? (Number(balanceQuery.data.value) / 1_000_000_000).toFixed(4)
    : undefined;

  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE]);
  const [inputMessage, setInputMessage] = useState("");
  const [isAssistantThinking, setIsAssistantThinking] = useState(false);
  const [activeProvider, setActiveProvider] = useState<"gemini" | "local" | null>(null);
  const [transactionStatus, setTransactionStatus] = useState<
    "idle" | "submitting" | "confirming" | "confirmed" | "failed"
  >("idle");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [signature, setSignature] = useState("");
  const [prevWallet, setPrevWallet] = useState<string | undefined>(
    walletAddress
  );
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [history, setHistory] = useState<TransactionRecord[]>(() => {
    if (walletAddress) {
      return loadTransactionHistory(walletAddress);
    }
    return [];
  });

  if (walletAddress !== prevWallet) {
    setPrevWallet(walletAddress);
    setHistory(walletAddress ? loadTransactionHistory(walletAddress) : []);
    setHistoryError("");
  }

  const refreshOnChainHistory = useCallback(
    async (targetAddress?: string) => {
      const addr = targetAddress || walletAddress;
      if (!addr) return;
      setIsLoadingHistory(true);
      setHistoryError("");

      try {
        const onChain = await fetchOnChainTransactions(client, addr);
        setHistory((current) => {
          const localStored = loadTransactionHistory(addr);
          const base = mergeTransactionHistories(localStored, current);
          const merged = mergeTransactionHistories(base, onChain);
          saveTransactionHistory(addr, merged);
          return merged;
        });
      } catch (err) {
        setHistoryError(
          err instanceof Error
            ? err.message
            : "Could not retrieve on-chain transaction history from Solana Devnet."
        );
      } finally {
        setIsLoadingHistory(false);
      }
    },
    [client, walletAddress]
  );

  useEffect(() => {
    let active = true;
    if (walletAddress) {
      const timer = setTimeout(() => {
        if (active) {
          void refreshOnChainHistory(walletAddress);
        }
      }, 0);
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }
  }, [walletAddress, refreshOnChainHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isAssistantThinking]);

  async function handleSendMessage(overrideText?: string) {
    const text = (overrideText ?? inputMessage).trim();
    if (!text || isAssistantThinking || isSending) return;

    if (!overrideText) {
      setInputMessage("");
    }

    const userMsg: ChatMessage = {
      id: generateMessageId("user"),
      sender: "user",
      text,
      timestamp: getCurrentTimestamp(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsAssistantThinking(true);
    setError("");

    try {
      const assistantResponse = await defaultPaymentAssistant.processMessage(
        text,
        {
          isWalletConnected: Boolean(connected?.account.address),
          walletAddress,
          solBalance,
          balanceLoading: balanceQuery.status === "fetching",
          balanceError: balanceQuery.status === "error",
          transactions: history,
          client,
        }
      );

      const assistantMsg: ChatMessage = {
        id: assistantResponse.id,
        sender: "assistant",
        text: assistantResponse.text,
        intentType: assistantResponse.intentType,
        preparedPayment: assistantResponse.preparedPayment,
        suggestions: assistantResponse.suggestions,
        timestamp: assistantResponse.timestamp,
        provider: assistantResponse.provider,
        isFallback: assistantResponse.isFallback,
      };

      if (assistantResponse.provider) {
        setActiveProvider(assistantResponse.provider);
      }

      setMessages((prev) => [...prev, assistantMsg]);

      if (assistantResponse.preparedPayment) {
        setSignature("");
        setTransactionStatus("idle");
      }
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: generateMessageId("err"),
        sender: "assistant",
        text:
          err instanceof Error
            ? `An error occurred: ${err.message}`
            : "I encountered an error processing your request. Please try again.",
        intentType: "general_chat",
        timestamp: getCurrentTimestamp(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsAssistantThinking(false);
    }
  }

  function handleClearChat() {
    setMessages([INITIAL_MESSAGE]);
    setSignature("");
    setTransactionStatus("idle");
    setError("");
  }

  async function sendPayment(paymentToSend: PreparedPayment) {
    if (isSubmittingRef.current) {
      return;
    }

    if (!connected?.signer || !walletAddress) {
      setError("Please connect your Phantom wallet to approve this payment.");
      return;
    }

    isSubmittingRef.current = true;
    setIsSending(true);
    setError("");
    setSignature("");
    setTransactionStatus("submitting");

    try {
      // Pre-transaction validation & balance protection
      const validation = await validateTransactionSafety({
        client,
        senderAddress: walletAddress,
        recipientAddress: paymentToSend.recipient,
        amountSol: paymentToSend.amount,
        isWalletConnected: Boolean(connected?.account.address),
        chain: "solana:devnet",
      });

      if (!validation.valid) {
        setError(validation.error);
        setTransactionStatus("failed");
        return;
      }

      const transfer = getTransferSolInstruction({
        source: connected.signer,
        destination: address(paymentToSend.recipient),
        amount: lamports(validation.amountLamports),
      });

      const result = await client.sendTransaction([transfer]);
      const txSignature = result.context.signature;

      setSignature(txSignature);
      setTransactionStatus("confirming");

      let confirmed = false;

      for (let attempt = 0; attempt < 30; attempt++) {
        const response = await client.rpc
          .getSignatureStatuses([txSignature], {
            searchTransactionHistory: true,
          })
          .send();

        const txStatus = response.value[0];

        if (txStatus?.err) {
          setTransactionStatus("failed");
          throw new Error("The transaction failed on Solana Devnet.");
        }

        if (
          txStatus?.confirmationStatus === "confirmed" ||
          txStatus?.confirmationStatus === "finalized"
        ) {
          confirmed = true;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      if (!confirmed) {
        setTransactionStatus("failed");
        throw new Error(
          "Transaction confirmation is taking too long. Check Solana Explorer."
        );
      }

      setTransactionStatus("confirmed");

      const newRecord: TransactionRecord = {
        signature: txSignature,
        amount: paymentToSend.amount,
        recipient: paymentToSend.recipient,
        sender: walletAddress,
        direction: "outgoing",
        status: "confirmed",
        timestamp: getCurrentTimestamp(),
      };

      setHistory((current) => {
        const updated = validateTransactionHistory([newRecord, ...current]);
        saveTransactionHistory(walletAddress, updated);
        return updated;
      });

      onPaymentConfirmed();
      if (balanceQuery?.refresh) {
        void balanceQuery.refresh();
      }
    } catch (err) {
      setTransactionStatus("failed");
      setError(
        err instanceof Error
          ? err.message
          : "Transaction failed. Please try again."
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSending(false);
    }
  }

  return (
    <div className="mt-8 w-full rounded-2xl border border-purple-500/20 bg-purple-500/[0.04] p-6 md:p-8">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-2 w-2 rounded-full bg-green-400"></span>
            <h3 className="text-lg font-semibold">AI Payment Assistant</h3>
            {activeProvider === "gemini" ? (
              <span className="rounded-md bg-blue-500/20 px-2 py-0.5 text-xs font-semibold text-blue-300">
                ✦ Gemini AI
              </span>
            ) : activeProvider === "local" ? (
              <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
                ⚡ Local Fallback
              </span>
            ) : (
              <span className="rounded-md bg-purple-500/20 px-2 py-0.5 text-xs font-semibold text-purple-300">
                ✦ Gemini AI
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Describe payments naturally, check your balance, or ask questions about Devnet fees.
          </p>
        </div>

        <button
          type="button"
          onClick={handleClearChat}
          className="rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-white/20 hover:text-white"
        >
          Clear chat
        </button>
      </div>

      {/* Chat Messages Container */}
      <div className="space-y-4 max-h-[520px] overflow-y-auto rounded-xl border border-white/10 bg-black/30 p-4">
        {messages.map((msg) => {
          const isUser = msg.sender === "user";

          if (isUser) {
            return (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-xs bg-purple-600 px-4 py-2.5 text-sm text-white shadow-md">
                  {msg.text}
                </div>
              </div>
            );
          }

          return (
            <div key={msg.id} className="flex justify-start gap-3">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 text-xs font-bold text-white shadow">
                AI
              </div>

              <div className="max-w-[88%] space-y-3">
                <div className="rounded-2xl rounded-tl-xs border border-white/10 bg-white/[0.04] p-4 text-sm text-zinc-200">
                  <div className="mb-2 flex items-center justify-between text-[11px] text-zinc-500">
                    <span className="font-semibold text-zinc-400">PayPilot</span>
                    {msg.isFallback ? (
                      <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                        ⚡ Local Fallback
                      </span>
                    ) : msg.provider === "gemini" ? (
                      <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
                        ✦ Gemini AI
                      </span>
                    ) : null}
                  </div>
                  <FormattedText text={msg.text} />

                  {/* Suggestions pills */}
                  {msg.suggestions && msg.suggestions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-white/5 pt-3">
                      {msg.suggestions
                        .filter(
                          (suggestion) =>
                            !walletAddress ||
                            !suggestion
                              .toLowerCase()
                              .includes(walletAddress.toLowerCase())
                        )
                        .map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          disabled={isSending || isAssistantThinking}
                          onClick={() => void handleSendMessage(suggestion)}
                          className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-2.5 py-1 text-xs text-purple-300 transition hover:border-purple-500/50 hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Embedded Payment Preview Card if payment intent was prepared */}
                {msg.preparedPayment && (
                  <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-5 shadow-lg">
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-white">Payment preview</h4>
                      <span className="rounded-md bg-green-500/10 px-2.5 py-0.5 text-xs font-semibold text-green-400">
                        Validated Intent
                      </span>
                    </div>

                    <div className="mt-4 space-y-4">
                      <div>
                        <p className="text-xs text-zinc-500">Transfer amount</p>
                        <p className="mt-1 text-2xl font-bold text-white">
                          {msg.preparedPayment.amount} SOL
                        </p>
                      </div>

                      <div>
                        <p className="text-xs text-zinc-500">Sender wallet</p>
                        <p className="mt-1 break-all font-mono text-xs text-zinc-300">
                          {walletAddress || "Connect wallet to sign"}
                        </p>
                      </div>

                      <div>
                        <p className="text-xs text-zinc-500">Recipient wallet</p>
                        <p className="mt-1 break-all font-mono text-xs text-zinc-300">
                          {msg.preparedPayment.recipient}
                        </p>
                      </div>

                      <div className="grid grid-cols-2 gap-4 border-t border-white/5 pt-3">
                        <div>
                          <p className="text-xs text-zinc-500">Network</p>
                          <p className="mt-1 text-xs font-medium text-zinc-300">
                            {msg.preparedPayment.network || "Solana Devnet"}
                          </p>
                        </div>

                        <div>
                          <p className="text-xs text-zinc-500">Estimated network fee</p>
                          <p className="mt-1 font-mono text-xs text-zinc-300">
                            ~{msg.preparedPayment.estimatedFeeSol || "0.000005"} SOL
                          </p>
                        </div>
                      </div>

                      <div className="rounded-lg bg-black/40 p-3">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-zinc-400">Total estimated deduction:</span>
                          <span className="font-mono font-semibold text-white">
                            ~{msg.preparedPayment.totalDeductionSol || msg.preparedPayment.amount} SOL
                          </span>
                        </div>
                      </div>
                    </div>

                    {!signature && (
                      <>
                        <p className="mt-4 rounded-lg bg-black/30 p-3 text-xs text-yellow-400">
                          Review the details above. Phantom will prompt you to approve this
                          Devnet transfer before anything is sent.
                        </p>

                        <button
                          onClick={() => void sendPayment(msg.preparedPayment!)}
                          disabled={
                            isSending ||
                            transactionStatus === "submitting" ||
                            transactionStatus === "confirming" ||
                            !connected?.signer
                          }
                          className="mt-4 w-full rounded-xl bg-green-600 px-5 py-3 font-semibold transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {!connected?.signer
                            ? "Connect Phantom to Approve"
                            : transactionStatus === "submitting"
                            ? "Waiting for Phantom approval..."
                            : transactionStatus === "confirming"
                            ? "Confirming on Solana Devnet..."
                            : isSending
                            ? "Processing..."
                            : "Confirm & Send SOL"}
                        </button>
                      </>
                    )}

                    {signature && (
                      <div className="mt-4 rounded-lg border border-green-500/20 bg-green-500/10 p-4">
                        <div className="flex items-center justify-between">
                          <p className="font-semibold text-green-400">
                            {transactionStatus === "confirmed"
                              ? "Payment confirmed!"
                              : transactionStatus === "failed"
                              ? "Transaction failed"
                              : "Transaction submitted!"}
                          </p>
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-semibold ${
                              transactionStatus === "confirmed"
                                ? "bg-green-500/20 text-green-400"
                                : transactionStatus === "failed"
                                ? "bg-red-500/20 text-red-400"
                                : "bg-yellow-500/20 text-yellow-400"
                            }`}
                          >
                            {transactionStatus === "submitting" && "Submitted"}
                            {transactionStatus === "confirming" && "Confirming"}
                            {transactionStatus === "confirmed" && "Confirmed"}
                            {transactionStatus === "failed" && "Failed"}
                          </span>
                        </div>

                        <p className="mt-2 break-all font-mono text-xs text-zinc-300">
                          {signature}
                        </p>
                        <a
                          href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-3 inline-block text-sm text-purple-400 hover:text-purple-300"
                        >
                          View transaction on Solana Explorer →
                        </a>

                        <p className="mt-2 text-sm">
                          {transactionStatus === "confirming" && (
                            <span className="text-yellow-400">
                              Waiting for Solana Devnet confirmation...
                            </span>
                          )}

                          {transactionStatus === "confirmed" && (
                            <span className="text-green-400">
                              Transaction confirmed successfully on Solana Devnet!
                            </span>
                          )}

                          {transactionStatus === "failed" && (
                            <span className="text-red-400">
                              Transaction confirmation failed or timed out. Check Explorer.
                            </span>
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Thinking Indicator */}
        {isAssistantThinking && (
          <div className="flex justify-start gap-3">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 text-xs font-bold text-white shadow">
              AI
            </div>
            <div className="flex items-center gap-2 rounded-2xl rounded-tl-xs border border-white/10 bg-white/[0.04] px-4 py-3 text-xs text-zinc-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-400"></span>
              <span className="h-1.5 w-1.5 animate-pulse delay-150 rounded-full bg-purple-400"></span>
              <span className="h-1.5 w-1.5 animate-pulse delay-300 rounded-full bg-purple-400"></span>
              <span>PayPilot is thinking (Gemini AI)...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-400" role="alert">
          {error}
        </p>
      )}

      {/* Input Message Form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSendMessage();
        }}
        className="mt-4 flex gap-2"
      >
        <input
          type="text"
          value={inputMessage}
          onChange={(event) => setInputMessage(event.target.value)}
          placeholder="Ask a question or describe a payment (e.g. 'Send 0.5 SOL to...')"
          disabled={isSending || isAssistantThinking}
          className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-purple-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!inputMessage.trim() || isSending || isAssistantThinking}
          className="rounded-xl bg-purple-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send →
        </button>
      </form>

      {/* Transaction History Section */}
      <div className="mt-8 border-t border-white/5 pt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold">Transaction history</h3>
            <p className="text-xs text-zinc-500">
              Solana Devnet & local records
            </p>
          </div>

          <div className="flex items-center gap-3">
            {history.length > 0 && (
              <span className="text-xs text-zinc-500">
                {history.length}{" "}
                {history.length === 1 ? "transaction" : "transactions"}
              </span>
            )}
            <button
              onClick={() => void refreshOnChainHistory()}
              disabled={isLoadingHistory}
              className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-purple-400 transition hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoadingHistory ? "Refreshing..." : "Refresh history"}
            </button>
          </div>
        </div>

        {historyError && (
          <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
            <p className="text-sm text-red-400">{historyError}</p>
            <button
              onClick={() => void refreshOnChainHistory()}
              className="mt-2 text-xs text-purple-400 hover:text-purple-300"
            >
              Try again
            </button>
          </div>
        )}

        {isLoadingHistory && history.length === 0 && (
          <div className="rounded-xl border border-white/10 bg-black/20 p-6 text-center">
            <p className="text-sm text-zinc-400">
              Fetching on-chain transactions from Solana Devnet...
            </p>
          </div>
        )}

        {!isLoadingHistory && history.length === 0 && !historyError && (
          <div className="rounded-xl border border-white/10 bg-black/20 p-6 text-center">
            <p className="text-sm text-zinc-400">
              No transactions found for this wallet on Solana Devnet yet.
            </p>
          </div>
        )}

        {history.length > 0 && (
          <div className="space-y-3">
            {history.map((transaction) => {
              const isIncoming = transaction.direction === "incoming";
              const isFailed = transaction.status === "failed";

              return (
                <div
                  key={transaction.signature}
                  className="rounded-xl border border-white/10 bg-black/20 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                          isIncoming
                            ? "bg-green-500/10 text-green-400"
                            : "bg-purple-500/10 text-purple-400"
                        }`}
                      >
                        {isIncoming ? "↓ Received" : "↑ Sent"}
                      </span>
                      <span
                        className={`font-semibold ${
                          isIncoming ? "text-green-400" : "text-white"
                        }`}
                      >
                        {isIncoming ? "+" : "-"}
                        {transaction.amount} SOL
                      </span>
                    </div>

                    <span
                      className={`text-xs ${
                        isFailed
                          ? "text-red-400"
                          : transaction.status === "finalized"
                          ? "text-green-400"
                          : transaction.status === "confirming"
                          ? "text-yellow-400"
                          : "text-green-400"
                      }`}
                    >
                      {isFailed
                        ? "Failed"
                        : transaction.status === "finalized"
                        ? "Finalized"
                        : transaction.status === "confirming"
                        ? "Confirming"
                        : "Confirmed"}
                    </span>
                  </div>

                  {transaction.sender && (
                    <p className="mt-2 break-all text-xs text-zinc-400">
                      <span className="text-zinc-500">From:</span>{" "}
                      {transaction.sender}
                    </p>
                  )}

                  <p className="mt-1 break-all text-xs text-zinc-400">
                    <span className="text-zinc-500">To:</span>{" "}
                    {transaction.recipient}
                  </p>

                  {transaction.timestamp > 0 && (
                    <p className="mt-2 text-xs text-zinc-500">
                      {new Date(transaction.timestamp).toLocaleString()}
                    </p>
                  )}

                  <a
                    href={`https://explorer.solana.com/tx/${transaction.signature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-block text-sm text-purple-400 hover:text-purple-300"
                  >
                    View on Solana Explorer →
                  </a>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


export default function Home() {
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);
  const client = useClient<AppClient>();
  const wallets = useWallets(client);
  const connected = useConnectedWallet(client);
  const walletStatus = useWalletStatus(client);
  const connect = useConnect(client);
  const disconnect = useDisconnect(client);

  const isConnecting = connect.isRunning;

  return (
    <main className="flex min-h-screen flex-col bg-[#09090f] text-white">
      <header className="flex items-center justify-between border-b border-white/10 px-6 py-5 md:px-12">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Pay<span className="text-purple-400">Pilot</span>
          </h1>
          <p className="text-xs text-zinc-500">AI-powered Solana payments</p>
        </div>

        <span className="rounded-full border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-xs text-green-400">
          Solana Devnet
        </span>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center px-6 py-20">
        <div className="mb-10 text-center">
          <p className="mb-3 text-sm font-medium uppercase tracking-[0.25em] text-purple-400">
            Your payment assistant
          </p>
          <h2 className="text-4xl font-bold tracking-tight md:text-5xl">
            Payments made <span className="text-purple-400">simpler.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-zinc-400">
            Connect your Solana wallet to get started with intelligent,
            secure payments.
          </p>
        </div>

        <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl md:p-8">
          <div className="mb-6 flex items-center justify-between">
            <h3 className="text-lg font-semibold">Wallet overview</h3>
            <span className="text-xs text-zinc-500">DEVNET</span>
          </div>

          {walletStatus === "pending" ? (
            <p className="text-sm text-zinc-400">Checking wallet connection...</p>
          ) : connected ? (
            <div>
              <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-400">
                    Wallet connected
                  </span>
                  <span className="text-xs text-green-400">Connected</span>
                </div>

                <p className="mt-2 break-all font-mono text-sm text-white">
                  {connected.account.address}
                </p>
              </div>

              <div className="mt-6 rounded-xl bg-black/30 p-5">
                <p className="text-sm text-zinc-400">Available balance</p>
                <WalletBalance
                  owner={connected.account.address}
                  refreshKey={balanceRefreshKey}
                />
              </div>

              <button
                onClick={() => disconnect.dispatch()}
                disabled={disconnect.isRunning}
                className="mt-6 w-full rounded-xl border border-white/10 py-3 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-50"
              >
                {disconnect.isRunning ? "Disconnecting..." : "Disconnect wallet"}
              </button>
            </div>
          ) : (
            <div>
              <p className="mb-5 text-sm text-zinc-400">
                Choose a compatible wallet to connect to PayPilot.
              </p>

              {wallets.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {wallets.map((wallet) => (
                    <button
                      key={wallet.name}
                      onClick={() => connect.dispatch(wallet)}
                      disabled={isConnecting}
                      className="flex w-full items-center justify-between rounded-xl bg-purple-600 px-5 py-4 font-semibold transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span>
                        {isConnecting ? "Connecting..." : `Connect ${wallet.name}`}
                      </span>
                      <span>→</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-white/10 bg-black/20 p-5 text-center">
                  <p className="text-sm text-zinc-300">
                    No compatible wallet detected.
                  </p>
                  <p className="mt-2 text-sm text-zinc-500">
                    Install the Phantom browser extension, then refresh this page.
                  </p>
                  <a
                    href="https://phantom.com/download"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-block text-sm font-semibold text-purple-400 hover:text-purple-300"
                  >
                    Get Phantom →
                  </a>
                </div>
              )}

              {connect.error != null && (
                <p className="mt-4 text-sm text-red-400" role="alert">
                  {connect.error instanceof Error
                    ? connect.error.message
                    : "Wallet connection failed. Please try again."}
                </p>
              )}
            </div>
          )}
        </div>
        <PaymentComposer
          onPaymentConfirmed={() =>
            setBalanceRefreshKey((current) => current + 1)
          }
        />
        <p className="mt-8 text-center text-xs text-zinc-600">
          Your private keys stay in your wallet. PayPilot never asks for your
          recovery phrase.
        </p>
      </section>

      <footer className="border-t border-white/10 px-6 py-5 text-center text-xs text-zinc-600">
        PayPilot · Built on Solana
      </footer>
    </main>
  );
}
