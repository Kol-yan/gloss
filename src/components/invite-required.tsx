"use client";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { ProviderKeyForm } from "@/components/provider-access";

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
        eyebrow="Welcome"
        title="Choose how to try gloss"
        action={
          <Button variant="secondary" onClick={onRetry}>
            I opened my link, check again
          </Button>
        }
      >
        Have an invite? Open its link for access within an allowance. You can also use your own OpenRouter key below.
      </EmptyState>
      <div className="mx-auto mb-8 w-full max-w-md px-4">
        <div className="rounded-tile border border-line bg-surface p-4">
          <ProviderKeyForm onReady={onRetry} />
        </div>
      </div>
    </div>
  );
}
