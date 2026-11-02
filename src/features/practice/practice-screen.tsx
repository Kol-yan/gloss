"use client";

import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { VoicePractice, type VoicePracticeProps } from "@/features/speech/voice-practice";
import { WrittenPractice, type WrittenPracticeProps } from "./written-practice";
import type { PracticeTask } from "./types";

export type PracticeScreenProps = {
  // Null when there is nothing to practise; the screen then says so and points to the editor.
  task: PracticeTask | null;
  written?: Pick<WrittenPracticeProps, "evaluate" | "initial">;
  voice?: Pick<VoicePracticeProps, "transcribe" | "evaluate">;
  onContinue?: () => void;
  onSkip?: () => void;
};

const noop = () => {};

export function PracticeScreen({ task, written, voice, onContinue = noop, onSkip = noop }: PracticeScreenProps) {
  if (!task) {
    return (
      <EmptyState
        eyebrow="Practice"
        title="Nothing to practice yet"
        action={
          <Link href="/" className={buttonClasses("primary")}>
            Open the editor
          </Link>
        }
      >
        Practice starts when you accept a suggestion in the editor and choose to try the expression yourself.
      </EmptyState>
    );
  }

  return task.kind === "written" ? (
    <WrittenPractice key={task.id} task={task} onContinue={onContinue} onSkip={onSkip} {...written} />
  ) : (
    <VoicePractice key={task.id} task={task} onContinue={onContinue} onSkip={onSkip} {...voice} />
  );
}
