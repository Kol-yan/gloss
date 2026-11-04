import type { MeResponse } from "@/shared/contracts";

const STORAGE_KEY = "gloss.openrouter-key";

type AccessSnapshot = {
  session: MeResponse | null;
  checked: boolean;
  hasKey: boolean;
  storageNotice: string | null;
  sessionRevision: number;
  learnerRevision: number;
};

const INITIAL: AccessSnapshot = {
  session: null,
  checked: false,
  hasKey: false,
  storageNotice: null,
  sessionRevision: 0,
  learnerRevision: 0,
};

let snapshot = INITIAL;
let providerKey = "";
let initialized = false;
let lastLearnerId: string | null = null;
const listeners = new Set<() => void>();

function publish(next: AccessSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function readBrowserKey() {
  if (typeof window === "undefined") return;
  initialized = true;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
    providerKey = isProviderKey(saved) ? saved : "";
    publish({ ...snapshot, hasKey: providerKey !== "", storageNotice: null });
  } catch {
    publish({ ...snapshot, storageNotice: "Browser storage is unavailable. Your key will work in this tab only." });
  }
}

function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) readBrowserKey();
}

export function subscribeAccess(listener: () => void) {
  listeners.add(listener);
  if (!initialized) readBrowserKey();
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function getAccessSnapshot() {
  return snapshot;
}

export function getServerAccessSnapshot() {
  return INITIAL;
}

export function setCurrentSession(session: MeResponse | null) {
  const identityChanged = snapshot.session?.learner.id !== session?.learner.id
    || snapshot.session?.accessMode !== session?.accessMode;
  const learnerChanged = Boolean(session && lastLearnerId && lastLearnerId !== session.learner.id);
  if (session) lastLearnerId = session.learner.id;
  publish({
    ...snapshot,
    session,
    checked: true,
    sessionRevision: snapshot.sessionRevision + (identityChanged ? 1 : 0),
    learnerRevision: snapshot.learnerRevision + (learnerChanged ? 1 : 0),
  });
}

export function isProviderKey(value: string) {
  const key = value.trim();
  return key.length >= 16 && key.length <= 512 && /^[\x21-\x7e]+$/.test(key);
}

export function saveProviderKey(value: string) {
  providerKey = value.trim();
  initialized = true;
  let storageNotice: string | null = null;
  try {
    window.localStorage.setItem(STORAGE_KEY, providerKey);
  } catch {
    storageNotice = "Browser storage is unavailable. Your key will work in this tab only.";
  }
  publish({ ...snapshot, hasKey: providerKey !== "", storageNotice });
}

export function forgetProviderKey() {
  providerKey = "";
  initialized = true;
  let storageNotice: string | null = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    storageNotice = "The key was cleared from this tab. Browser storage could not be cleared; remove this site's saved data in your browser settings.";
  }
  publish({ ...snapshot, hasKey: false, storageNotice });
}

// A saved visitor key must never be attached to an invitation-funded request.
export function getRequestProviderKey() {
  if (!initialized) readBrowserKey();
  return snapshot.session?.accessMode === "byok" ? providerKey : "";
}
