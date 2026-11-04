"use client";

import { useId, useState, type FormEvent } from "react";
import { enrollByok } from "@/features/api/client";
import { forgetProviderKey, isProviderKey } from "@/features/api/access-store";
import { useAccess } from "@/features/api/use-access";
import { BrandName, BrandedText } from "./brand";
import { Button } from "./ui/button";

export function ProviderKeyForm({ onReady, compact = false }: { onReady?: () => void; compact?: boolean }) {
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
    setMessage(result.data.accessMode === "byok" ? "Your key is ready." : "Your shared demo workspace is already active. Your key was not saved.");
    onReady?.();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3 text-left">
      {!compact ? <h2 className="text-xl font-semibold">Use your own OpenRouter key</h2> : null}
      <p id={descriptionId} className="text-sm leading-snug text-ink-muted">
        Your key is stored only in this browser. For cloud requests, it passes temporarily through <BrandName /> to OpenRouter.
        The <BrandName /> server never saves it. OpenRouter charges your account for model use.
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
      {message ? <p role="status" className="text-sm leading-snug text-ink-muted"><BrandedText text={message} /></p> : null}
      {access.storageNotice ? <p role="status" className="text-sm leading-snug text-caution">{access.storageNotice}</p> : null}
    </form>
  );
}

export function SettingsPanel() {
  const access = useAccess();
  const byok = access.session?.accessMode === "byok";

  return (
    <section aria-labelledby="settings-title" className="mx-auto flex w-full max-w-xl flex-col gap-4 rounded-card border border-line bg-card p-5 shadow-card sm:p-7">
      <div>
        <p className="eyebrow">Settings</p>
        <h1 id="settings-title" className="mt-1 text-2xl font-semibold tracking-tight">Cloud access</h1>
      </div>
      {access.session ? (
        <p className="text-sm text-ink-muted">
          {byok
            ? access.hasKey ? "Your OpenRouter key is ready in this browser." : "Add your OpenRouter key to continue this workspace."
            : access.session.aiEnabled ? "The shared demo is active for this workspace." : "The shared demo is paused for this workspace."}
        </p>
      ) : null}
      <ProviderKeyForm compact />
      {byok && access.hasKey ? (
        <Button variant="secondary" size="sm" onClick={forgetProviderKey}>Forget key</Button>
      ) : null}
      {access.storageNotice ? <p role="status" className="text-sm leading-snug text-caution">{access.storageNotice}</p> : null}
    </section>
  );
}
