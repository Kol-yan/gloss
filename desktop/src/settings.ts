import { brandFragment } from "./brand";
import { byId, errorMessage, invoke, listen } from "./bridge";
import { remaining, type Overview } from "./types";

const status = byId<HTMLDivElement>("account-status");
const inviteForm = byId<HTMLFormElement>("invite-form");
const invite = byId<HTMLInputElement>("invite");
const sessionDetails = byId<HTMLDetailsElement>("session-details");
const sessionForm = byId<HTMLFormElement>("session-form");
const session = byId<HTMLInputElement>("session");
const signOut = byId<HTMLButtonElement>("sign-out");
const accountError = byId<HTMLParagraphElement>("account-error");
const serverForm = byId<HTMLFormElement>("server-form");
const server = byId<HTMLInputElement>("server");
const serverError = byId<HTMLParagraphElement>("server-error");
const shortcutForm = byId<HTMLFormElement>("shortcut-form");
const checkShortcut = byId<HTMLInputElement>("check-shortcut");
const dictationShortcut = byId<HTMLInputElement>("dictation-shortcut");
const shortcutError = byId<HTMLParagraphElement>("shortcut-error");
const permissions = byId<HTMLElement>("permissions");
const accessibilityState = byId<HTMLSpanElement>("accessibility-state");
const accessibility = byId<HTMLButtonElement>("accessibility");
const microphone = byId<HTMLButtonElement>("microphone");
const openEditor = byId<HTMLButtonElement>("open-editor");
const version = byId<HTMLSpanElement>("version");

let os = "";
// Fields the learner is editing are not overwritten by updates.
const edited = new Set<HTMLInputElement>();

function line(text: string, className?: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.append(brandFragment(text));
  if (className) p.className = className;
  return p;
}

function renderAccount(overview: Overview) {
  const { account } = overview;
  const lines: HTMLElement[] = [];
  if (account.signedIn) {
    const who = document.createElement("p");
    who.append("Signed in");
    if (account.displayName) {
      who.append(" as ");
      const name = document.createElement("strong");
      name.textContent = account.displayName;
      who.append(name);
    }
    lines.push(who);
    const checks = remaining(account.checks);
    const seconds = remaining(account.dictationSeconds);
    const parts: string[] = [];
    if (checks !== null) parts.push(`${checks} ${checks === 1 ? "check" : "checks"} left today`);
    if (seconds !== null) parts.push(`${Math.floor(seconds / 60)} min of dictation left`);
    if (parts.length) lines.push(line(parts.join(" · "), "hint"));
    if (!account.remembered) {
      lines.push(line("No system keychain is available, so you will sign in again after gloss restarts.", "hint"));
    }
  } else {
    lines.push(line("Not signed in. Paste your invite link below."));
  }
  if (account.notice) lines.push(line(account.notice, "notice"));
  status.replaceChildren(...lines);
  // To switch workspaces, the learner signs out first.
  signOut.hidden = !account.signedIn;
  inviteForm.hidden = account.signedIn;
  sessionDetails.hidden = account.signedIn;
}

function render(overview: Overview) {
  os = overview.os;
  renderAccount(overview);
  if (!edited.has(server)) server.value = overview.settings.serverUrl;
  if (!edited.has(checkShortcut)) checkShortcut.value = overview.settings.checkShortcut;
  if (!edited.has(dictationShortcut)) dictationShortcut.value = overview.settings.dictationShortcut;
  shortcutError.textContent = overview.shortcutError ?? "";
  permissions.hidden = overview.os !== "macos";
  const granted = overview.accessibility === "granted";
  accessibilityState.textContent = granted ? "Allowed" : "Not allowed";
  accessibilityState.classList.toggle("ok", granted);
  version.textContent = `Version ${overview.version}`;
}

async function run(button: HTMLButtonElement | null, error: HTMLElement, action: () => Promise<Overview>) {
  if (button) button.disabled = true;
  error.textContent = "";
  try {
    render(await action());
    return true;
  } catch (failure) {
    error.textContent = errorMessage(failure);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

function submitter(form: HTMLFormElement): HTMLButtonElement | null {
  return form.querySelector<HTMLButtonElement>("button[type=submit]");
}

inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const ok = await run(submitter(inviteForm), accountError, () => invoke<Overview>("sign_in_with_invite", { link: invite.value }));
  if (ok) invite.value = "";
});

sessionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const ok = await run(submitter(sessionForm), accountError, () => invoke<Overview>("sign_in_with_session", { token: session.value }));
  if (ok) {
    session.value = "";
    sessionDetails.open = false;
  }
});

signOut.addEventListener("click", () => {
  void run(signOut, accountError, () => invoke<Overview>("sign_out"));
});

server.addEventListener("input", () => edited.add(server));
serverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const ok = await run(submitter(serverForm), serverError, () => invoke<Overview>("save_server_url", { url: server.value }));
  if (ok) edited.delete(server);
});

// Shortcut fields record the keys pressed in them. While one has focus the
// global shortcuts are paused, so pressing the current ones records them
// instead of starting a check.
const keyNames: Record<string, string> = {
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
  return keyNames[code] ?? null;
}

function accelerator(event: KeyboardEvent): string | null {
  const key = keyName(event.code);
  if (!key) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push(os === "macos" ? "Command" : "Super");
  return modifiers.length ? [...modifiers, key].join("+") : null;
}

for (const field of [checkShortcut, dictationShortcut]) {
  field.addEventListener("focus", () => void invoke("suspend_shortcuts").catch(() => undefined));
  field.addEventListener("blur", () => void invoke("resume_shortcuts").catch(() => undefined));
  field.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
    event.preventDefault();
    const value = accelerator(event);
    if (value) {
      field.value = value;
      edited.add(field);
      shortcutError.textContent = "";
    } else if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
      shortcutError.textContent = "Hold Control, Alt or Command while you press the key.";
    }
  });
}

shortcutForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const ok = await run(submitter(shortcutForm), shortcutError, () =>
    invoke<Overview>("save_shortcuts", { check: checkShortcut.value, dictation: dictationShortcut.value }),
  );
  if (ok) {
    edited.delete(checkShortcut);
    edited.delete(dictationShortcut);
  }
});

accessibility.addEventListener("click", () => {
  void run(accessibility, accountError, () => invoke<Overview>("request_accessibility"));
});
microphone.addEventListener("click", () => void invoke("open_microphone_settings"));
openEditor.addEventListener("click", () => void invoke("open_editor"));

// Coming back from System Settings should show a newly granted permission.
window.addEventListener("focus", () => {
  void invoke<Overview>("get_overview").then(render, () => undefined);
});

void listen<Overview>("overview", render);
void invoke<Overview>("get_overview").then(render);
void invoke<Overview>("refresh_account").then(render, () => undefined);
