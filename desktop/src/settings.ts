import { byId, errorMessage, invoke, listen } from "./bridge";
import { remaining, type Overview } from "./types";

const checkKey = byId<HTMLButtonElement>("check-key");
const dictationKey = byId<HTMLButtonElement>("dictation-key");
const resetShortcuts = byId<HTMLButtonElement>("reset-shortcuts");
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
      lines.push(line("The workspace could not be saved, so it lasts until gloss restarts.", "hint"));
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
// a field records, global shortcuts are paused; the Option monitor ignores
// this app's focused windows, so recording never starts dictation.
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
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return KEY_NAMES[code] ?? null;
}

function accelerator(event: KeyboardEvent): string | null {
  // Plain typing keys cannot become a global shortcut.
  const key = keyName(event.code);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push(os === "macos" ? "Command" : "Super");
  return modifiers.length ? [...modifiers, key].join("+") : null;
}

// Serialize the native pause/save/resume calls. A blur or Escape must never
// resume an old registration after a successful save of a new shortcut.
let shortcutOperation = Promise.resolve();
let shortcutBusy = false;
let rightOptionCandidate = false;

function queueShortcut(action: () => Promise<void>) {
  shortcutOperation = shortcutOperation.then(action).catch((failure) => {
    shortcutError.textContent = errorMessage(failure);
  });
}

function clearRecording() {
  if (recording) {
    recording.classList.remove("recording");
    recording.textContent = keys(recording.dataset.value ?? "");
  }
  recording = null;
  rightOptionCandidate = false;
}

function startRecording(button: HTMLButtonElement) {
  if (shortcutBusy) return;
  clearRecording();
  recording = button;
  button.classList.add("recording");
  button.textContent = "Press keys · Esc cancels";
  shortcutError.textContent = "";
  shortcutBusy = true;
  queueShortcut(async () => {
    try {
      await invoke("suspend_shortcuts");
    } catch (failure) {
      clearRecording();
      render(await invoke<Overview>("resume_shortcuts"));
      throw failure;
    } finally {
      shortcutBusy = false;
    }
  });
}

function cancelRecording() {
  if (!recording) return;
  clearRecording();
  shortcutBusy = true;
  queueShortcut(async () => {
    try {
      render(await invoke<Overview>("resume_shortcuts"));
    } finally {
      shortcutBusy = false;
    }
  });
}

function saveShortcut(check: string, dictation: string) {
  clearRecording();
  shortcutBusy = true;
  queueShortcut(async () => {
    try {
      render(await invoke<Overview>("save_shortcuts", { check, dictation }));
    } catch (failure) {
      // The backend keeps the previous settings and restores registration.
      render(await invoke<Overview>("resume_shortcuts"));
      throw failure;
    } finally {
      shortcutBusy = false;
    }
  });
}

function acceptShortcut(button: HTMLButtonElement, value: string) {
  saveShortcut(
    button === checkKey ? value : (checkKey.dataset.value ?? ""),
    button === dictationKey ? value : (dictationKey.dataset.value ?? ""),
  );
}

for (const button of [checkKey, dictationKey]) {
  button.addEventListener("click", () => startRecording(button));
}

// Only explicit recording can change saved keys; Enter/Space that activates
// the button must not itself select a shortcut.
window.addEventListener("keydown", (event) => {
  if (!recording) return;
  if (event.key === "Escape") {
    event.preventDefault();
    cancelRecording();
    return;
  }
  if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    cancelRecording();
    return;
  }
  event.preventDefault();
  if (shortcutBusy || event.repeat) return;
  if (recording === dictationKey && os === "macos" && event.code === "AltRight"
      && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    // Wait for release, so right Option can also be part of a combination.
    rightOptionCandidate = true;
    recording.textContent = "right Option";
    return;
  }
  rightOptionCandidate = false;
  const value = accelerator(event);
  if (value) {
    acceptShortcut(recording, value);
  } else if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
    shortcutError.textContent = "Hold Control, Alt or Command while you press the key.";
  }
}, true);

window.addEventListener("keyup", (event) => {
  if (recording && !shortcutBusy && rightOptionCandidate && event.code === "AltRight") {
    event.preventDefault();
    acceptShortcut(recording, "RightOption");
  }
}, true);

window.addEventListener("blur", cancelRecording);
resetShortcuts.addEventListener("click", () => {
  if (shortcutBusy) return;
  shortcutError.textContent = "";
  saveShortcut("Control+Alt+G", os === "macos" ? "RightOption" : "Control+Alt+D");
});

// Coming back from System Settings should show a newly granted permission.
window.addEventListener("focus", () => {
  void invoke<Overview>("get_overview").then(render, () => undefined);
});

void listen<Overview>("overview", render);
void invoke<Overview>("get_overview").then(render);
void invoke<Overview>("refresh_account").then(render, () => undefined);
