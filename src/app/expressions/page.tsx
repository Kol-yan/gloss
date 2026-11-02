import type { Metadata } from "next";
import { ExpressionsSession } from "@/features/expressions/expressions-session";

export const metadata: Metadata = { title: "My expressions" };

export default function ExpressionsPage() {
  return <ExpressionsSession />;
}
