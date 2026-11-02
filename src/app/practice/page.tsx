import type { Metadata } from "next";
import { PracticeScreen } from "@/features/practice/practice-screen";

export const metadata: Metadata = { title: "Practice" };

// Tasks come from the server once practice is wired in; until then the page is
// honestly empty instead of showing sample tasks.
export default function PracticePage() {
  return <PracticeScreen task={null} />;
}
