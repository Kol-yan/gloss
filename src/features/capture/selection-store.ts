import { getAccessSnapshot, subscribeAccess } from "@/features/api/access-store";
import { parseSelectionFragment, type CapturedSelection } from "./selection";

type Snapshot = { revision: number; result: CapturedSelection | null };
const EMPTY: Snapshot = { revision: 0, result: null };

interface SelectionEnvironment {
  fragment: () => string;
  clearFragment: () => void;
  listenFragment: (callback: () => void) => () => void;
  learner: () => string | null;
  listenIdentity: (callback: () => void) => () => void;
}

export function createSelectionStore(env: SelectionEnvironment) {
  let snapshot = EMPTY;
  let owner: string | null = null;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const notify = () => { for (const listener of listeners) listener(); };
  const readFragment = () => {
    const result = parseSelectionFragment(env.fragment());
    if (!result) return;
    // Remove captured text from the address/history before exposing it to UI.
    env.clearFragment();
    owner = env.learner();
    snapshot = { revision: snapshot.revision + 1, result };
    notify();
  };
  const identityChanged = () => {
    const learner = env.learner();
    if (owner && owner !== learner) {
      owner = null;
      snapshot = { revision: snapshot.revision + 1, result: null };
      notify();
    } else if (snapshot.result && learner) {
      // An unauthenticated capture survives the first sign-in, then belongs to
      // that learner. Forgetting a provider key does not change its identity.
      owner = learner;
    }
  };
  return {
    getSnapshot: () => owner && owner !== env.learner() ? EMPTY : snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!stop) {
        identityChanged();
        readFragment();
        const stopHash = env.listenFragment(readFragment);
        const stopIdentity = env.listenIdentity(identityChanged);
        stop = () => { stopHash(); stopIdentity(); };
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { stop?.(); stop = null; }
      };
    },
  };
}

let browserStore: ReturnType<typeof createSelectionStore> | null = null;
function getStore() {
  if (!browserStore) browserStore = createSelectionStore({
    fragment: () => window.location.hash,
    clearFragment: () => window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search),
    listenFragment: (callback) => {
      window.addEventListener("hashchange", callback);
      return () => window.removeEventListener("hashchange", callback);
    },
    learner: () => getAccessSnapshot().session?.learner.id ?? null,
    listenIdentity: subscribeAccess,
  });
  return browserStore;
}

export const getSelectionSnapshot = () => typeof window === "undefined" ? EMPTY : getStore().getSnapshot();
export const getServerSelectionSnapshot = () => EMPTY;
export const subscribeSelection = (listener: () => void) => getStore().subscribe(listener);
