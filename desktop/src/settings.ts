import { byId, errorMessage, invoke, listen } from "./bridge";
import { remaining, type Overview } from "./types";

const checkKey = byId<HTMLButtonElement>("check-key");
const dictationKey = byId<HTMLButtonElement>("dictation-key");
const shortcutError = byId<HTMLParagraphElement>("shortcut-error");
const checkAsYouType = byId<HTMLInputElement>("check-as-you-type");
const accessibility = byId<HTMLButtonElement>("accessibility");
const microphone = byId<HTMLButtonElement>("microphone");
const keyLive = byId<HTMLParagraphElement>("key-live");
const status = byId<HTMLParagraphElement>("status");
const advanced = byId<HTMLDetailsElement>("advanced");
const serverForm = byId<HTMLFormElement>("server-form");
const server = byId<HTMLInputElement>("server");
const serverError = byId<HTMLParagraphElement>("server-error");
const openEditor = byId<HTMLButtonElement>("open-editor");
const resetWorkspace = byId<HTMLButtonElement>("reset-workspace");
const version = byId<HTMLSpanElement>("version");

let os = "";
let serverEdited = false;
// The button that is recording a new key.
let recording: HTMLButtonElement | null = null;

// Shortcut accelerators as people read them: ⌃⌥G on macOS, Ctrl+Alt+G elsewhere.
function keys(accelerator: string): string {
  if (accelerator.trim().toLowerCase() === "rightoption") return "right Option";
  return accelerator
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      switch (token.toUpperCase()) {
        case "CONTROL":
        case "CTRL":
          return os === "macos" ? "⌃" : "Ctrl";
        case "OPTION":
        case "ALT":
          return os === "macos" ? "⌥" : "Alt";
        case "SHIFT":
          return os === "macos" ? "⇧" : "Shift";
        case "COMMAND":
        case "CMD":
        case "SUPER":
          return os === "macos" ? "⌘" : "Super";
        default:
          return token.length === 1 ? token.toUpperCase() : token;
      }
    })
    .join(os === "macos" ? "" : "+");
}

function line(text: string, className: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  p.className = className;
  return p;
}

// One calm line about the workspace: what is left today, or what went wrong.
function renderStatus(overview: Overview) {
  const { account } = overview;
  const lines: HTMLElement[] = [];
  if (account.notice) lines.push(line(account.notice, "notice"));
  if (account.signedIn) {
    const checks = remaining(account.checks);
    const seconds = remaining(account.dictationSeconds);
    const parts: string[] = [];
    if (checks !== null) parts.push(`${checks} ${checks === 1 ? "check" : "checks"} left today`);
    if (seconds !== null) parts.push(`${Math.floor(seconds / 60)} min of dictation left`);
    if (parts.length) lines.push(line(parts.join(" · "), "hint"));
    if (!account.remembered) {
      lines.push(line("No system keychain is available, so this workspace lasts until gloss restarts.", "hint"));
    }
  }
  if (overview.shortcutError) lines.push(line(overview.shortcutError, "error"));
  status.replaceChildren(...lines);
}

function render(overview: Overview) {
  os = overview.os;
  checkKey.dataset.value = overview.settings.checkShortcut;
  dictationKey.dataset.value = overview.settings.dictationShortcut;
  if (!recording) {
    checkKey.textContent = keys(overview.settings.checkShortcut);
    dictationKey.textContent = keys(overview.settings.dictationShortcut);
  }
  renderStatus(overview);
  if (!serverEdited) server.value = overview.settings.serverUrl;
  // A saved address that does not match the default goes to the top section,
  // so a debug build is never mistaken for the public server without a word.
  if (overview.settings.serverUrl !== "http://localhost:3000" && overview.settings.serverUrl !== "https://gloss.li") {
    advanced.open = true;
  }
  // The permission rows are macOS-specific; elsewhere the system asks itself.
  const mac = overview.os === "macos";
  accessibility.closest(".permission-row")?.toggleAttribute("hidden", !mac);
  microphone.closest(".permission-row")?.toggleAttribute("hidden", !mac);
  keyLive.hidden = !overview.account.shortcutPressed;
  // Checking as you type needs the same Accessibility permission anyway.
  checkAsYouType.checked = overview.settings.checkAsYouType;
  checkAsYouType.closest("section")?.toggleAttribute("hidden", !mac);
  version.textContent = `Version ${overview.version}`;
}

