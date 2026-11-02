"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";

// Shown when the server does not recognise the browser's session (HTTP 401).
export function InviteRequired({ notice, onRetry }: { notice?: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col">
      {notice ? (
        <p role="status" className="mx-auto mt-4 max-w-md rounded-chip bg-caution-soft px-4 py-2 text-center text-sm font-semibold text-caution">
          {notice}
        </p>
      ) : null}
      <EmptyState
        eyebrow="Invite only"
        title="You need an invite link"
        action={
          <Button variant="primary" onClick={onRetry}>
            I opened my link, check again
          </Button>
        }
      >
        Glossy is open to invited people for now. Open the link you were sent, then come back to this page.
      </EmptyState>
    </div>
  );
}
