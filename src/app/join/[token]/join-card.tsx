import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { EmptyState } from "@/components/empty-state";
import { Button, buttonClasses } from "@/components/ui/button";
import { SESSION_COOKIE, findLearnerBySessionToken } from "@/server/auth/sessions";

// What a visitor sees on an invite link. Opening the link only reads: the
// invite is spent by the button below, which posts to /join/{token}/continue.
// That keeps link previews, scanners and prefetchers from using it up.
export async function JoinCard({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const store = await cookies();
  // Reading the session looks at the clock; that is only allowed once the
  // render is known to happen at request time.
  await connection();
  const signedIn = findLearnerBySessionToken(store.get(SESSION_COOKIE)?.value) !== null;

  if (signedIn) {
    return (
      <EmptyState
        eyebrow="Invite"
        title="You are already signed in"
        action={
          <Link href="/" className={buttonClasses("primary")}>
            Back to the editor
          </Link>
        }
      >
        This browser already has a gloss session, so the invite link was not used.
      </EmptyState>
    );
  }

  return (
    <EmptyState
      eyebrow="Invite"
      title="You are invited to gloss"
      action={
        <form method="post" action={`/join/${encodeURIComponent(token)}/continue`}>
          <Button type="submit" variant="primary">
            Continue
          </Button>
        </form>
      }
    >
      Continue to start your session in this browser.
    </EmptyState>
  );
}
