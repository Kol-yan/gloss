import type { WordLineMode } from "./word-line";

type Point = [number, number];
type Dot = {
  el: HTMLSpanElement; zone: "passive" | "active"; word: string;
  x: number; y: number; px: number; py: number; phase: number; born: number;
  label?: { el: HTMLSpanElement; start: number; until: number };
  crossing?: { from: Point; ctrl: Point; to: Point; start: number; trail: SVGPathElement };
  leaving?: number; hover?: boolean;
};
const passiveWords = ["meticulous", "albeit", "nuance", "tentative", "cumbersome", "scrutiny", "inevitable", "subtle", "prone to", "brush up on", "take for granted", "feasible", "convey", "resilient", "hinder", "undermine", "compelling", "daunting", "pitfall", "consensus", "mundane", "nonetheless", "grasp", "setback", "endeavor", "concise", "elaborate", "thrive", "vague", "bias", "overwhelm", "outcome", "assess", "reluctant", "thorough", "come across", "bottleneck"];
const activeWords = ["make", "help", "think", "really", "work", "good", "time", "easy", "maybe", "friend", "start", "need", "talk", "learn", "plan", "great", "home", "idea"];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t < .5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
const curve = (a: Point, b: Point, c: Point, t: number): Point => [
  (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * b[0] + t ** 2 * c[0],
  (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * b[1] + t ** 2 * c[1],
];

// This controller owns only the illustration's DOM, and releases every frame and animation.
export function animateWordLine(line: HTMLDivElement, mode: WordLineMode, reduced: boolean, resized: boolean) {
  const band = line.querySelector<HTMLElement>(".wl-band")!;
  const layer = line.querySelector<HTMLElement>(".wl-dots")!;
  const svg = line.querySelector<SVGSVGElement>(".wl-arrow")!;
  const w = band.clientWidth, h = band.clientHeight, boundary = w * .62;
  const animations: Animation[] = [];
  const liveAnimations = new Set<Animation>();
  const animate = (el: Element | null, frames: Keyframe[], duration: number, delay = 0, easing = "ease-out") => {
    if (el) animations.push(el.animate(frames, { duration, delay, easing, fill: "both" }));
  };
  let seed = 2207;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let raf = 0;
  let now = performance.now();
  const start = now;
  const labels = document.createElement("div");
  labels.className = "wl-words";
  labels.ariaHidden = "true";
  band.append(labels);
  layer.replaceChildren(); svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  line.classList.remove("is-morphed");
  const dots: Dot[] = [];
  const chips = [...line.querySelectorAll<HTMLElement>(".wl-chip")];
  const corridor = chips.length ? Math.max(...chips.map(chip => chip.offsetWidth)) / 2 + 10 : 14;
  const addDot = (zone: Dot["zone"], x: number, y: number, born = start) => {
    const el = document.createElement("span");
    el.className = `wl-dot is-${zone}`;
    const pool = zone === "passive" ? passiveWords : activeWords;
    const dot: Dot = { el, zone, x, y, px: x, py: y, born, phase: rand() * Math.PI * 2, word: pool[dots.filter(d => d.zone === zone).length % pool.length] };
    el.style.left = `${x - 3}px`; el.style.top = `${y - 3}px`;
    el.onmouseenter = () => { dot.hover = true; showLabel(dot, Infinity); };
    el.onmouseleave = () => { dot.hover = false; if (dot.label) dot.label.until = now; };
    layer.append(el); dots.push(dot); return dot;
  };
  function showLabel(dot: Dot, duration: number) {
    if (dot.label) { dot.label.until = Math.max(dot.label.until, now + duration); return; }
    const el = document.createElement("span");
    el.className = `wl-word is-${dot.zone}`; el.textContent = dot.word;
    labels.append(el); dot.label = { el, start: now, until: now + duration };
  }
  for (const zone of ["passive", "active"] as const) {
    const count = zone === "passive" ? 34 : 10;
    const cols = zone === "passive" ? 8 : 3;
    const lo = zone === "passive" ? 14 : boundary + corridor;
    const hi = zone === "passive" ? boundary - corridor : w - 14;
    const cells = Array.from({ length: cols * 5 }, (_, i) => i);
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    cells.slice(0, count).forEach(cell => addDot(zone, lo + (cell % cols + .3 + rand() * .4) / cols * (hi - lo), 12 + (Math.floor(cell / cols) + .3 + rand() * .4) / 5 * (h - 24), start - rand() * 20000));
  }
  if (reduced && mode === "welcome") {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", `M ${w * .48} ${h * .7} Q ${w * .6} ${h * .1} ${w * .76} ${h * .55} l -8 -2 m 8 2 l -3 -8`);
    svg.append(path);
  }
  if (mode === "ready") {
    const bar = line.querySelector<HTMLElement>(".morph-bar")!;
    const caption = line.querySelector<HTMLElement>(".morph-caption")!;
    const lede = line.closest(".onboarding-window")?.querySelector<HTMLElement>(".ready-lede") ?? null;
    const button = line.closest(".onboarding-window")?.querySelector<HTMLElement>(".onb-next") ?? null;
    const final = { left: "50%", top: "50%", width: "8px", height: `${Math.min(w - 56, 520)}px`, transform: "translate(-50%, -50%) rotate(-90deg)" };
    const initial = { left: `${boundary}px`, top: "50%", width: "2px", height: `${h}px`, transform: "translate(-50%, -50%) rotate(0deg)" };
    Object.assign(bar.style, final);
    caption.style.top = `${h / 2 + 16}px`;
    if (reduced || resized) {
      line.classList.add("is-morphed");
    } else {
      const fade = (el: Element | null, delay: number, duration = 400) => animate(el, [{ opacity: 1 }, { opacity: 0 }], duration, delay);
      fade(line.querySelector(".wl-boundary"), 0, 1);
      chips.forEach((chip, i) => animate(chip, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.7)" }], 380, 250 + i * 70));
      dots.forEach(dot => animate(dot.el, [{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${boundary - dot.x}px,0) scale(.4)`, opacity: 0 }], 650, 320 + Math.abs(dot.x - boundary) / w * 420, "cubic-bezier(.55,0,.75,.3)"));
      line.querySelectorAll(".wl-zone").forEach(zone => fade(zone, 760, 520));
      fade(line.querySelector(".wl-labels"), 600);
      animate(bar, [initial, { ...initial, left: "50%", transform: final.transform, offset: .42 }, final], 1500, 1100, "cubic-bezier(.65,0,.35,1)");
      [...bar.children].slice(1).forEach((el, i) => animate(el, [{ background: "#0d7a72" }, { background: "#d6efe8" }], 420, 2450 + i * 45));
      animate(caption, [{ opacity: 0 }, { opacity: 1 }], 480, 2600);
      animate(lede, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }], 480, 2750);
      animate(button, [{ transform: "scale(1)" }, { transform: "scale(1.045)" }, { transform: "scale(1)" }], 520, 3250);
    }
  } else if (!reduced) {
    if (mode === "map") chips.forEach((chip, i) => {
      const from = dots.filter(dot => dot.zone === "passive").sort((a, b) => b.x - a.x)[i];
      if (!from) return;
      const box = chip.getBoundingClientRect(), frame = band.getBoundingClientRect();
      from.el.remove();
      dots.splice(dots.indexOf(from), 1);
      animate(chip, [{ transform: `translate(${from.x - box.left + frame.left - box.width / 2}px,${from.y - box.top + frame.top - box.height / 2}px) scale(.08)`, background: "#c8bca9", color: "transparent" }, { transform: "translate(0,0) scale(1)", background: "#fffdf8", color: "#0a665f" }], 950, 300 + i * 240, "cubic-bezier(.2,.8,.2,1)");
    });
    let nextLabel = start + (mode === "welcome" ? 700 : 2600), nextCross = start + 1400, turn = 0;
    const frame = (time: number) => {
      now = time;
      if (document.hidden) { raf = requestAnimationFrame(frame); return; }
      const t = (now - start) / 1000;
      if (now >= nextLabel) {
        const zone = mode === "welcome" && turn++ % 3 === 2 ? "active" : "passive";
        const candidates = dots.filter(d => d.zone === zone && !d.label && !d.crossing && !d.leaving);
        const dot = candidates[Math.floor(rand() * candidates.length)];
        if (dot) showLabel(dot, 1500);
        nextLabel = now + (mode === "welcome" ? 1400 + rand() * 700 : 2600 + rand() * 900);
      }
      if (mode === "welcome" && now >= nextCross) {
        const candidates = dots.filter(d => d.zone === "passive" && d.x > boundary * .62 && !d.crossing && !d.leaving && !d.hover);
        const dot = candidates[Math.floor(rand() * candidates.length)];
        if (dot) {
          const from: Point = [dot.px, dot.py], to: Point = [boundary + 18 + rand() * (w - boundary - 32), 14 + rand() * (h - 28)];
          const ctrl: Point = [(from[0] + to[0]) / 2, Math.max(8, (from[1] + to[1]) / 2 - Math.abs(to[0] - from[0]) * .38)];
          const trail = document.createElementNS("http://www.w3.org/2000/svg", "path");
          trail.setAttribute("d", `M${from} Q${ctrl} ${to}`); trail.classList.add("wl-trail"); svg.append(trail);
          dot.crossing = { from, to, ctrl, start: now, trail }; showLabel(dot, 2700);
        }
        nextCross = now + 3600 + rand() * 900;
      }
      for (let i = dots.length - 1; i >= 0; i--) {
        const dot = dots[i];
        dot.px = dot.x + Math.sin(t * .65 + dot.phase) * 2.2;
        dot.py = dot.y + Math.cos(t * .52 + dot.phase * 1.3) * 1.5;
        if (dot.crossing) {
          const cross = dot.crossing, k = ease(clamp((now - cross.start) / 1900));
          [dot.px, dot.py] = curve(cross.from, cross.ctrl, cross.to, k);
          dot.el.style.background = `rgb(${[200,188,169].map((n, j) => Math.round(lerp(n, [13,122,114][j], k))).join(",")})`;
          cross.trail.style.strokeDasharray = `${k * cross.trail.getTotalLength()} 1000`;
          if (k === 1) {
            dot.zone = "active"; dot.x = cross.to[0]; dot.y = cross.to[1]; dot.born = now;
            dot.el.className = "wl-dot is-active"; dot.label?.el.classList.replace("is-passive", "is-active");
            animate(cross.trail, [{ opacity: .5 }, { opacity: 0 }], 800);
            // Remove completed trails without retaining an unbounded animation list.
            const trailAnimation = animations.pop();
            if (trailAnimation) {
              liveAnimations.add(trailAnimation);
              trailAnimation.onfinish = () => { cross.trail.remove(); trailAnimation.cancel(); liveAnimations.delete(trailAnimation); };
            }
            dot.crossing = undefined;
            const oldest = dots.filter(d => d.zone === "active" && d !== dot && !d.leaving && !d.hover).sort((a,b) => a.born - b.born)[0];
            if (oldest) oldest.leaving = now + 600;
            addDot("passive", 14 + rand() * boundary * .75, 14 + rand() * (h - 28), now + 1100);
          }
        }
        let alpha = clamp((now - dot.born) / 900);
        if (dot.leaving) alpha = 1 - clamp((now - dot.leaving) / 900);
        dot.el.style.opacity = `${alpha}`;
        const half = dot.zone === "active" ? 3.5 : 3;
        dot.el.style.left = "0"; dot.el.style.top = "0";
        dot.el.style.transform = `translate3d(${dot.px - half}px,${dot.py - half}px,0)`;
        if (dot.label) {
          const label = dot.label;
          const opacity = Math.min(clamp((now - label.start) / 260), 1 - clamp((now - label.until) / 320));
          label.el.style.opacity = `${opacity}`;
          label.el.style.transform = `translate(${Math.max(6, Math.min(w - label.el.offsetWidth - 6, dot.px - label.el.offsetWidth / 2))}px,${dot.py > 30 ? dot.py - 28 : dot.py + 7}px)`;
          if (now > label.until && opacity === 0) { label.el.remove(); dot.label = undefined; }
        }
        if (dot.leaving && alpha === 0) { dot.el.remove(); dot.label?.el.remove(); dots.splice(i, 1); }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  return () => { cancelAnimationFrame(raf); animations.forEach(a => a.cancel()); liveAnimations.forEach(a => a.cancel()); labels.remove(); layer.replaceChildren(); svg.replaceChildren(); line.classList.remove("is-morphed"); };
}
