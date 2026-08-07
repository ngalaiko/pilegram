/**
 * QuestionRegistry — pending agent-initiated questions (tg_ask / tg_confirm,
 * §11a). A tool sends a message with tappable options and registers a resolver
 * here; the gateway resolves it when the matching callback_query arrives.
 *
 * Two modes:
 *  - single: each option resolves immediately on tap.
 *  - multi: options toggle a ✓ (keyboard re-rendered in place); a "Done" button
 *    resolves with the accumulated set. Telegram has no native multi-select, so
 *    this is the standard toggle-buttons-plus-Done pattern.
 *
 * callback_data (≤64 bytes) carries only `id:action[:index]`; option text and
 * selection live here in memory. On restart, pending questions are dropped.
 */

import { stripUnsafe } from "./sanitize.ts";

interface Entry {
  options: string[];
  multi: boolean;
  selected: Set<number>;
  resolve: (indices: number[] | null) => void;
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export class QuestionRegistry {
  private readonly pending = new Map<string, Entry>();
  private seq = 0;

  create(options: string[], multi: boolean, resolve: (indices: number[] | null) => void): string {
    const id = `q${(++this.seq).toString(36)}`;
    this.pending.set(id, { options, multi, selected: new Set(), resolve });
    return id;
  }

  get(id: string): Entry | undefined {
    return this.pending.get(id);
  }

  toggle(id: string, index: number): boolean {
    const e = this.pending.get(id);
    if (!e || index < 0 || index >= e.options.length) return false;
    if (e.selected.has(index)) e.selected.delete(index);
    else e.selected.add(index);
    return true;
  }

  /** Resolve with the given indices; returns the chosen option texts, or null if unknown. */
  resolve(id: string, indices: number[]): string[] | null {
    const e = this.pending.get(id);
    if (!e) return null;
    this.pending.delete(id);
    e.resolve(indices);
    return indices.map((i) => e.options[i]).filter((v): v is string => v !== undefined);
  }

  cancel(id: string) {
    this.pending.delete(id);
  }
}

/** Build the inline keyboard for a question (initial render or after a toggle). */
export function renderQuestionKeyboard(id: string, options: string[], selected: Set<number>, multi: boolean): InlineKeyboard {
  if (!multi) {
    return { inline_keyboard: options.map((opt, i) => [{ text: stripUnsafe(opt).slice(0, 128), callback_data: `${id}:s:${i}` }]) };
  }
  const rows = options.map((opt, i) => [
    { text: `${selected.has(i) ? "☑" : "☐"} ${stripUnsafe(opt)}`.slice(0, 128), callback_data: `${id}:t:${i}` },
  ]);
  rows.push([{ text: "✅ Done", callback_data: `${id}:d` }]);
  return { inline_keyboard: rows };
}
