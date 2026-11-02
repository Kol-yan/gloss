// Parses JSON that a model returned as text. Some models wrap JSON in a
// Markdown fence even when asked not to. Returns undefined when it is not JSON.
export function parseModelJson(content: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(content);
  try {
    return JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return undefined;
  }
}
