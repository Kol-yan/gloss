import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrandName } from "@/components/brand";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What the gloss website, browser extension and desktop app send, keep and never do with your text.",
};

const UPDATED = "5 November 2026";
const ISSUES = "https://github.com/Kol-yan/gloss/issues";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-1.5 pl-5">{children}</ul>;
}

// The policy covers the hosted service at gloss.li. It must stay true to the
// code: what each client sends is described in extension/store/data-disclosure.md
// and desktop/README.md, and what the server keeps in ARCHITECTURE.md.
export default function PrivacyPage() {
  return (
    <article className="mx-auto flex w-full max-w-2xl flex-col gap-7 px-4 py-8 text-base leading-relaxed text-ink sm:py-12">
      <header className="flex flex-col gap-2">
        <p className="eyebrow">Privacy</p>
        <h1 className="text-3xl font-semibold tracking-tight">Your text, your words</h1>
        <p className="text-ink-muted">
          This page explains what <BrandName /> does with your data on the website gloss.li, in the browser
          extension and in the desktop app. Last updated {UPDATED}.
        </p>
      </header>

      <Section id="short" title="In short">
        <List>
          <li>We use your text only to check your writing and to keep your word list and practice.</li>
          <li>Third-party AI model providers process the text to return suggestions.</li>
          <li>We do not store the full text you check. We keep the suggestions and your choices.</li>
          <li>We do not sell your data, show ads or use tracking or analytics tools.</li>
          <li>There is no sign-in. Your workspace is tied to a cookie in your browser or a file in the desktop app.</li>
        </List>
      </Section>

      <Section id="workspace" title="Your workspace">
        <p>
          The first time you open gloss.li, the site starts a free guest workspace and sets a session cookie
          (<code>glossy_session</code>). The cookie is renewed when you use gloss and expires after 365 days without use.
          To limit how many free workspaces one network can start, we keep a one-way hash of your IP address and the
          time. The site may show a Cloudflare Turnstile check to tell people from bots; Cloudflare processes that
          check under its own privacy policy.
        </p>
        <p>In your workspace we keep:</p>
        <List>
          <li>My words: the words and phrases you save, their meanings and your practice progress;</li>
          <li>for each writing check: a hash and the length of the text, the model used, the time and cost, and each
            suggestion (the short original fragment, the replacement and its reason) with your choice to apply or dismiss it;</li>
          <li>practice: the tasks, your written answers, the transcript of spoken answers and the feedback;</li>
          <li>usage counts for the daily allowance.</li>
        </List>
        <p>Audio is never stored. Server logs do not contain your text.</p>
      </Section>

      <Section id="models" title="AI models and your own key">
        <p>
          Third-party AI model providers process the text to return suggestions, practice tasks, feedback and
          transcripts. They receive only the text or audio needed for that request, not your workspace or who you are.
          We ask providers not to keep or train on the data where the routing service allows it.
        </p>
        <List>
          <li><strong>Free guest access:</strong> requests go out with the keys of the gloss operator, within daily limits.</li>
          <li><strong>Your own OpenRouter key:</strong> you can add it in Settings. The key is stored only in your browser.
            For each request it passes through the gloss server to OpenRouter and is never saved on the server.
            OpenRouter&apos;s terms apply and it charges your account.</li>
        </List>
      </Section>

      <Section id="website" title="Website">
        <p>
          The editor runs its first grammar and punctuation checks in your browser. When you pause typing or ask for a
          cloud check, the changed sentences go to the gloss server. If you add your own key, it is kept in your
          browser&apos;s local storage until you remove it.
        </p>
      </Section>

      <Section id="extension" title="Browser extension">
        <List>
          <li>While checks are on for a site, the text of the field you are typing in is sent to the gloss server
            after you pause typing.</li>
          <li>Password fields, fields for names, emails, card numbers and one-time codes, and read-only fields are never read.</li>
          <li><strong>Add to My words</strong> sends the word you selected. Apply and Dismiss send your choice.</li>
          <li>Highlighting My words downloads your word list and marks it on the page in your browser. Page text is not sent.</li>
          <li>No page address or title is sent. The extension stores only its settings on your device: the server
            address, whether checks are on, and the sites where you turned them off.</li>
          <li><strong>Check with gloss</strong> opens the editor with the selected text in the page address, so your
            browser history may keep it.</li>
        </List>
      </Section>

      <Section id="desktop" title="Desktop app">
        <List>
          <li>The app starts its own guest workspace and keeps the session in a file in its settings folder that only
            your user account can read.</li>
          <li>With <strong>Check as I type</strong> on, the text of the field you are typing in is sent after a pause.
            The check shortcut sends the text you selected.</li>
          <li>Dictation records only while you hold the key or until you stop it. The audio stays in memory, is sent to
            the gloss server for transcription and is not written to disk or stored.</li>
          <li>To read a selection or paste a fix, the app may use the clipboard for a moment and then puts your
            previous clipboard back.</li>
          <li>The app&apos;s logs do not contain your text, transcripts or session.</li>
        </List>
      </Section>

      <Section id="choices" title="Your choices">
        <List>
          <li>Turn checks off for one site in the extension popup, or everywhere in its settings or the desktop app&apos;s settings.</li>
          <li>Remove your own key in Settings at any time.</li>
          <li>Clearing the gloss cookie, removing the extension or deleting the app&apos;s session file disconnects you
            from the workspace.</li>
          <li>To have your workspace deleted, open an issue at{" "}
            <a href={ISSUES} className="font-semibold text-accent-strong underline underline-offset-3">github.com/Kol-yan/gloss/issues</a>{" "}
            without posting any of your text. We will reply with a private way to identify the workspace and then delete it.</li>
        </List>
      </Section>

      <Section id="other" title="Other servers, children and changes">
        <p>
          gloss is open source. If you use a gloss server that someone else runs, that operator decides what it keeps
          and this page does not apply to it. gloss is not meant for children under 13. If this page changes, the date
          above changes with it.
        </p>
      </Section>

      <p className="text-sm text-ink-muted">
        <Link href="/" className="font-semibold text-accent-strong underline underline-offset-3">Back to gloss</Link>
      </p>
    </article>
  );
}
