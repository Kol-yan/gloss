// The small badge that appears next to a text field while gloss checks it as
// the learner types. The window is click-through except for the badge itself.
import { byId, invoke, listen } from "./bridge";

const badge = byId<HTMLButtonElement>("badge");
const count = byId<HTMLSpanElement>("count");

function render(fixes: number) {
  count.textContent = String(fixes);
  badge.dataset.fixes = String(fixes);
}

badge.addEventListener("click", () => {
  void invoke("badge_click").catch(() => undefined);
});

void listen<number>("badge", render);
