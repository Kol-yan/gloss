import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  session: null as object | null,
  refresh: vi.fn(),
  bootstrap: vi.fn(),
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { state.effects.push(effect); },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: state.refresh }) }));
vi.mock("@/features/api/use-access", () => ({ useAccess: () => ({ session: state.session }) }));
vi.mock("@/features/api/client", () => ({ bootstrapGuestAccess: state.bootstrap }));
import { OnboardingSignIn } from "@/features/onboarding/onboarding";

function mount() {
  state.effects = [];
  renderToStaticMarkup(createElement(OnboardingSignIn));
  return state.effects.map(effect => effect());
}

describe("first-visit onboarding with Turnstile", () => {
  beforeEach(() => { state.session = null; state.refresh.mockReset(); state.bootstrap.mockReset(); });
  it("waits for the verified session before refreshing the server onboarding gate", async () => {
    state.bootstrap.mockResolvedValue({ kind: "turnstile", siteKey: "test-site" });
    const cleanup = mount();
    await Promise.resolve();
    expect(state.refresh).not.toHaveBeenCalled();
    cleanup.forEach(fn => fn?.());
    // AccessBootstrap publishes the session after POST /api/access/guest succeeds.
    state.session = { learner: { id: "guest" } };
    mount();
    await Promise.resolve();
    expect(state.refresh).toHaveBeenCalledOnce();
  });
});
