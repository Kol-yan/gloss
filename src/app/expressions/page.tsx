import type { Metadata } from "next";
import { ExpressionsScreen } from "@/features/expressions/expressions-screen";

export const metadata: Metadata = { title: "My expressions" };

// History comes from the server once it is wired in; until then the page is
// honestly empty instead of showing sample entries.
export default function ExpressionsPage() {
  return <ExpressionsScreen items={[]} />;
}
