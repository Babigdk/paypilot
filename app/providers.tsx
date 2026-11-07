
"use client";

import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";
import { ClientProvider } from "@solana/react";

const rpcUrl =
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
    "https://api.devnet.solana.com";

export const client = createClient()
    .use(walletSigner({ chain: "solana:devnet" }))
    .use(solanaRpc({ rpcUrl }));

export type AppClient = Awaited<typeof client>;

export default function Providers({
    children,
}: {
    children: React.ReactNode;
}) {
    return <ClientProvider client={client}>{children}</ClientProvider>;
}
