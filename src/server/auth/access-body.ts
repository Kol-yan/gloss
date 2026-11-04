import { InvalidRequestError } from "../errors";

// Access endpoints accept only an empty object; credentials belong in the
// request-scoped header, never a JSON body that might be retained by tooling.
export async function requireEmptyAccessBody(request: Request): Promise<void> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new InvalidRequestError();
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidRequestError();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 512) throw new InvalidRequestError();
      parts.push(value);
    }
    const text = Buffer.concat(parts).toString("utf8");
    const value: unknown = JSON.parse(text);
    if (value === null || Array.isArray(value) || typeof value !== "object" || Object.keys(value).length) throw new InvalidRequestError();
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new InvalidRequestError();
  }
}

export async function parseGuestAccessBody(request: Request): Promise<{ turnstileToken?: string }> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new InvalidRequestError();
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidRequestError();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) throw new InvalidRequestError();
      parts.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new InvalidRequestError();
    }
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "turnstileToken")) {
      throw new InvalidRequestError();
    }
    if (body.turnstileToken === undefined) return {};
    if (typeof body.turnstileToken !== "string") throw new InvalidRequestError();
    const token = body.turnstileToken.trim();
    if (token.length < 1 || token.length > 2048) throw new InvalidRequestError();
    return { turnstileToken: token };
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new InvalidRequestError();
  }
}
