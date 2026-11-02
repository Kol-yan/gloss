"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { enrollByok, getMe, signOut } from "@/features/api/client";
import { forgetProviderKey, isProviderKey } from "@/features/api/access-store";
import { useAccess } from "@/features/api/use-access";
import { Button } from "./ui/button";

export function ProviderKeyForm({ onReady, compact = false }: { onReady: () => void; compact?: boolean }) {
  const inputId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const access = useAccess();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !isProviderKey(draft)) return;
    setPending(true);
    setMessage(null);
    const result = await enrollByok(draft);
    setPending(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setDraft("");
    setMessage(result.data.accessMode === "byok" ? "Your key is ready." : "Your invite access is already active. Your key was not saved.");
    onReady();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 text-left">
      {!compact ? <h2 className="text-xl font-semibold">Try with your own OpenRouter key</h2> : null}
      <p id={descriptionId} className="text-sm leading-snug text-ink-muted">
        Your key is stored only in this browser. For cloud requests, it passes temporarily through gloss to OpenRouter.
        The gloss server never saves it. OpenRouter charges your account for model use.
      </p>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-semibold">OpenRouter key</label>
        <input
          id={inputId}
          aria-describedby={descriptionId}
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={512}
          placeholder="Paste your OpenRouter key"
          className="w-full min-w-0 rounded-field border border-line-strong bg-card px-3 py-2 text-base text-ink outline-none placeholder:text-ink-muted focus:border-accent focus:ring-4 focus:ring-accent/15"
        />
      </div>
      <Button type="submit" variant="primary" disabled={!isProviderKey(draft)} pending={pending}>
        {pending ? "Connecting…" : access.session?.accessMode === "byok" ? "Use this key" : "Start with my key"}
      </Button>
      {message ? <p role="status" className="text-sm leading-snug text-ink-muted">{message}</p> : null}
      {access.storageNotice ? <p role="status" className="text-sm leading-snug text-caution">{access.storageNotice}</p> : null}
    </form>
  );
}

export function AccountControls() {
  const access = useAccess();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void getMe();
  }, []);

  const leave = async () => {
    if (pending) return;
    setPending(true);
    const result = await signOut();
    setPending(false);
    if (result.ok) {
      setOpen(false);
      setMessage(null);
    } else {
      setMessage(result.message);
    }
  };

  if (!access.session) return null;
  const byok = access.session.accessMode === "byok";

  return (
    <div className="relative shrink-0">
      <Button variant="quiet" size="sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        {byok && !access.hasKey ? "Add key" : "Account"}
      </Button>
      {open ? (
        <section id={panelId} aria-label="Your access" className="absolute right-0 top-full z-50 mt-2 flex max-h-[75dvh] w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto rounded-tile border border-line bg-paper p-4 shadow-lift">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">{byok ? "Your OpenRouter key" : "Invitation access"}</h2>
            <Button variant="quiet" size="sm" onClick={() => setOpen(false)}>Close</Button>
          </div>
          {byok ? (
            <>
              <p className="text-sm leading-snug text-ink-muted">
                {access.hasKey ? "A key is ready in this browser." : "Add a key to use cloud checks. Your session and history are still here."}
              </p>
              <ProviderKeyForm compact onReady={() => setMessage(null)} />
              {access.hasKey ? (
                <Button variant="secondary" size="sm" onClick={() => { forgetProviderKey(); setMessage("Key forgotten. Your session and history are unchanged."); }}>
                  Forget key
                </Button>
              ) : null}
            </>
          ) : (
            <p className="text-sm leading-snug text-ink-muted">Cloud calls use this server&apos;s keys within your invitation allowance.</p>
          )}
          <p className="text-xs leading-snug text-ink-muted">To use another invite, sign out first. Signing out also forgets any browser key.</p>
          <Button variant="quiet" size="sm" onClick={() => void leave()} pending={pending}>{pending ? "Signing out…" : "Sign out"}</Button>
          {message ? <p role="status" className="text-sm leading-snug text-ink-muted">{message}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
