"use client";

import { AccessUnavailable } from "@/components/invite-required";
import { LoadError, LoadingState } from "@/components/load-states";
import { isUnauthorized, listExpressions } from "@/features/api/client";
import { useLoad } from "@/features/api/use-load";
import { ExpressionsScreen } from "./expressions-screen";

// Loads the learner's expressions and shows them, or the reason they are missing.
export function ExpressionsSession() {
  const { result, reload } = useLoad(listExpressions);

  if (!result) return <LoadingState label="Loading your words" />;
  if (!result.ok) {
    if (isUnauthorized(result)) return <AccessUnavailable />;
    return (
      <LoadError title="We couldn't load your words" onRetry={reload}>
        Check your connection and try again.
      </LoadError>
    );
  }
  return <ExpressionsScreen items={result.data.expressions} />;
}
