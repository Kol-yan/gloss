import type { Metadata } from "next";
import { ExpressionsSession } from "@/features/expressions/expressions-session";

export const metadata: Metadata = { title: "My words" };

export default function ExpressionsPage() {
  return <ExpressionsSession />;
}
