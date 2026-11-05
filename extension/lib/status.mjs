// Short, learner-facing status lines for the toolbar popup.

const ACCOUNT_ERRORS = {
  settings: "Set your gloss server address in Settings.",
  not_allowed: "Allow gloss to reach your server in Settings.",
  unreachable: "Your gloss server is not answering. Check that it is running.",
  signed_out: "Open gloss to start writing.",
};

export function accountLines(status) {
  if (!status?.ok) {
    return {
      text: ACCOUNT_ERRORS[status?.error] ?? "gloss is not available right now. Please try again.",
      note: "",
      openApp: status?.error === "signed_out",
    };
  }
  const who = status.name ? `Signed in as ${status.name}` : "Signed in";
  const left = status.checks ? Math.max(0, status.checks.limit - status.checks.used) : null;
  const text = left === null ? who : `${who} · ${left} of ${status.checks.limit} checks left today`;
  let note = "";
  // A visitor workspace pays with a key kept in the editor tab; the
  // extension never sees it, so it cannot run cloud checks for them.
  if (status.byok) note = "Writing checks need hosted access. Your workspace uses its own key, which stays in the editor.";
  else if (!status.aiEnabled) note = "Cloud checks are paused right now.";
  return { text, note, openApp: false };
}

const HIGHLIGHT_ERRORS = {
  unsupported: "This browser cannot highlight words yet.",
  signed_out: "Sign in to gloss to see your words here.",
  settings: "Set your gloss server address in Settings.",
  not_allowed: "Allow gloss to reach your server in Settings.",
  unreachable: "Your gloss server is not answering.",
};

export function highlightLine(state) {
  if (!state?.on) {
    return state?.error
      ? HIGHLIGHT_ERRORS[state.error] ?? "Your words could not be loaded. Please try again."
      : "On this page only. Nothing about the page is saved.";
  }
  if (state.words === 0) return "My words is empty. Select a word on a page and choose Add to gloss.";
  if (state.matches === 0) return "None of your words are on this page.";
  return state.matches === 1 ? "1 of your words is marked on this page." : `${state.matches} of your words are marked on this page.`;
}

// Model-backed editors need a dedicated adapter before gloss can edit them.
/** @param {string | null} [editor] */
export function checksLine(checks, editor = null) {
  if (!checks) return "";
  if (checks.isApp) return "The gloss editor checks your writing itself.";
  if (["Ace", "Monaco", "CodeMirror"].includes(editor)) return "This kind of editor is not supported yet";
  if (checks.globalOff) return "Writing checks are off on all sites. Turn them on in Settings.";
  if (checks.offHere) return "gloss does not check text fields on this site.";
  return "Text fields are checked after you pause typing.";
}
