// Builds a text fragment in which the brand word uses the shared teal and
// semibold style, without putting HTML strings into the page.
export function brandFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const part of text.split(/(\bgloss\b)/)) {
    if (!part) continue;
    if (part === "gloss") {
      const span = document.createElement("span");
      span.className = "brand-word";
      span.textContent = part;
      fragment.append(span);
    } else {
      fragment.append(part);
    }
  }
  return fragment;
}
