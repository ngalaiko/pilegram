/**
 * Renderer — the draft state machine (plan §3–§5).
 *
 *   idle ──agent_start──▶ running (acc="", no preview yet)
 *   running ──thinking/text/tool delta──▶ editable provisional message (~250ms)
 *   running ──agent_settled──▶ replace provisional message with final text
 *
 * The preview deliberately uses an ordinary editable message rather than
 * sendMessageDraft. Native Telegram drafts can disable the compose/send control
 * on mobile clients, which prevents the user from steering or sending /stop.
 * Thinking remains ephemeral: a thinking-only preview is deleted on settle.
 *
 * §5 Tools: never one message per tool call. Status lives in the provisional
 * preview (and evaporates on finalize); a compact summary is appended to the final message.
 *
 * All verified against the live API (see telegram-draft-semantics): finalize on
 * agent_settled (not agent_end — which may auto-retry), heartbeat unconditionally.
 */

import { errFields, log as rootLog } from "./log.ts";
import { renderMarkdownChunks } from "./markdown.ts";
import type { Route } from "./route.ts";
import { stripUnsafe } from "./sanitize.ts";
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
  private flushTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private actionTimer?: ReturnType<typeof setInterval>;
  private mediaAction?: string; // e.g. upload_photo, set while a tg_send_* tool runs
  private lastFlushAt = 0;
  private preview?: { id?: number; starting?: Promise<{ message_id: number }>; latestText: string };

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
    this.preview = undefined;
    this.mediaAction = undefined;
    this.heartbeat = setInterval(() => this.flushNow(), HEARTBEAT_MS);
    // Do not create a preview until there is content. A pure tg_react should
    // show only the short-lived chat action, not leave a visible message behind.
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

  /** Reflect the steering queue depth in the draft (§12). */
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

    const preview = this.preview;
    this.preview = undefined;
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
      // The Session sends this answer as a voice note; don't leave a provisional
      // text message behind while it does so.
      void this.deletePreview(preview);
      this.log.info("finalize: voice-only (text not persisted)");
      return;
    }
    if (answer.trim() === "") {
      void this.deletePreview(preview);
      this.log.info("finalize: empty (preview deleted)");
      return;
    }

    // Strip bidi-override / zero-width chars so a prompt-injected answer can't
    // visually lie in Telegram (§11) — same treatment tg_ask text already gets.
    let out = stripUnsafe(answer);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total > 0) out += `\n\n${formatToolSummary(counts, elapsedMs)}`;

    // Render markdown → Telegram HTML, block-chunked so a split never breaks a tag.
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
    this.log.info("finalize", { chars: out.length, chunks: chunks.length, tools: total, html: !!extra, preview: !!preview });
    void this.finalizePreview(preview, chunks, extra);
  }

  /**
   * Persist one finalized chunk. If it was sent as HTML and Telegram rejects the
   * entities (e.g. a `<pre>` block split across a chunk boundary, or a construct
   * Telegram doesn't accept), re-send the chunk as readable plain text rather
   * than dropping it — a rejected chunk would otherwise vanish from the answer.
   */
  private sendFinal(chunk: string, extra: { parse_mode: "HTML" } | undefined) {
    this.writer
      .persist(chunk, extra)
      .then((m) => this.onSent?.(m.message_id, chunk))
      .catch((e) => {
        if (!extra) {
          this.log.error("finalize persist failed", errFields(e));
          return;
        }
        this.log.warn("HTML finalize rejected; retrying as plain text", errFields(e));
        const plain = htmlToPlain(chunk);
        this.writer
          .persist(plain)
          .then((m) => this.onSent?.(m.message_id, plain))
          .catch((e2) => this.log.error("plain finalize fallback failed", errFields(e2)));
      });
  }

  onError(err: unknown) {
    const preview = this.preview;
    this.preview = undefined;
    this.clearTimers();
    this.running = false;
    this.acc = "";
    this.statusLine = undefined;
    this.thinkingAcc = "";
    this.sawText = false;
    this.toolCounts.clear();
    this.queueDepth = 0;
    void this.deletePreview(preview);
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
    if (text.trim() === "") return; // nothing to show yet — don't create a provisional message
    this.lastFlushAt = Date.now();

    const preview = (this.preview ??= { latestText: text });
    preview.latestText = text;
    if (preview.id !== undefined) {
      this.writer.editText(preview.id, text).catch((e) => this.log.warn("preview update failed", errFields(e)));
      return;
    }
    if (preview.starting) return;

    const initialText = text;
    preview.starting = this.writer
      .persist(initialText)
      .then(async (message) => {
        preview.id = message.message_id;
        // Deltas can arrive while sendMessage is in flight; catch the preview up
        // in one edit rather than sending another provisional message.
        if (preview.latestText !== initialText) await this.writer.editText(message.message_id, preview.latestText);
        return message;
      })
      .catch((e) => {
        this.log.warn("preview start failed", errFields(e));
        throw e;
      });
  }

  private async deletePreview(preview: Renderer["preview"]) {
    if (!preview) return;
    try {
      const message = preview.starting ? await preview.starting : undefined;
      const id = preview.id ?? message?.message_id;
      if (id !== undefined) await this.writer.deleteMessage(id);
    } catch (e) {
      this.log.warn("preview delete failed", errFields(e));
    }
  }

  private async finalizePreview(preview: Renderer["preview"], chunks: string[], extra: { parse_mode: "HTML" } | undefined) {
    if (!preview) {
      for (const chunk of chunks) this.sendFinal(chunk, extra);
      return;
    }
    try {
      const message = preview.starting ? await preview.starting : undefined;
      const id = preview.id ?? message?.message_id;
      if (id === undefined) throw new Error("preview did not yield a message id");
      const first = chunks[0]!;
      try {
        await this.writer.editText(id, first, extra);
        this.onSent?.(id, first);
      } catch (e) {
        if (!extra) throw e;
        this.log.warn("HTML preview finalize rejected; retrying as plain text", errFields(e));
        const plain = htmlToPlain(first);
        await this.writer.editText(id, plain);
        this.onSent?.(id, plain);
      }
      for (const chunk of chunks.slice(1)) this.sendFinal(chunk, extra);
    } catch (e) {
      this.log.warn("preview finalize failed; sending standalone answer", errFields(e));
      for (const chunk of chunks) this.sendFinal(chunk, extra);
    }
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
    return stripUnsafe(body + status);
  }

  /**
   * Stop all timers and mark idle. Called when the owning Session is disposed
   * (e.g. its topic is closed) so a turn that was still running can't keep
   * firing the heartbeat / chat-action intervals against a dead route forever.
   */
  stop() {
    const preview = this.preview;
    this.preview = undefined;
    this.clearTimers();
    this.running = false;
    void this.deletePreview(preview);
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

/** Strip Telegram-HTML tags and unescape entities, for the plain-text fallback. */
function htmlToPlain(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
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