async function run(button: HTMLButtonElement | null, error: HTMLElement | null, action: () => Promise<Overview>) {
  if (button) button.disabled = true;
  if (error) error.textContent = "";
  try {
    render(await action());
    return true;
  } catch (failure) {
    if (error) error.textContent = errorMessage(failure);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

server.addEventListener("input", () => {
  serverEdited = true;
});
serverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = serverForm.querySelector<HTMLButtonElement>("button[type=submit]");
  const ok = await run(submit, serverError, () => invoke<Overview>("save_server_url", { url: server.value }));
  if (ok) serverEdited = false;
});

accessibility.addEventListener("click", () => {
  void run(accessibility, null, () => invoke<Overview>("request_accessibility"));
});
microphone.addEventListener("click", () => void invoke("open_microphone_settings"));
openEditor.addEventListener("click", () => void invoke("open_editor"));
resetWorkspace.addEventListener("click", () => {
  void run(resetWorkspace, null, () => invoke<Overview>("reset_workspace"));
});

checkAsYouType.addEventListener("change", () => {
  void run(null, null, () =>
    invoke<Overview>("set_check_as_you_type", { enabled: checkAsYouType.checked }),
  );
});

// A shortcut is recorded by clicking it and pressing the keys together. While
// a field records, the global shortcuts and the dictation key are paused, so
// pressing the current ones records them instead of starting a check.
const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backslash: "Backslash",
  Minus: "Minus",
  Equal: "Equal",
  Backquote: "Backquote",
};

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return KEY_NAMES[code] ?? null;
}

function accelerator(event: KeyboardEvent, button: HTMLButtonElement): string | null {
  // The dictation key may be pressed alone; the check shortcut needs a modifier.
  if (button === dictationKey && event.code === "AltRight") return "RightOption";
  const key = keyName(event.code);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push(os === "macos" ? "Command" : "Super");
  return modifiers.length ? [...modifiers, key].join("+") : null;
}

function startRecording(button: HTMLButtonElement) {
  if (recording) stopRecording();
  recording = button;
  button.classList.add("recording");
  button.textContent = "Press the new keys";
  shortcutError.textContent = "";
  void invoke("suspend_shortcuts").catch(() => undefined);
}

function stopRecording() {
  if (!recording) return;
  recording.classList.remove("recording");
  recording = null;
  void invoke("resume_shortcuts").catch(() => undefined);
}

for (const button of [checkKey, dictationKey]) {
  button.addEventListener("click", () => startRecording(button));
  button.addEventListener("blur", () => {
    if (recording === button) {
      stopRecording();
      void invoke<Overview>("get_overview").then(render, () => undefined);
    }
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    if (event.key === "Escape") {
      stopRecording();
      void invoke<Overview>("get_overview").then(render, () => undefined);
      return;
    }
    event.preventDefault();
    const value = accelerator(event, button);
    if (!value) {
      if (!["Control", "Alt", "Shift", "Meta", "AltRight"].includes(event.key)) {
        shortcutError.textContent = "Hold Control, Alt or Command while you press the key.";
      }
      return;
    }
    button.textContent = keys(value);
    const check = button === checkKey ? value : (checkKey.dataset.value ?? "");
    const dictation = button === dictationKey ? value : (dictationKey.dataset.value ?? "");
    void invoke<Overview>("save_shortcuts", { check, dictation }).then(
      (overview) => {
        stopRecording();
        render(overview);
      },
      (failure) => {
        shortcutError.textContent = errorMessage(failure);
        button.classList.remove("recording");
        recording = null;
        void invoke("resume_shortcuts").catch(() => undefined);
        void invoke<Overview>("get_overview").then(render, () => undefined);
      },
    );
  });
}

// Coming back from System Settings should show a newly granted permission.
window.addEventListener("focus", () => {
  void invoke<Overview>("get_overview").then(render, () => undefined);
});

void listen<Overview>("overview", render);
void invoke<Overview>("get_overview").then(render);
void invoke<Overview>("refresh_account").then(render, () => undefined);
