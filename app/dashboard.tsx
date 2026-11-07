
"use client";

import { useEffect, useMemo, useState } from "react";
import { address } from "@solana/kit";
import { useClient, useRequest } from "@solana/react";
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useWallets,
  useWalletStatus,
} from "@solana/kit-plugin-wallet/react";
import type { AppClient } from "./providers";

function WalletBalance({ owner }: { owner: string }) {
  const client = useClient<AppClient>();

  const balanceRequest = useMemo(
    () => client.rpc.getBalance(address(owner)),
    [client, owner]
  );

  const { data, status, error, refresh } = useRequest(balanceRequest);

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

export default function Home() {
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
                <WalletBalance owner={connected.account.address} />
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
