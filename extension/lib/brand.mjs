// Renders a learner-facing line so the brand word uses the same teal and
// semibold weight as the rest of the UI without putting HTML into the page.
export function brandFragment(text, doc = document) {
  const fragment = doc.createDocumentFragment();
  for (const part of String(text).split(/(\bgloss\b)/)) {
    if (!part) continue;
    if (part === "gloss") {
      const span = doc.createElement("span");
      span.className = "brand-word";
      span.textContent = part;
      fragment.append(span);
    } else {
      fragment.append(part);
    }
  }
  return fragment;
}
