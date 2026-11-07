
"use client";

import dynamic from "next/dynamic";

const Dashboard = dynamic(() => import("./dashboard"), {
  ssr: false,
  loading: () => (
    <main className="flex min-h-screen items-center justify-center bg-[#09090f] text-white">
      Loading PayPilot...
    </main>
  ),
});

export default function DashboardLoader() {
  return <Dashboard />;
}
