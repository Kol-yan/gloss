import { DEFAULT_ORIGIN, originPermission, parseAppOrigin } from "./capture.mjs";
import { DEFAULT_SETTINGS, readSettings, withSiteChecks } from "./lib/settings.mjs";
import { accountLines } from "./lib/status.mjs";

const ext = globalThis.browser ?? globalThis.chrome;
const form = document.querySelector("#settings");
const controls = document.querySelector("#controls");
const input = document.querySelector("#app-origin");
const status = document.querySelector("#status");
const useDefault = document.querySelector("#use-default");
const test = document.querySelector("#test");
const checksEnabled = document.querySelector("#checks-enabled");
const offSites = document.querySelector("#off-sites");
const noOffSites = document.querySelector("#no-off-sites");
// Granted at install; never removed when the learner switches servers.
const REQUIRED_PERMISSION = originPermission(DEFAULT_ORIGIN);

async function currentSettings() {
  return readSettings(await ext.storage.local.get({ ...DEFAULT_SETTINGS, checksOffSites: [] }));
}

function showOffSites(sites) {
  offSites.replaceChildren(...sites.map((site) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = site;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary small";
    button.textContent = "Turn on";
    button.setAttribute("aria-label", `Turn writing checks on for ${site}`);
    button.addEventListener("click", async () => {
      const settings = await currentSettings();
      const next = withSiteChecks(settings, site, false);
      await ext.storage.local.set({ checksOffSites: next });
      showOffSites(next);
    });
    item.append(name, button);
    return item;
  }));
  noOffSites.hidden = sites.length > 0;
}

async function loadSettings() {
  try {
    const stored = await ext.storage.local.get({ appOrigin: DEFAULT_ORIGIN });
    input.value = typeof stored.appOrigin === "string" ? stored.appOrigin : DEFAULT_ORIGIN;
    const settings = await currentSettings();
    status.textContent = settings.appOrigin ? "" : "Choose and save a valid server address.";
    checksEnabled.checked = settings.checksEnabled;
    showOffSites(settings.checksOffSites);
  } catch {
    status.textContent = "Settings could not be loaded. Save the address you want to use.";
  } finally {
    controls.disabled = false;
    checksEnabled.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const origin = parseAppOrigin(input.value);
  if (!origin) {
    status.textContent = "Enter an HTTPS origin, or HTTP localhost/127.0.0.1, without a path, query or sign-in details.";
    input.focus();
    return;
  }
  const permission = originPermission(origin);
  controls.disabled = true;
  try {
    // The permission prompt must open straight from the click, before any
    // other await, or browsers refuse it.
    const granted = await ext.permissions.request({ origins: [permission] });
    const previous = (await currentSettings()).appOrigin;
    await ext.storage.local.set({ appOrigin: origin });
    input.value = origin;
    const old = previous && originPermission(previous);
    if (old && old !== permission && old !== REQUIRED_PERMISSION) {
      await ext.permissions.remove({ origins: [old] }).catch(() => false);
    }
    status.textContent = granted
      ? "Server address saved."
      : "Address saved, but gloss cannot reach it until you allow access. Save again to see the prompt.";
  } catch {
    status.textContent = "The address could not be saved. Try again.";
  } finally {
    controls.disabled = false;
  }
});

useDefault.addEventListener("click", () => {
  input.value = DEFAULT_ORIGIN;
  status.textContent = "Default address selected. Save to use it.";
  input.focus();
});

test.addEventListener("click", async () => {
  status.textContent = "Checking…";
  let answer;
  try {
    answer = await ext.runtime.sendMessage({ type: "status" });
  } catch {
    answer = { ok: false, error: "unavailable" };
  }
  const lines = accountLines(answer);
  status.textContent = [lines.text, lines.note].filter(Boolean).join(" ");
});

checksEnabled.addEventListener("change", async () => {
  try {
    await ext.storage.local.set({ checksEnabled: checksEnabled.checked });
  } catch {
    checksEnabled.checked = !checksEnabled.checked;
  }
});

void loadSettings();
