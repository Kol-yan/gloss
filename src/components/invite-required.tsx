"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { bootstrapGuestAccess, createGuestSession } from "@/features/api/client";
import { useAccess } from "@/features/api/use-access";

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string;
    action?: string;
    appearance: "interaction-only";
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
  }) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// A single root-layout component starts the demo session in the background.
// Invite continuations remain in control of their own session upgrade flow.
export function AccessBootstrap() {
  const pathname = usePathname();
  const { sessionRevision } = useAccess();
  const [requestedTurnstile, setRequestedTurnstile] = useState<{
    pathname: string;
    sessionRevision: number;
    siteKey: string;
    action?: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const onToken = useCallback(async (token: string) => {
    const result = await createGuestSession(token);
    setMessage(result.ok ? null : result.message);
    return result.ok;
  }, []);

  useEffect(() => {
    let active = true;
    if (pathname === "/join" || pathname.startsWith("/join/")) return () => { active = false; };

    void bootstrapGuestAccess().then((result) => {
      if (active && result.kind === "ready") setMessage(null);
      if (active && result.kind === "unavailable") setMessage(result.message ?? "Free guest access is unavailable. Open Settings to use your own OpenRouter key.");
      if (active && result.kind === "turnstile") {
        setRequestedTurnstile({
          pathname,
          sessionRevision,
          siteKey: result.siteKey,
          ...(result.action ? { action: result.action } : {}),
        });
      }
    });
    return () => { active = false; };
  }, [pathname, sessionRevision]);

  const turnstile = requestedTurnstile?.pathname === pathname && requestedTurnstile.sessionRevision === sessionRevision
    ? requestedTurnstile
    : null;
  if (pathname === "/join" || pathname.startsWith("/join/")) return null;
  return <>{turnstile ? <TurnstileWidget siteKey={turnstile.siteKey} action={turnstile.action} onToken={onToken} /> : null}{message ? <div role="alert" className="fixed bottom-20 right-2 z-[60] max-w-sm rounded-card bg-card p-4 shadow-card">{message} <Link href="/settings" className="underline">Open Settings</Link></div> : null}</>;
}

function TurnstileWidget({ siteKey, action, onToken }: { siteKey: string; action?: string; onToken: (token: string) => Promise<boolean> }) {
  const container = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  const [error, setError] = useState<string | null>(null);
  const resetWidget = useRef<() => void>(() => undefined);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let active = true;
    let widgetId: string | null = null;
    let script: HTMLScriptElement | null = null;

    const failed = () => { if (active) setError("Verification could not load. Check your connection and reload the page."); };
    const render = () => {
      const api = window.turnstile;
      if (!active || !api || !container.current || widgetId) return;
      resetWidget.current = () => { if (active && widgetId) { setError(null); api.reset(widgetId); } };
      widgetId = api.render(container.current, {
        sitekey: siteKey,
        ...(action ? { action } : {}),
        // Managed mode stays quiet unless Turnstile needs the visitor to act.
        appearance: "interaction-only",
        callback: (token) => {
          void onTokenRef.current(token).then(ok => {
            if (active && !ok) setError("Guest access could not start. Try verification again or open Settings.");
          });
        },
        "error-callback": () => { if (active) setError("Verification failed. Please try again."); },
        "expired-callback": () => {
          if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
        },
      });
    };

    if (window.turnstile) {
      render();
    } else {
      script = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = TURNSTILE_SCRIPT;
        script.async = true;
        script.defer = true;
        document.head.append(script);
      }
      script.addEventListener("load", render);
      script.addEventListener("error", failed);
    }

    return () => {
      active = false;
      script?.removeEventListener("load", render);
      script?.removeEventListener("error", failed);
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [action, siteKey]);

  return <div className="fixed bottom-2 right-2 z-[60] max-w-sm rounded-card bg-card p-2"><div ref={container} />{error ? <p role="alert">{error} <button type="button" onClick={() => resetWidget.current()} className="underline">Retry verification</button></p> : null}</div>;
}

export function AccessUnavailable() {
  return (
    <section role="status" className="mx-auto mt-6 max-w-lg rounded-tile border border-line bg-card p-5 text-center shadow-card">
      <h1 className="text-xl font-semibold">Your workspace is not ready yet.</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-muted">
        You can keep writing and using on-device checks. Open Settings to add your own OpenRouter key for cloud features.
      </p>
      <Link href="/settings" className="mt-4 inline-flex rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-strong">
        Settings
      </Link>
    </section>
  );
}

export function DemoSpentNotice({ className = "" }: { className?: string }) {
  return (
    <p role="status" className={`rounded-chip bg-caution-soft px-3 py-2 text-sm leading-snug text-caution ${className}`}>
      The free demo is used up. Add your own OpenRouter key in{" "}
      <Link href="/settings" className="font-semibold underline underline-offset-2">Settings</Link> to keep going.
    </p>
  );
}
