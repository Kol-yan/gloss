import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "./icons";

export type ButtonVariant = "primary" | "soft" | "secondary" | "quiet";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex shrink-0 select-none items-center justify-center gap-2 rounded-full font-semibold " +
  "transition duration-150 active:translate-y-px active:scale-[0.98] disabled:active:scale-100 disabled:active:translate-y-0";

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-on-accent shadow-lift hover:bg-accent-strong disabled:bg-line disabled:text-ink-muted disabled:shadow-none",
  // Low-emphasis action inside cards, so a screen keeps a single primary button.
  soft: "bg-accent-soft text-accent-strong hover:bg-accent hover:text-on-accent disabled:bg-line disabled:text-ink-muted",
  secondary:
    "border border-line-strong bg-card text-ink hover:bg-accent-soft disabled:border-line disabled:text-ink-muted disabled:hover:bg-card",
  quiet: "text-ink-muted underline-offset-4 hover:text-ink hover:underline disabled:no-underline",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-base",
};

// Shared with links that must look like buttons.
export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra = ""): string {
  const quietPadding = variant === "quiet" ? "px-2" : "";
  return [base, variants[variant], sizes[size], quietPadding, extra].filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  // Shows a spinner and disables the button; the label should say what is happening.
  pending?: boolean;
};

export function Button({
  variant = "secondary",
  size = "md",
  pending = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClasses(variant, size, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      {...rest}
    >
      {pending ? <Spinner size={size === "sm" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}
