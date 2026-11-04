import type { Metadata } from "next";
import { SettingsPanel } from "@/components/provider-access";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <div className="mx-auto flex w-full max-w-6xl justify-center px-4 py-8"><SettingsPanel /></div>;
}
