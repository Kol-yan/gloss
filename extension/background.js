import {
  ADD_MENU_ID,
  buildCaptureUrl,
  MENU_ID,
  normalizeSelection,
  originPermission,
  parseAppOrigin,
  prepareWord,
} from "./capture.mjs";
import { createApi } from "./lib/api.mjs";
import { createRouter, saveToast, selectionToast } from "./lib/router.mjs";
import { DEFAULT_SETTINGS, readSettings } from "./lib/settings.mjs";

// Firefox exposes promise-based APIs as `browser`; Chrome as `chrome`.
const ext = globalThis.browser ?? globalThis.chrome;

async function getSettings() {
  return readSettings(await ext.storage.local.get({ ...DEFAULT_SETTINGS, checksOffSites: [] }));
}

async function resolveOrigin() {
  try {
    const { appOrigin } = await getSettings();
    if (!appOrigin) return { error: "settings" };
    const granted = await ext.permissions.contains({ origins: [originPermission(appOrigin)] });
    return granted ? { origin: appOrigin } : { error: "not_allowed" };
  } catch {
    return { error: "settings" };
  }
}

const api = createApi({
  fetch: (...args) => globalThis.fetch(...args),
  resolveOrigin,
  randomId: () => crypto.randomUUID(),
});
const router = createRouter({ api, extensionId: ext.runtime.id, getSettings });

async function createMenus() {
  try {
    await ext.contextMenus.removeAll();
  } catch {
    return;
  }
  // Reading lastError consumes a platform error without logging selection data.
  const done = () => { void ext.runtime.lastError; };
  ext.contextMenus.create({ id: ADD_MENU_ID, title: "Add to gloss", contexts: ["selection"] }, done);
  ext.contextMenus.create({ id: MENU_ID, title: "Check with gloss", contexts: ["selection"] }, done);
}

async function showOptions() {
  try {
    await ext.runtime.openOptionsPage();
  } catch {
    // No captured text or page details belong in extension logs.
  }
}

async function openApp(path) {
  const { appOrigin } = await getSettings();
  if (!appOrigin) return showOptions();
  await ext.tabs.create({ url: `${appOrigin}${path}` });
}

async function openSelection(info) {
  if (normalizeSelection(info.selectionText) === null) return;
  try {
    const settings = await ext.storage.local.get({ appOrigin: DEFAULT_SETTINGS.appOrigin });
    const origin = parseAppOrigin(settings.appOrigin);
    if (!origin) {
      await showOptions();
      return;
    }
    const url = buildCaptureUrl(info.selectionText, origin);
    if (url) await ext.tabs.create({ url });
  } catch {
    // Fail closed: a storage error must not send a private test selection to
    // another editor address. The options page lets the learner check settings.
    await showOptions();
  }
}

// The toast appears in the page through the content script. Pages without
// it (browser pages, stores, PDF viewers, tabs open since before install) get
// a short badge on the toolbar button instead.
async function notify(tab, toast) {
  if (!tab || tab.id === undefined || tab.id < 0) return;
  try {
    await ext.tabs.sendMessage(tab.id, { type: "toast", toast }, { frameId: 0 });
  } catch {
    try {
      await ext.action.setBadgeBackgroundColor({ tabId: tab.id, color: toast.tone === "error" ? "#a03a26" : "#0a665f" });
      await ext.action.setBadgeText({ tabId: tab.id, text: toast.tone === "error" ? "!" : "✓" });
      await ext.action.setTitle({ tabId: tab.id, title: toast.text });
      setTimeout(() => {
        ext.action.setBadgeText({ tabId: tab.id, text: "" }).catch(() => undefined);
        ext.action.setTitle({ tabId: tab.id, title: "gloss" }).catch(() => undefined);
      }, 6000);
    } catch {
      // The tab closed in the meantime.
    }
  }
}

async function addSelection(info, tab) {
  const prepared = prepareWord(info.selectionText);
  if (!prepared.ok) {
    await notify(tab, selectionToast(prepared.reason));
    return;
  }
  const result = await api.saveWord(prepared.text);
  if (result.ok) router.forgetWords();
  await notify(tab, saveToast(result, prepared.text));
}

async function respond(message, sender) {
  // Opening a tab is the only action here that is not about the server.
  if (message?.type === "open" && sender?.id === ext.runtime.id) {
    if (message.target === "options") await showOptions();
    else if (message.target === "words") await openApp("/expressions");
    else if (message.target === "app") await openApp("/");
    return { ok: true };
  }
  return router.handle(message, sender);
}

ext.runtime.onInstalled.addListener(createMenus);
ext.runtime.onStartup?.addListener(createMenus);
ext.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === ADD_MENU_ID) void addSelection(info, tab).catch(() => undefined);
  else if (info.menuItemId === MENU_ID) void openSelection(info);
});
// sendResponse with `return true` works in every browser; a returned
// promise is not honored everywhere.
ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  respond(message, sender).then(sendResponse, () => sendResponse({ ok: false, error: "unavailable" }));
  return true;
});
ext.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") router.reset();
});
