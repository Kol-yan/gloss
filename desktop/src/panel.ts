import { byId, errorMessage, invoke, listen } from "./bridge";
import { remaining, type PanelAction, type PanelView, type Suggestion } from "./types";
import { brandFragment } from "./brand";

const title = byId<HTMLSpanElement>("title");
const content = byId<HTMLElement>("content");
const actions = byId<HTMLElement>("actions");
const close = byId<HTMLButtonElement>("close");
const frame = document.querySelector<HTMLElement>(".frame");
// Matches the panel width in src-tauri/tauri.conf.json.
const PANEL_WIDTH = 440;

const CATEGORY_LABEL: Record<Suggestion["category"], string> = {
  error: "Fix",
  style: "Style",
  expression: "Expression",
};

const ACTION_LABEL: Record<PanelAction, string> = {
  openSettings: "Open settings",
  grantAccessibility: "Open Accessibility settings",
  openMicrophoneSettings: "Open Microphone settings",
};

let view: PanelView = { phase: "idle" };
let chosen = new Set<string>();
let previewRequest = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, kind: "primary" | "secondary" = "secondary"): HTMLButtonElement {
  const node = element("button", kind === "secondary" ? "secondary" : undefined, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function dismiss() {
  void invoke("panel_dismiss");
}

// Errors are clear fixes; style and expression ideas are optional, and an
// edit that may change the meaning is never chosen for the learner.
function chosenByDefault(suggestion: Suggestion): boolean {
  return suggestion.category === "error" && !suggestion.meaningChange;
}

function overlaps(a: Suggestion, b: Suggestion): boolean {
  return a.start < b.end && b.start < a.end;
}

function defaultChoice(suggestions: Suggestion[]): Set<string> {
  const picked: Suggestion[] = [];
  for (const suggestion of [...suggestions].sort((a, b) => a.start - b.start)) {
    if (chosenByDefault(suggestion) && !picked.some((other) => overlaps(other, suggestion))) picked.push(suggestion);
  }
  return new Set(picked.map((suggestion) => suggestion.id));
}

function render(next: PanelView) {
  view = next;
  if (next.phase === "ready") chosen = defaultChoice(next.suggestions);
  switch (next.phase) {
    case "idle":
      title.textContent = "gloss";
      content.replaceChildren();
      actions.replaceChildren();
      break;
    case "checking":
      renderChecking(next.preview);
      break;
    case "notice":
      renderNotice(next.title, next.detail, next.action);
      break;
    case "ready":
      renderReady(next.text, next.suggestions, remaining(next.quota));
      break;
  }
  fitWindow();
}

// Sizes the window to its content, so a short message gets a small panel and
// a long list scrolls inside the largest one.
function fitWindow() {
  if (!frame || view.phase === "idle") return;
  frame.classList.add("measure");
  // A hidden window may not have its real width yet; measure at the default.
  frame.style.width = window.innerWidth >= 300 ? "" : `${PANEL_WIDTH}px`;
  const height = Math.ceil(frame.getBoundingClientRect().height);
  frame.style.width = "";
  frame.classList.remove("measure");
  void invoke("panel_fit", { height }).catch(() => undefined);
}

// Measure again once the window is on screen and laid out.
window.addEventListener("focus", () => requestAnimationFrame(fitWindow));

function renderChecking(preview: string) {
  title.textContent = "Checking…";
  const spinner = element("div", "spinner");
  spinner.setAttribute("role", "progressbar");
  spinner.setAttribute("aria-label", "Checking");
  const status = element("div", "centered");
  const reading = element("p", "hint");
  reading.append(brandFragment("gloss is reading your text."));
  status.append(spinner, reading);
  content.replaceChildren(status, element("blockquote", "quote", preview));
  actions.replaceChildren(button("Cancel", dismiss));
}

function renderNotice(heading: string, detail: string, action: PanelAction | null) {
  title.textContent = "gloss";
  content.replaceChildren(element("h2", "notice-title", heading), element("p", undefined, detail));
  const buttons = [button("Close", dismiss)];
  if (action) buttons.push(button(ACTION_LABEL[action], () => void invoke("panel_action", { action }), "primary"));
  actions.replaceChildren(...buttons);
  buttons[buttons.length - 1].focus();
}

function markedText(text: string, suggestions: Suggestion[]): HTMLElement {
  const block = element("p", "source");
  const sorted = [...suggestions].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const suggestion of sorted) {
    if (suggestion.start < cursor) continue;
    block.append(text.slice(cursor, suggestion.start));
    const mark = element("mark", `mark-${suggestion.category}`, text.slice(suggestion.start, suggestion.end));
    mark.dataset.id = suggestion.id;
    block.append(mark);
    cursor = suggestion.end;
  }
  block.append(text.slice(cursor));
  return block;
}

function renderReady(text: string, suggestions: Suggestion[], checksLeft: number | null) {
  const left = checksLeft === null ? "" : `${checksLeft} ${checksLeft === 1 ? "check" : "checks"} left today`;
  if (suggestions.length === 0) {
    title.textContent = "Looks good";
    content.replaceChildren(
      element("h2", "notice-title", "No changes suggested"),
      element("blockquote", "quote", text),
      element("p", "hint", left),
    );
    const done = button("Done", dismiss, "primary");
    actions.replaceChildren(done);
    done.focus();
    return;
  }

  title.textContent = suggestions.length === 1 ? "1 suggestion" : `${suggestions.length} suggestions`;
  const list = element("ul", "suggestions");
  for (const suggestion of [...suggestions].sort((a, b) => a.start - b.start)) {
    list.append(card(suggestion, suggestions));
  }
  const result = element("div", "result");
  result.append(element("h3", undefined, "Result"), element("p", "result-text", text));
  content.replaceChildren(markedText(text, suggestions), list, result, element("p", "hint", left));

  const error = element("p", "error");
  error.setAttribute("role", "alert");
  const apply = button("Apply", () => void run(apply, error, "panel_apply"), "primary");
  apply.id = "apply";
  const copy = button("Copy", () => void run(copy, error, "panel_copy"));
  actions.replaceChildren(error, button("Cancel", dismiss), copy, apply);
  updateChoice();
}

function card(suggestion: Suggestion, all: Suggestion[]): HTMLLIElement {
  const item = element("li", `suggestion ${suggestion.category}`);
  const label = element("label");
  const box = element("input");
  box.type = "checkbox";
  box.checked = chosen.has(suggestion.id);
  box.dataset.id = suggestion.id;
  box.addEventListener("change", () => {
    if (box.checked) {
      chosen.add(suggestion.id);
      // Two edits of the same words cannot both apply.
      for (const other of all) if (other.id !== suggestion.id && overlaps(other, suggestion)) chosen.delete(other.id);
    } else {
      chosen.delete(suggestion.id);
    }
    updateChoice();
  });

  const body = element("span", "body");
  const change = element("span", "change");
  if (suggestion.original) change.append(element("del", undefined, suggestion.original));
  if (suggestion.original && suggestion.replacement) change.append(" → ");
  if (suggestion.replacement) change.append(element("ins", undefined, suggestion.replacement));
  if (!suggestion.replacement) change.append(element("span", "hint", " (remove)"));
  const meta = element("span", "meta");
  meta.append(element("span", `badge ${suggestion.category}`, CATEGORY_LABEL[suggestion.category]));
  if (suggestion.ipa) meta.append(element("span", "ipa", `/${suggestion.ipa}/`));
  body.append(meta, change);
  if (suggestion.reason) body.append(element("span", "reason", suggestion.reason));
  if (suggestion.meaning) body.append(element("span", "reason", suggestion.meaning));
  if (suggestion.meaningChange) body.append(element("span", "warning", "This may change what you meant. Check it before applying."));

  label.append(box, body);
  item.append(label);
  item.addEventListener("mouseenter", () => highlight(suggestion.id, true));
  item.addEventListener("mouseleave", () => highlight(suggestion.id, false));
  return item;
}

function highlight(id: string, on: boolean) {
  content.querySelector(`mark[data-id="${CSS.escape(id)}"]`)?.classList.toggle("active", on);
}

function updateChoice() {
  for (const box of content.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
    box.checked = chosen.has(box.dataset.id ?? "");
  }
  const apply = document.getElementById("apply") as HTMLButtonElement | null;
  if (apply) {
    apply.textContent = chosen.size === 0 ? "Apply" : chosen.size === 1 ? "Apply 1 change" : `Apply ${chosen.size} changes`;
    apply.disabled = chosen.size === 0;
  }
  const request = ++previewRequest;
  void invoke<string>("panel_preview", { chosen: [...chosen] }).then(
    (text) => {
      if (request !== previewRequest) return;
      const target = content.querySelector(".result-text");
      if (target) target.textContent = text;
    },
    () => undefined,
  );
}

async function run(trigger: HTMLButtonElement, error: HTMLElement, command: "panel_apply" | "panel_copy") {
  trigger.disabled = true;
  error.textContent = "";
  try {
    await invoke(command, { chosen: [...chosen] });
  } catch (failure) {
    error.textContent = errorMessage(failure);
    trigger.disabled = false;
  }
}

close.addEventListener("click", dismiss);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    dismiss();
  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && view.phase === "ready") {
    event.preventDefault();
    document.getElementById("apply")?.click();
  }
});

void listen<PanelView>("panel", render);
void invoke<PanelView>("panel_state").then(render);
