import Link from "next/link";
import { BrandLockup, BrandedText } from "@/components/brand";
import { WordLine } from "@/features/onboarding/word-line";
import { ToolIcon } from "@/features/onboarding/tool-icon";
import { buttonClasses } from "@/components/ui/button";
import { CaptureHandoff } from "./capture-handoff";
import "./landing.css";


const GITHUB = "https://github.com/Kol-yan/gloss";

const TOOLS = [
  {
    icon: "browser",
    title: "Chrome extension",
    line: "checks every text field",
    href: `${GITHUB}#browser-extension`,
    label: "Install the extension",
  },
  {
    icon: "laptop",
    title: "Mac app",
    line: "dictate and check in any app",
    href: `${GITHUB}#desktop-app`,
    label: "Get the Mac app",
  },
  {
    icon: "highlighter",
    title: "Editor",
    line: "paste text and check it",
    href: "/editor",
    label: "Open the editor",
  },
] as const;

// The landing page is one quiet column of type; the living word line carries the brand.
export function Landing({ startPracticeHref }: { startPracticeHref: string }) {
  return (
    <div className="landing">
      <CaptureHandoff />
      <section className="landing-hero" aria-labelledby="landing-headline">
        <div className="landing-inner">
          <Link href="/" className="landing-lockup" aria-label="gloss home">
            <BrandLockup />
          </Link>
          <h1 id="landing-headline">Write it right. Then make the words your own.</h1>
          <p className="landing-lede">
            <BrandedText text="gloss checks your English as you type, everywhere, and turns the words you understand into words you use." />
          </p>
          <div className="landing-actions">
            <Link href={startPracticeHref} className={buttonClasses("primary", "md")}>Start practising</Link>
            <a href="#tools" className={buttonClasses("quiet", "md", "landing-scroll")}>Get the tools</a>
          </div>
        </div>
        <div className="landing-river">
          <WordLine mode="welcome" />
        </div>
      </section>

      <section id="tools" aria-labelledby="landing-tools-title" className="landing-tools">
        <div className="landing-inner">
          <h2 id="landing-tools-title">Where to use it</h2>
          <ul>
            {TOOLS.map((tool) => (
              <li key={tool.title}>
                <span className="landing-tool-icon" aria-hidden="true"><ToolIcon name={tool.icon} size={16} /></span>
                <span className="landing-tool-text">
                  <b>{tool.title}</b> — {tool.line}
                </span>
                <Link href={tool.href} aria-label={tool.label} className="landing-tool-link">
                  {tool.href.startsWith("/") ? "Open" : "Get"}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-inner">
          <span><BrandedText text="Made to make your words your own." /></span>
          <span className="landing-footer-links">
            <Link href="/privacy">Privacy</Link>
            <a href={GITHUB}>GitHub</a>
          </span>
        </div>
      </footer>
    </div>
  );
}
