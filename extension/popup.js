import { DEFAULT_SETTINGS, readSettings, withSiteChecks } from "./lib/settings.mjs";
import { accountLines, checksLine, highlightLine } from "./lib/status.mjs";
import { brandFragment } from "./lib/brand.mjs";

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

let tab = null;
let page = null;
let needsWorkspace = false;

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
  $("highlight-status").replaceChildren(brandFragment(highlightLine(state)));
}

function showChecks(checks) {
  $("controls-section").hidden = needsWorkspace && !page?.editor;
  const host = page?.host ?? null;
  $("site").textContent = host ?? "";
  $("site-off").checked = Boolean(host && checks && !checks.offHere);
  $("site-off").disabled = !checks || !host || Boolean(checks.isApp);
  $("checks-status").replaceChildren(brandFragment(checksLine(checks, page?.editor ?? null)));
}

// There is no sign-in screen anywhere: a browser without a gloss session gets
// one from the site itself, so the popup offers a single way forward.
async function loadAccount() {
  const status = await send({ type: "status" });
  const lines = accountLines(status);
  $("account").replaceChildren(brandFragment(lines.text));
  $("account-note").replaceChildren(brandFragment(lines.note));
  $("account-note").hidden = !lines.note;
  $("open-app-row").hidden = !lines.openApp;
  // Without a workspace neither switch can do anything, so the popup stays
  // down to the status line and one button.
  needsWorkspace = lines.openApp;
  $("controls-section").hidden = needsWorkspace && !page?.editor;
}

async function init() {
  void loadAccount();
  try {
    [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    tab ??= null;
  } catch {
    tab = null;
  }
  page = await tabMessage({ type: "page-state" });
  if (!page?.ok) {
    page = null;
    $("highlight-status").replaceChildren(brandFragment("gloss cannot run on this page. If the page was open before gloss was installed or updated, reload it."));
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
  $("highlight-status").textContent = on ? "Looking for My words…" : "";
  const answer = await tabMessage({ type: "highlight", on });
  showHighlight(answer?.ok ? answer.highlight : { on: false, error: "unavailable" });
  $("highlight").disabled = false;
});

$("site-off").addEventListener("change", async () => {
  const off = !$("site-off").checked;
  const host = page?.host;
  if (!host) return;
  try {
    const settings = readSettings(await ext.storage.local.get({ ...DEFAULT_SETTINGS, checksOffSites: [] }));
    await ext.storage.local.set({ checksOffSites: withSiteChecks(settings, host, off) });
    if (page) page.checks = { ...page.checks, offHere: off, on: !off && !page.checks.globalOff && !page.checks.isApp };
    showChecks(page?.checks ?? null);
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

$("open-app").addEventListener("click", async () => {
  await send({ type: "open", target: "app" });
  window.close();
});

void init();
