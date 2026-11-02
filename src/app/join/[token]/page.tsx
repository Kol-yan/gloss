import type { Metadata } from "next";
import { Suspense } from "react";
import { JoinCard } from "./join-card";

export const metadata: Metadata = {
  title: "Join",
  // An invite link is private: keep it out of search results and Referer headers.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// The page depends on the token in the URL, so it is rendered when requested.
// The shared header reads the pathname, which is unknown until then; allowing
// the route to block is right for a page nobody navigates to instantly.
export const instant = false;

export default function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={null}>
      <JoinCard params={params} />
    </Suspense>
  );
}
