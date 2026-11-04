import { DEFAULT_SETTINGS, readSettings, withSiteChecks } from "./lib/settings.mjs";
import { accountLines, checksLine, highlightLine } from "./lib/status.mjs";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let tab = null;
let page = null;

async function send(message) {
  try {
    return (await ext.runtime.sendMessage(message)) ?? { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

// The popup learns about the page from its content script, so it needs no
// permission to read tab addresses.
async function tabMessage(message) {
  if (!tab || tab.id === undefined) return null;
  try {
    return await ext.tabs.sendMessage(tab.id, message, { frameId: 0 });
  } catch {
    return null;
  }
}

function showHighlight(state) {
  $("highlight").checked = Boolean(state?.on);
  $("highlight-status").textContent = highlightLine(state);
}

function showChecks(checks) {
  $("site").textContent = page?.host ? `(${page.host})` : "";
  $("site-off").checked = Boolean(checks?.offHere);
  $("site-off").disabled = !page?.host || Boolean(checks?.isApp);
  $("checks-status").textContent = checksLine(checks);
}

async function loadAccount() {
  const lines = accountLines(await send({ type: "status" }));
  $("account").textContent = lines.text;
  $("account-note").textContent = lines.note;
  $("account-note").hidden = !lines.note;
  $("account-actions").hidden = !lines.openApp;
}

async function init() {
  void loadAccount();
  try {
    [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }
  page = await tabMessage({ type: "page-state" });
  if (!page?.ok) {
    page = null;
    $("highlight-status").textContent = "gloss cannot run on this page. If the page was open before gloss was installed or updated, reload it.";
    showChecks(null);
    return;
  }
  $("highlight").disabled = false;
  showHighlight(page.highlight);
  showChecks(page.checks);
}

$("highlight").addEventListener("change", async () => {
  const on = $("highlight").checked;
  $("highlight").disabled = true;
  $("highlight-status").textContent = on ? "Looking for your words…" : "";
  const answer = await tabMessage({ type: "highlight", on });
  showHighlight(answer?.ok ? answer.highlight : { on: false, error: "unavailable" });
  $("highlight").disabled = false;
});

$("site-off").addEventListener("change", async () => {
  const off = $("site-off").checked;
  try {
    const settings = readSettings(await ext.storage.local.get({ ...DEFAULT_SETTINGS, checksOffSites: [] }));
    await ext.storage.local.set({ checksOffSites: withSiteChecks(settings, page.host, off) });
    page.checks = { ...page.checks, offHere: off, on: !off && !page.checks.globalOff && !page.checks.isApp };
    showChecks(page.checks);
  } catch {
    $("site-off").checked = !off;
    $("checks-status").textContent = "The setting could not be saved. Please try again.";
  }
});

$("settings").addEventListener("click", async () => {
  try {
    await ext.runtime.openOptionsPage();
  } finally {
    window.close();
  }
});

for (const [id, target] of [["open-words", "words"], ["open-app", "app"]]) {
  $(id).addEventListener("click", async () => {
    await send({ type: "open", target });
    window.close();
  });
}

void init();
