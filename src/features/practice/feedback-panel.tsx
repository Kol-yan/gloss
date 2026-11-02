import { CheckIcon, CrossIcon, DashIcon, TildeIcon } from "@/components/ui/icons";
import { VERDICT_LABEL, type Feedback, type Verdict } from "./types";

// Verdicts differ by glyph and wording as well as colour. "Couldn't check" is
// neutral: when the model fails, that is never presented as the learner's miss.
const VERDICT_STYLE: Record<Verdict, { className: string; Icon: typeof CheckIcon }> = {
  used_well: { className: "bg-success-soft text-success", Icon: CheckIcon },
  almost: { className: "bg-caution-soft text-caution", Icon: TildeIcon },
  not_yet: { className: "bg-error-soft text-error", Icon: CrossIcon },
  unavailable: { className: "bg-neutral-soft text-neutral", Icon: DashIcon },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { className, Icon } = VERDICT_STYLE[verdict];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold ${className}`}>
      <Icon size={16} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function FeedbackPanel({
  feedback,
  answer,
  answerLabel = "Your answer",
}: {
  feedback: Feedback;
  answer: string;
  answerLabel?: string;
}) {
  return (
    <section
      aria-label="Feedback"
      aria-live="polite"
      className="flex flex-col gap-2.5 rounded-tile border border-line bg-card p-4 shadow-card"
    >
      <div>
        <VerdictBadge verdict={feedback.verdict} />
      </div>
      <div>
        <p className="eyebrow">{answerLabel}</p>
        <p className="mt-0.5 border-l-2 border-line-strong pl-3 text-base leading-snug [overflow-wrap:anywhere]">{answer}</p>
      </div>
      <p className="text-base leading-snug">{feedback.message}</p>
      {feedback.correction ? (
        <div className="rounded-chip bg-surface px-3 py-2">
          <p className="eyebrow">Try it like this</p>
          <p className="mt-0.5 text-base font-semibold leading-snug [overflow-wrap:anywhere]">{feedback.correction}</p>
        </div>
      ) : null}
    </section>
  );
}
