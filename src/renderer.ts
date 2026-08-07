/**
 * Renderer — the draft state machine (plan §3–§5).
 *
 *   idle ──agent_start──▶ running (new draft_id, acc="", empty draft = "Thinking…")
 *   running ──thinking delta──▶ shown live in the draft (💭), dropped once the answer starts
 *   running ──text delta──▶ acc += delta; coalesced flush (~250ms)
 *   running ──heartbeat (20s)──▶ re-send same draft (drafts TTL out at ~30s)
 *   running ──tool start/end──▶ in-draft status line + per-turn tool tally
 *   running ──agent_settled──▶ persist final text (+ tool summary) via sendMessage
 *
 * §4 Thinking: drafts are ephemeral, and so is thinking — they belong together.
 * The user watches the model think in real time; the persisted message holds
 * only the answer (unless think mode is "keep").
 *
 * §5 Tools: never one message per tool call. Status lives in the draft (and
 * evaporates on finalize); a compact summary is appended to the final message.
 *
 * All verified against the live API (see telegram-draft-semantics): finalize on
 * agent_settled (not agent_end — which may auto-retry), heartbeat unconditionally.
 */

import { errFields, log as rootLog } from "./log.ts";
import { renderMarkdownChunks } from "./markdown.ts";
import type { Route } from "./route.ts";
import type { Writer } from "./writer.ts";

const FLUSH_MS = 250; // draft coalescing interval (tune up if 429s appear — plan §15/M1)
const HEARTBEAT_MS = 20_000; // re-send within the ~30s draft TTL
const DRAFT_MAX = 4096; // Telegram draft text limit
const MSG_MAX = 4096; // Telegram message text limit
const THINKING_TAIL = 600; // max thinking chars shown live in the draft

export class Renderer {
  private readonly log: ReturnType<typeof rootLog.child>;

  private running = false;
  private acc = "";
  private statusLine?: string;
  private draftCounter = 0;
  private currentDraftId = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private actionTimer?: ReturnType<typeof setInterval>;
  private mediaAction?: string; // e.g. upload_photo, set while a tg_send_* tool runs
  private lastFlushAt = 0;

  // §4 thinking — opinionated: always streamed live in the draft, never persisted
  private thinkingAcc = "";
  private sawText = false;

  // §5 tools
  private toolCounts = new Map<string, number>();
  private turnStartAt = 0;

  // §12 steering queue depth
  private queueDepth = 0;

  // voice-only mode: the Session sends the answer as a voice note, so onSettled
  // must NOT also persist the text (Telegram transcribes voice client-side).
  private voiceMode = false;

  constructor(
    private readonly writer: Writer,
    route: Route,
    private readonly onSent?: (messageId: number, text: string) => void,
  ) {
    this.log = rootLog.child({ route: `${route.chatId}-${route.threadId ?? 0}` });
  }

  onAgentStart() {
    this.clearTimers();
    this.running = true;
    this.acc = "";
    this.statusLine = undefined;
    this.thinkingAcc = "";
    this.sawText = false;
    this.toolCounts.clear();
    this.turnStartAt = Date.now();
    this.queueDepth = 0;
    this.currentDraftId = ++this.draftCounter;
    this.mediaAction = undefined;
    this.heartbeat = setInterval(() => this.flushNow(), HEARTBEAT_MS);
    // Do NOT open a draft yet: a draft can't be deleted (only TTLs out ~30s or is
    // replaced by sendMessage), so an eager empty draft would linger on turns that
    // produce no text (e.g. a pure tg_react). We draft only once there's content.
    // Meanwhile a chat action ("typing"/"record_voice"/…) shows activity — it
    // auto-expires, so it never lingers.
    this.actionTimer = setInterval(() => this.pushChatAction(), 4000);
    this.pushChatAction();
  }

  /** Set the media chat action while a tg_send_* tool runs (upload_photo, …). */
  setMediaAction(action: string | undefined) {
    this.mediaAction = action;
    this.pushChatAction();
  }

  private pushChatAction() {
    const action = this.chatAction();
    if (action) void this.writer.sendChatAction(action);
  }

  /** The chat action to show, or undefined when a draft is already the indicator. */
  private chatAction(): string | undefined {
    if (!this.running) return undefined;
    if (this.mediaAction) return this.mediaAction; // uploading a photo/doc/voice
    if (this.voiceMode) return "record_voice"; // synthesizing a spoken reply
    if (this.acc !== "" || this.statusLine !== undefined) return undefined; // a draft is showing
    return "typing"; // working, nothing drafted yet
  }

  onThinking(delta: string) {
    if (!this.running) return;
    this.thinkingAcc += delta;
    if (!this.sawText) this.scheduleFlush(); // only reflected live, before the answer starts
  }

  onText(delta: string) {
    if (!this.running) return;
    this.sawText = true;
    this.acc += delta;
    this.scheduleFlush();
  }

  onToolStart(name: string, args: unknown) {
    if (!this.running) return;
    this.toolCounts.set(name, (this.toolCounts.get(name) ?? 0) + 1);
    this.statusLine = `🔧 ${name}${summarizeArgs(args)}`;
    this.scheduleFlush();
  }

  onToolEnd() {
    if (!this.running) return;
    this.statusLine = undefined;
    this.scheduleFlush();
  }

