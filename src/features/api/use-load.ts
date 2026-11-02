"use client";

import { useEffect, useState } from "react";
import type { ApiResult } from "./client";

// Loads data when the component appears and again whenever it becomes visible
// after another route was shown (React keeps visited routes mounted), so lists
// are fresh without a manual refresh. The previous data stays on screen while
// the new request is running.
export function useLoad<T>(load: () => Promise<ApiResult<T>>): {
  result: ApiResult<T> | null;
  reload: () => void;
} {
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load, nonce]);

  return {
    result,
    // Back to "loading" immediately, then fetch again.
    reload: () => {
      setResult(null);
      setNonce((n) => n + 1);
    },
  };
}
