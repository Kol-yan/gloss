// Shared format validation; this does not verify account credit or permissions.
export const PROVIDER_KEY_MESSAGE = "Enter a valid OpenRouter key starting with sk-or-v1- (no spaces).";
export function isProviderKey(value: string): boolean {
  return /^sk-or-v1-[A-Za-z0-9_-]{16,512}$/.test(value.trim());
}