  /** Reflect the steering/follow-up queue depth in the draft (§12). */
  setQueueDepth(n: number) {
    this.queueDepth = n;
    if (this.running) this.scheduleFlush();
  }

  /** In voice-only mode, the answer is sent as a voice note; skip text finalize. */
  setVoiceMode(on: boolean) {
    this.voiceMode = on;
  }

  /** Finalize on agent_settled. `finalText` is the authoritative answer. */
  onSettled(finalText: string | undefined) {
    const answer = finalText && finalText.trim() !== "" ? finalText : this.acc;
    const counts = new Map(this.toolCounts);
    const elapsedMs = this.turnStartAt ? Date.now() - this.turnStartAt : 0;

    this.clearTimers();
    this.running = false;
    this.acc = "";
    this.statusLine = undefined;
    this.thinkingAcc = "";
    this.sawText = false;
    this.toolCounts.clear();
    this.turnStartAt = 0;
    this.queueDepth = 0;

    if (this.voiceMode) {
      // The Session sends this answer as a voice note; don't persist text.
      this.log.info("finalize: voice-only (text not persisted)");
      return;
    }
    if (answer.trim() === "") {
      this.log.info("finalize: empty (draft self-expires)");
      return;
    }

    let out = answer;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total > 0) out += `\n\n${formatToolSummary(counts, elapsedMs)}`;

    // Regular tier (§3): render markdown → Telegram HTML, block-chunked so a
    // split never breaks a tag. Fall back to plain text if rendering throws.
    let chunks: string[];
    let extra: { parse_mode: "HTML" } | undefined;
    try {
      chunks = renderMarkdownChunks(out);
      extra = { parse_mode: "HTML" };
    } catch (e) {
      this.log.warn("markdown render failed; sending plain", errFields(e));
      chunks = chunkText(out, MSG_MAX);
      extra = undefined;
    }
    this.log.info("finalize", { chars: out.length, chunks: chunks.length, tools: total, html: !!extra });
    for (const chunk of chunks) {
      this.writer
        .persist(chunk, extra)
        .then((m) => this.onSent?.(m.message_id, chunk))
        .catch((e) => this.log.error("finalize persist failed", errFields(e)));
    }
  }

  onError(err: unknown) {
    this.clearTimers();
    this.running = false;
    this.acc = "";
    this.statusLine = undefined;
    this.thinkingAcc = "";
    this.sawText = false;
    this.toolCounts.clear();
    this.queueDepth = 0;
    const msg = err instanceof Error ? err.message : String(err);
    this.writer.persist(`⚠️ ${msg}`).catch((e) => this.log.error("error persist failed", errFields(e)));
  }

  private scheduleFlush() {
    if (!this.running || this.flushTimer) return;
    const wait = Math.max(0, FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushNow();
    }, wait);
  }

  private flushNow() {
    if (!this.running) return;
    const text = this.renderDraft();
    if (text.trim() === "") return; // nothing to show yet — don't open a draft that would linger
    this.lastFlushAt = Date.now();
    this.writer.sendDraft(this.currentDraftId, text).catch((e) => this.log.warn("draft flush failed", errFields(e)));
  }

  private renderDraft(): string {
    const bits: string[] = [];
    if (this.statusLine) bits.push(this.statusLine);
    if (this.queueDepth > 0) bits.push(`⏳ ${this.queueDepth} queued`);
    const status = bits.length ? `\n\n${bits.join(" · ")}` : "";
    // Voice turn: the answer is delivered as a voice note. Don't draft at all —
    // a draft would just linger (sendVoice doesn't replace it, unlike sendMessage).
    if (this.voiceMode) return "";
    const budget = DRAFT_MAX - status.length;
    const segments: string[] = [];
    if (!this.sawText && this.thinkingAcc.trim() !== "") {
      let t = this.thinkingAcc.trim().replace(/\s+/g, " ");
      if (t.length > THINKING_TAIL) t = "…" + t.slice(t.length - THINKING_TAIL);
      segments.push(`💭 ${t}`);
    }
    if (this.acc) segments.push(this.acc);
    let body = segments.join("\n\n");
    if (body.length > budget) body = "…" + body.slice(body.length - (budget - 1));
    return body + status;
  }

  private clearTimers() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    if (this.actionTimer) {
      clearInterval(this.actionTimer);
      this.actionTimer = undefined;
    }
  }
}

/** One-line, newline-free summary of a tool call's key argument. */
function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.command ?? a.cmd ?? a.path ?? a.file_path ?? a.pattern ?? a.query;
  const s = typeof pick === "string" ? pick : JSON.stringify(args);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat === "" ? "" : ` · ${flat.length > 80 ? flat.slice(0, 79) + "…" : flat}`;
}

/** "▸ 7 tools · 12.4s — bash ×4, read ×2, edit ×1" */
function formatToolSummary(counts: Map<string, number>, elapsedMs: number): string {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const parts = [...counts.entries()].map(([name, c]) => (c > 1 ? `${name} ×${c}` : name));
  const secs = (elapsedMs / 1000).toFixed(1);
  return `▸ ${total} tool${total === 1 ? "" : "s"} · ${secs}s — ${parts.join(", ")}`;
}

/** Split into <= max-char chunks, preferring newline boundaries. */
function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + Math.floor(max / 2)) end = nl + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}
