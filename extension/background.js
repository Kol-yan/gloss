/* global chrome */
import { buildCaptureUrl, DEFAULT_ORIGIN, MENU_ID, normalizeSelection, parseAppOrigin } from "./capture.mjs";

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) return;
    chrome.contextMenus.create({ id: MENU_ID, title: "Check with gloss", contexts: ["selection"] }, () => {
      // Reading lastError consumes a platform error without logging selection data.
      void chrome.runtime.lastError;
    });
  });
}

async function showOptions() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    // No captured text or page details belong in extension logs.
  }
}

async function openSelection(info) {
  if (info.menuItemId !== MENU_ID || normalizeSelection(info.selectionText) === null) return;
  try {
    const settings = await chrome.storage.local.get({ appOrigin: DEFAULT_ORIGIN });
    const origin = parseAppOrigin(settings.appOrigin);
    if (!origin) {
      await showOptions();
      return;
    }
    const url = buildCaptureUrl(info.selectionText, origin);
    if (url) await chrome.tabs.create({ url });
  } catch {
    // Fail closed: a storage error must not send a private test selection to
    // another editor address. The options page lets the learner check settings.
    await showOptions();
  }
}

chrome.runtime.onInstalled.addListener(createMenu);
chrome.contextMenus.onClicked.addListener((info) => { void openSelection(info); });
