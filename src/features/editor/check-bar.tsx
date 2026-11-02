"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertIcon, SparkIcon } from "@/components/ui/icons";
import { MAX_TEXT_LENGTH } from "@/shared/contracts";
import type { CheckStatus } from "./types";

const MESSAGES: Partial<Record<CheckStatus, ReactNode>> = {
  pending: "Checking your text…",
  failed: "We couldn't check your text just now. Your text is safe. Try again.",
  quota: (
    <>
      You&apos;ve used all of today&apos;s AI checks. They come back tomorrow.{" "}
      <Link href="/practice" className="font-semibold text-accent underline underline-offset-2">
        Practice instead
      </Link>
    </>
  ),
  unavailable: "AI checking isn't available today. Checks on this device still work.",
};

export function CheckBar({
  status,
  checksLeft,
  textIsEmpty,
  length,
  suggestionCount,
  onCheck,
  onOpenSheet,
}: {
  status: CheckStatus;
  // null when the number is unknown; the slot is then hidden.
  checksLeft: number | null;
  textIsEmpty: boolean;
  length: number;
  suggestionCount: number;
  onCheck: () => void;
  onOpenSheet: () => void;
}) {
  // An empty editor explains itself; the "unavailable" note only matters once there is text to check.
  const message = status === "unavailable" && textIsEmpty ? undefined : MESSAGES[status];
  const blocked = status === "quota" || status === "unavailable";
  const pending = status === "pending";
  const nearLimit = length >= MAX_TEXT_LENGTH * 0.8;

  const slotParts: string[] = [];
  if (checksLeft !== null) slotParts.push(`${checksLeft} ${checksLeft === 1 ? "check" : "checks"} left today`);
  if (nearLimit) slotParts.push(`${length.toLocaleString("en-US")} / ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters`);

  return (
    <div className="relative shrink-0 border-t border-line bg-paper/95 px-4 py-2.5">
      {pending ? (
        <div
          role="progressbar"
          aria-label="Checking your text"
          className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-accent-soft"
        >
          <div className="h-full w-1/4 animate-slide bg-accent" />
        </div>
      ) : null}

      {message ? (
        <p
          role={status === "failed" ? "alert" : "status"}
          className={
            "mb-2 flex items-start gap-1.5 text-sm leading-snug " +
            (status === "pending" ? "text-ink-muted" : "text-caution")
          }
        >
          {status === "pending" ? null : <AlertIcon size={16} className="mt-0.5 shrink-0" />}
          <span>{message}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-2 @3xl:flex-row @3xl:items-center @3xl:justify-between">
        <p
          id="editor-limit"
          className={"min-h-4 text-xs tabular-nums text-ink-muted " + (checksLeft === 0 ? "font-semibold text-caution" : "")}
        >
          {slotParts.join(" · ")}
        </p>
        <div className="flex items-center justify-end gap-2">
          {suggestionCount > 0 ? (
            <Button className="@3xl:hidden" variant="secondary" onClick={onOpenSheet}>
              {suggestionCount} {suggestionCount === 1 ? "suggestion" : "suggestions"}
            </Button>
          ) : null}
          <Button
            variant="primary"
            onClick={onCheck}
            pending={pending}
            disabled={textIsEmpty || blocked}
          >
            {pending ? null : <SparkIcon size={16} />}
            {pending ? "Checking…" : status === "failed" ? "Try again" : "Check with AI"}
          </Button>
        </div>
      </div>
    </div>
  );
}
