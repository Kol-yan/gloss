"use client";

import { useEffect, useRef } from "react";
import { animateWordLine } from "./word-line-motion";

export type WordLineMode = "welcome" | "map" | "ready";

export function WordLine({ mode, words = [] }: { mode: WordLineMode; words?: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const wordKey = words.join("\u0000");
  useEffect(() => {
    const line = ref.current;
    if (!line) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let stop = () => {};
    let width = 0;
    const start = (resized = false) => {
      stop();
      stop = animateWordLine(line, mode, media.matches || new URLSearchParams(location.search).get("motion") === "off", resized);
    };
    start();
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (width && width !== next) start(true);
      width = next;
    });
    observer.observe(line);
    const change = () => start();
    const resize = () => start(true);
    media.addEventListener("change", change);
    window.addEventListener("resize", resize);
    return () => { stop(); observer.disconnect(); media.removeEventListener("change", change); window.removeEventListener("resize", resize); };
  }, [mode, wordKey]);

  return (
    <div ref={ref} className={`word-line word-line-${mode}`} data-mode={mode}>
      <div className="wl-labels">
        <div><b>Passive</b>{mode === "welcome" && <span>you understand them</span>}</div>
        <div><b>Active</b>{mode === "welcome" && <span>you say and write them</span>}</div>
      </div>
      <div className="wl-band" role="img" aria-label={mode === "ready" ? "First practice: 8 words" : "Words move from understanding into active use"}>
        <div className="wl-zone is-passive" /><div className="wl-zone is-active" />
        <span className="wl-boundary" />
        <div className="wl-dots" aria-hidden="true" />
        {mode !== "welcome" && <ul className="wl-chips">{words.map(word => <li className="wl-chip" key={word}>{word}</li>)}</ul>}
        <svg className="wl-arrow" aria-hidden="true" />
        {mode === "ready" && <><div className="morph-bar" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <i key={i} />)}</div><p className="morph-caption">{words.length ? `Starts with ${words.join(", ")}` : "Your practice starts here"}</p></>}
      </div>
    </div>
  );
}
