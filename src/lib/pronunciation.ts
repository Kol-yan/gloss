// A lexical item can contain Latin accents and internal apostrophes or hyphens,
// but a phrase must never be presented as a single-word pronunciation.
const SINGLE_WORD = /^\p{Script=Latin}[\p{Script=Latin}\u0300-\u036f]*(?:['’\-\u2010\u2011]\p{Script=Latin}[\p{Script=Latin}\u0300-\u036f]*)*$/u;
const PHONES = /^[abdefghijklmnoprstuvwzæɑɔəɚɝɛɜɪʊʌɐɡɹɾɫŋʃʒθðʔʍ˞ˈˌːˑ.\u0329\u032c\u0303\u0361]+$/u;
const VOWEL = /[aeiouæɑɔəɚɝɛɜɪʊʌɐ]/u;
export const MAX_IPA_LENGTH = 98;

export function isSingleLexicalWord(value: string): boolean {
  const word = value.normalize("NFC").trim();
  return word.length > 0 && word.length <= 80 && SINGLE_WORD.test(word);
}

// This checks bounded phonetic syntax, not whether a model's pronunciation is
// acoustically correct. Missing or doubtful IPA never blocks a useful edit.
export function sanitizeIpa(value: unknown, word: string): string | null {
  if (!isSingleLexicalWord(word) || typeof value !== "string" || value.length > 128) return null;
  let phones = value.normalize("NFC").trim();
  const wrapped = (phones.startsWith("/") && phones.endsWith("/")) ||
    (phones.startsWith("[") && phones.endsWith("]"));
  if (wrapped) phones = phones.slice(1, -1).trim();
  else if (/^[A-Za-z]+$/.test(phones)) return null;
  if (!phones || phones.length > MAX_IPA_LENGTH - 2 || /\s/u.test(phones) ||
      !PHONES.test(phones) || !VOWEL.test(phones) || /^[.ːˑ]|[.ˈˌ]$|\.\.|[ˈˌ]{2}/u.test(phones)) return null;
  return `/${phones}/`;
}
