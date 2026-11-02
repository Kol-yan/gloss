"use client";

import { useEffect, useState } from "react";
import type { ApiResult } from "./client";
import { useAccess } from "./use-access";

// Loads data when the component appears and again whenever it becomes visible
// after another route was shown (React keeps visited routes mounted), so lists
// are fresh without a manual refresh. The previous data stays on screen while
// the new request is running.
export function useLoad<T>(load: () => Promise<ApiResult<T>>): {
  result: ApiResult<T> | null;
  reload: () => void;
} {
  const { sessionRevision } = useAccess();
  const [loaded, setLoaded] = useState<{ revision: number; result: ApiResult<T> } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setLoaded({ revision: sessionRevision, result: next });
    });
    return () => {
      cancelled = true;
    };
  }, [load, nonce, sessionRevision]);

  return {
    result: loaded?.revision === sessionRevision ? loaded.result : null,
    // Back to "loading" immediately, then fetch again.
    reload: () => {
      setLoaded(null);
      setNonce((n) => n + 1);
    },
  };
}
