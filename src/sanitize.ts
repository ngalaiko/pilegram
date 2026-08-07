/**
 * Strip characters that let attacker-influenced text visually lie: bidi
 * overrides (U+202A–202E, U+2066–2069) and zero-width / BOM chars (§11).
 * Applied wherever model- or user-supplied text is rendered into Telegram.
 *
 * Built from escapes so the source contains no invisible characters.
 */
const UNSAFE = new RegExp("[\\u202A-\\u202E\\u2066-\\u2069\\u200B-\\u200F\\u2060\\uFEFF]", "g");

export function stripUnsafe(s: string): string {
  return s.replace(UNSAFE, "");
}
