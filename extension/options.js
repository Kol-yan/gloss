/* global chrome */
import { DEFAULT_ORIGIN, parseAppOrigin } from "./capture.mjs";

const form = document.querySelector("#settings");
const controls = document.querySelector("#controls");
const input = document.querySelector("#app-origin");
const status = document.querySelector("#status");
const useDefault = document.querySelector("#use-default");

async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get({ appOrigin: DEFAULT_ORIGIN });
    input.value = typeof settings.appOrigin === "string" ? settings.appOrigin : DEFAULT_ORIGIN;
    status.textContent = parseAppOrigin(input.value) ? "" : "Choose and save a valid editor address.";
  } catch {
    status.textContent = "Settings could not be loaded. Save the address you want to use.";
  } finally {
    controls.disabled = false;
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
  controls.disabled = true;
  try {
    await chrome.storage.local.set({ appOrigin: origin });
    input.value = origin;
    status.textContent = "Editor address saved.";
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

void loadSettings();
