import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { getSessionCookieName, findLearnerBySessionToken } from "@/server/auth/sessions";

// What a visitor sees on an invite link. Opening the link only reads: the
// invite is spent by the button below, which posts to /join/{token}/continue.
// That keeps link previews, scanners and prefetchers from using it up.
export async function JoinCard({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [store, requestHeaders] = await Promise.all([cookies(), headers()]);
  // Reading the session looks at the clock; that is only allowed once the
  // render is known to happen at request time.
  await connection();
  const cookieName = getSessionCookieName(undefined, requestHeaders.get("host") ?? undefined);
  const signedIn = findLearnerBySessionToken(store.get(cookieName)?.value) !== null;
  const continueAction = (
    <form method="post" action={`/join/${encodeURIComponent(token)}/continue`}>
      <Button type="submit" variant="primary">
        Continue
      </Button>
    </form>
  );

  if (signedIn) {
    return (
      <EmptyState
        eyebrow="Invite"
        title="Add this invite to your workspace"
        action={continueAction}
      >
        Continue to apply any higher allowance from this invite to your current learner.
      </EmptyState>
    );
  }

  return (
    <EmptyState
      eyebrow="Invite"
      title="You are invited to gloss"
        action={continueAction}
    >
      Continue to start your session in this browser.
    </EmptyState>
  );
}
