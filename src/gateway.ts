/**
 * The gateway: one long-polling loop, durable offset, allowlist, dispatch.
 *
 * Plan §1: allowed_updates must explicitly name message / edited_message /
 * callback_query / message_reaction (reactions don't arrive otherwise). One
 * poller only — a second gets 409 Conflict. Offset persists in SQLite so a
 * restart replays nothing.
 *
 * We drive getUpdates ourselves (rather than bot.start()) to control exactly
 * when the offset advances: only *after* an update is handled.
 */

import { Bot, GrammyError, HttpError } from "grammy";
import type { CallbackQuery, Message, MessageReactionUpdated, PhotoSize, Update } from "grammy/types";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { errFields, log } from "./log.ts";
import { downloadTelegramFile, type ImageContent, toImageContent } from "./media.ts";
import { QuestionRegistry, renderQuestionKeyboard } from "./questions.ts";
import type { Route } from "./route.ts";
import { Router } from "./router.ts";
import type { Session } from "./session.ts";
import { Voice } from "./voice.ts";

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "message_reaction"] as const;

export class Gateway {
  private readonly bot: Bot;
  private readonly router: Router;
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private abort?: AbortController;
  // Inbound albums arrive as N updates sharing media_group_id (§9); buffer + debounce.
  private readonly albums = new Map<string, { route: Route; msgs: Message[]; firstAt: number; timer?: ReturnType<typeof setTimeout> }>();

  private readonly questions = new QuestionRegistry();
  private readonly voice: Voice;

  constructor(
    private readonly config: Config,
    private readonly db: Db,
  ) {
    this.bot = new Bot(config.botToken);
    this.voice = new Voice({ modelsDir: config.modelsDir, whisperModel: config.whisperModel, supertonicVoice: config.supertonicVoice });
    this.router = new Router(this.bot.api, config, db, this.questions, this.voice);
  }

  async start() {
    await this.bot.init();
    const me = this.bot.botInfo;
    const topicsEnabled = Boolean((me as { has_topics_enabled?: boolean }).has_topics_enabled);
    log.info("bot online", { username: me.username, id: me.id, topicsEnabled });
    if (!topicsEnabled) {
      // Expected for our first target: DM single-session mode (plan §2.4), where
      // message drafts actually work. Topics-as-sessions is a later mode.
      log.info("topic mode unavailable — running DM single-session mode (plan §2.4)");
    }

    await this.registerCommands();
    this.router.restore();
    void this.voice.warmup(); // fetch models in the background so voice is ready

    this.running = true;
    this.loopDone = this.pollLoop();
  }

  private async registerCommands() {
    try {
      // Opinionated: the only command is /stop. Sessions are just Telegram
      // topics — create/delete them with Telegram's native thread UI.
      await this.bot.api.setMyCommands([{ command: "stop", description: "Abort the current turn" }]);
    } catch (e) {
      log.warn("setMyCommands failed", errFields(e));
    }
  }

  private async pollLoop() {
    let offset = this.db.getPollOffset();
    this.abort = new AbortController();
    log.info("poll loop starting", { offset: offset ?? null });

    while (this.running) {
      let updates: Update[];
      try {
        updates = await this.bot.api.getUpdates(
          {
            offset,
            timeout: this.config.pollTimeoutSec,
            allowed_updates: [...ALLOWED_UPDATES],
          },
          // grammY types the signal via the abort-controller package, which is
          // runtime-compatible with the global AbortSignal but not nominally.
          this.abort.signal as unknown as Parameters<Bot["api"]["getUpdates"]>[1],
        );
      } catch (e) {
        // A shutdown aborts the in-flight long-poll; exit promptly and quietly.
        if (!this.running) break;
        if (e instanceof GrammyError && e.error_code === 409) {
          // Another poller owns this bot. We must not fight it (escalates cooldown).
          log.error("409 Conflict: another getUpdates poller is running — shutting down", errFields(e));
          this.running = false;
          throw e;
        }
        if (e instanceof GrammyError && e.error_code === 429) {
          const retry = e.parameters?.retry_after ?? 1;
          log.warn("429 on getUpdates — backing off", { retry_after: retry });
          await sleep(retry * 1000);
          continue;
        }
        // Network / transient. Back off and retry; do not advance offset.
        log.warn("getUpdates failed — retrying", { ...errFields(e), http: e instanceof HttpError });
        await sleep(1000);
        continue;
      }

      for (const update of updates) {
        try {
          await this.handleUpdate(update);
        } catch (e) {
          // §14: try/catch around every per-update handler so one bad update
          // never takes down the loop.
          log.error("handler threw", { update_id: update.update_id, ...errFields(e) });
        }
        // Advance the durable offset even on handler failure, so a poison
        // update can't wedge the loop forever.
        offset = update.update_id + 1;
        this.db.setPollOffset(offset);
      }
    }
    log.info("poll loop stopped");
  }

  private async handleUpdate(update: Update) {
    const fromId = fromUserId(update);
    if (fromId === undefined || !this.config.allowedUserIds.has(fromId)) {
      // Plan §1: log and drop silently. Never reply — don't confirm the bot exists.
      log.warn("dropped update from non-allowlisted sender", {
        update_id: update.update_id,
        from: fromId ?? null,
        kind: updateKind(update),
      });
      return;
    }

    log.info("update", { update_id: update.update_id, from: fromId, kind: updateKind(update) });
    await this.dispatch(update);
  }

  /** M2: topics-as-sessions. Route text into the per-route pi Session. */
  private async dispatch(update: Update) {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    if (update.message_reaction) {
      this.logReaction(update.message_reaction);
      return;
    }
    const msg = update.message ?? update.edited_message;
    if (!msg) return;
    const isEdit = !update.message; // came in as edited_message

    const chatId = msg.chat.id;
    const route: Route = { chatId, threadId: msg.message_thread_id };
    // Prepended to any prompt built from this message: (edited) marker, forwarded
    // origin, and the quoted text when it's a reply — all high-signal context (§15).
    const prefix = (isEdit ? "(edited message) " : "") + contextPrefix(msg);

    // --- forum service messages: register/rename routes, never reply ---
    if (msg.forum_topic_created) {
      this.router.register(route, msg.forum_topic_created.name);
      log.info("topic created (ui)", { threadId: msg.message_thread_id, name: msg.forum_topic_created.name });
      return;
    }
    if (msg.forum_topic_edited) {
      if (msg.forum_topic_edited.name) this.router.setName(route, msg.forum_topic_edited.name);
      return;
    }

    // --- albums: buffer by media_group_id and flush once (§9) ---
    if (!isEdit && msg.media_group_id && (msg.photo || msg.document)) {
      this.bufferAlbumItem(route, msg);
      return;
    }

    // --- text: /stop is the only command; everything else is a prompt ---
    if (typeof msg.text === "string") {
      const session = await this.router.getOrCreate(route);
      const trimmed = msg.text.trim();
      const first = trimmed.split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
      if (first === "/stop") {
        await session.abort();
        return;
      }
      const followUp = trimmed.startsWith(">"); // ">" → queue as a follow-up (§12)
      const body = followUp ? trimmed.slice(1).trim() : msg.text;
      await session.handlePrompt(prefix + body, { messageId: msg.message_id, followUp });
      return;
    }

    // --- single photo → vision ---
    if (msg.photo) {
      const session = await this.router.getOrCreate(route);
      await this.guardMedia(session, async () => {
        const img = await this.photoToImage(session, msg.photo!);
        await session.handlePrompt(prefix + (msg.caption ?? "(image)"), { images: [img], messageId: msg.message_id });
      });
      return;
    }

    // --- document → path (+ inlined text for small text files) ---
    if (msg.document) {
      const session = await this.router.getOrCreate(route);
      await this.guardMedia(session, () => this.ingestDocument(session, msg, prefix));
      return;
    }

    // --- sticker → text descriptor ---
    if (msg.sticker) {
      const session = await this.router.getOrCreate(route);
      await session.handlePrompt(`${prefix}[sticker: ${msg.sticker.emoji ?? ""}]`, { messageId: msg.message_id });
      return;
    }

    // --- voice / audio / round-video → transcribe, then prompt + reply in voice ---
    if (msg.voice || msg.video_note || msg.audio) {
      const session = await this.router.getOrCreate(route);
      await this.guardMedia(session, async () => {
        const fileId = (msg.voice ?? msg.video_note ?? msg.audio)!.file_id;
        const inbox = join(session.workspaceDir, "inbox");
        const dl = await downloadTelegramFile(this.bot.api, this.config.botToken, fileId, inbox, { fallbackName: "voice-in" });
        const transcript = (await this.voice.transcribe(dl.path, inbox)).trim();
        if (transcript === "") {
          await session.notify("(couldn't make out any speech)");
          return;
        }
        // Don't echo the transcript — Telegram transcribes voice client-side.
        // speak:true → reply as a voice note only.
        await session.handlePrompt(prefix + transcript, { messageId: msg.message_id, speak: true });
      });
      return;
    }

    // --- location / venue / contact / poll / dice → text descriptor ---
    const descriptor = describeMessage(msg);
    if (descriptor) {
      const session = await this.router.getOrCreate(route);
      await session.handlePrompt(prefix + descriptor, { messageId: msg.message_id });
      return;
    }

    // Plain video (not a round note) — nudge; usually large & not speech.
    if (msg.video) {
      const session = await this.router.getOrCreate(route);
      await session.notify("(send a voice note if you want me to listen; plain video isn't handled yet.)");
      return;
    }
  }

  /** Run a media-ingest step, turning download failures into a friendly notice. */
  private async guardMedia(session: Session, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("media ingest failed", errFields(e));
      const hint = /too large|too big|file_path/i.test(msg)
        ? "That file is too large for the Bot API (20MB limit) — drop it into the workspace directly."
        : `Couldn't read that attachment: ${msg}`;
      await session.notify(`⚠️ ${hint}`);
    }
  }

  private async photoToImage(session: Session, photo: PhotoSize[]): Promise<ImageContent> {
    const largest = photo[photo.length - 1]!; // ascending size ladder
    const dl = await downloadTelegramFile(this.bot.api, this.config.botToken, largest.file_id, join(session.workspaceDir, "inbox"), {
      mime: "image/jpeg",
    });
    return toImageContent(dl.bytes, dl.mime);
  }

  private async ingestDocument(session: Session, msg: Message, prefix = "") {
    const doc = msg.document!;
    const dl = await downloadTelegramFile(this.bot.api, this.config.botToken, doc.file_id, join(session.workspaceDir, "inbox"), {
      fallbackName: doc.file_name,
      mime: doc.mime_type,
    });
    let text = prefix + (msg.caption?.trim() || `I've saved a file you sent to ${dl.path}. Take a look.`);
    if (msg.caption) text += `\n\n(saved to ${dl.path})`;
    if (dl.sizeBytes < 100_000 && isTextual(dl.mime, dl.name)) {
      text += `\n\nContents of ${dl.name}:\n\n${Buffer.from(dl.bytes).toString("utf8")}`;
    }
    await session.handlePrompt(text, { messageId: msg.message_id });
  }

  private bufferAlbumItem(route: Route, msg: Message) {
    const gid = msg.media_group_id!;
    let pending = this.albums.get(gid);
    if (!pending) {
      pending = { route, msgs: [], firstAt: Date.now() };
      this.albums.set(gid, pending);
    }
    pending.msgs.push(msg);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.msgs.length >= 10) {
      void this.flushAlbum(gid);
      return;
    }
    const capRemaining = 5000 - (Date.now() - pending.firstAt); // 5s absolute cap
    const delay = Math.max(0, Math.min(1200, capRemaining)); // else 1200ms of silence
    pending.timer = setTimeout(() => void this.flushAlbum(gid), delay);
  }

  private async flushAlbum(gid: string) {
    const pending = this.albums.get(gid);
    if (!pending) return;
    this.albums.delete(gid);
    if (pending.timer) clearTimeout(pending.timer);

    const session = await this.router.getOrCreate(pending.route);
    await this.guardMedia(session, async () => {
      const images: ImageContent[] = [];
      const notes: string[] = [];
      let caption: string | undefined;
      for (const m of pending.msgs) {
        if (m.caption && !caption) caption = m.caption; // Telegram puts the caption on one item
        if (m.photo) images.push(await this.photoToImage(session, m.photo));
        else if (m.document) {
          const dl = await downloadTelegramFile(this.bot.api, this.config.botToken, m.document.file_id, join(session.workspaceDir, "inbox"), {
            fallbackName: m.document.file_name,
            mime: m.document.mime_type,
          });
          notes.push(`file: ${dl.path}`);
        }
      }
      let text = caption ?? "(album)";
      if (notes.length) text += `\n\n${notes.join("\n")}`;
      log.info("album flush", { items: pending.msgs.length, images: images.length });
      await session.handlePrompt(text, {
        images: images.length ? images : undefined,
        messageId: pending.msgs[0]?.message_id,
      });
    });
  }

  /** Resolve a tg_ask/tg_confirm choice (§11a). data = "id:s:i" | "id:t:i" | "id:d" | "noop". */
  private async handleCallback(cq: CallbackQuery) {
    const data = cq.data;
    if (!data || data === "noop") {
      await this.answerCallback(cq.id);
      return;
    }
    const [id = "", action, indexStr] = data.split(":");
    const index = indexStr !== undefined ? Number(indexStr) : Number.NaN;

    // multi-select toggle: flip selection, re-render keyboard in place, don't resolve
    if (action === "t") {
      if (!this.questions.toggle(id, index)) {
        await this.answerCallback(cq.id, "This choice has expired.");
        return;
      }
      const entry = this.questions.get(id)!;
      await this.answerCallback(cq.id, entry.selected.has(index) ? "Added" : "Removed");
      await this.editKeyboard(cq, renderQuestionKeyboard(id, entry.options, entry.selected, true));
      return;
    }

    // single-select ("s") or multi "Done" ("d") → resolve + freeze
    const indices =
      action === "d" ? [...(this.questions.get(id)?.selected ?? [])].sort((a, b) => a - b) : Number.isNaN(index) ? [] : [index];
    const chosen = this.questions.resolve(id, indices);
    await this.answerCallback(cq.id, chosen ? "Got it" : "This choice has expired.");
    const label = (chosen ? (chosen.length ? `✓ ${chosen.join(", ")}` : "✓ (none)") : "— expired —").slice(0, 128);
    await this.editKeyboard(cq, { inline_keyboard: [[{ text: label, callback_data: "noop" }]] });
  }

  private async editKeyboard(cq: CallbackQuery, reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] }) {
    if (!cq.message) return;
    try {
      await this.bot.api.editMessageReplyMarkup(cq.message.chat.id, cq.message.message_id, { reply_markup });
    } catch (e) {
      log.warn("editMessageReplyMarkup failed", errFields(e));
    }
  }

  /** User reactions on messages are a low-cost signal (§10) — log them. */
  private logReaction(mr: MessageReactionUpdated) {
    const emojis = mr.new_reaction.map((r) => (r.type === "emoji" ? r.emoji : r.type));
    if (emojis.length === 0) return; // a reaction was removed
    log.info("user reaction", { messageId: mr.message_id, emojis });
  }

  private async answerCallback(id: string, text?: string) {
    try {
      await this.bot.api.answerCallbackQuery(id, text ? { text } : undefined);
    } catch (e) {
      log.warn("answerCallbackQuery failed", errFields(e));
    }
  }

  async stop() {
    if (!this.running) return;
    log.info("stopping gateway");
    this.running = false;
    // Abort the in-flight long-poll so we don't block up to pollTimeoutSec.
    this.abort?.abort();
    await this.loopDone.catch(() => {});
    this.router.disposeAll();
  }
}

/** Extract the acting user's id from any update kind, for the allowlist check. */
function fromUserId(update: Update): number | undefined {
  return (
    update.message?.from?.id ??
    update.edited_message?.from?.id ??
    update.callback_query?.from.id ??
    update.message_reaction?.user?.id
  );
}

function updateKind(update: Update): string {
  if (update.message) return "message";
  if (update.edited_message) return "edited_message";
  if (update.callback_query) return "callback_query";
  if (update.message_reaction) return "message_reaction";
  return "other";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Context prefix from forward origin + quoted reply text (§15). */
function contextPrefix(msg: Message): string {
  const bits: string[] = [];
  const fwd = forwardDescriptor(msg);
  if (fwd) bits.push(`(${fwd})`);
  const quoted = quotedText(msg);
  if (quoted) {
    const t = quoted.length > 500 ? `${quoted.slice(0, 500)}…` : quoted;
    bits.push(`In reply to:\n> ${t.replace(/\n/g, "\n> ")}`);
  }
  return bits.length > 0 ? `${bits.join("\n\n")}\n\n` : "";
}

function forwardDescriptor(msg: Message): string | undefined {
  const f = msg.forward_origin;
  if (!f) return undefined;
  const title = (c: { title?: string; first_name?: string }) => c.title ?? c.first_name ?? "a chat";
  switch (f.type) {
    case "user":
      return `forwarded from ${f.sender_user.first_name}`;
    case "hidden_user":
      return `forwarded from ${f.sender_user_name}`;
    case "chat":
      return `forwarded from ${title(f.sender_chat)}`;
    case "channel":
      return `forwarded from channel ${title(f.chat)}`;
    default:
      return "forwarded";
  }
}

function quotedText(msg: Message): string | undefined {
  if (msg.quote?.text) return msg.quote.text; // the specific fragment the user quoted
  const r = msg.reply_to_message;
  return r?.text ?? r?.caption ?? undefined;
}

/** Text descriptor for the long-tail inbound types (§15). */
function describeMessage(msg: Message): string | undefined {
  if (msg.location) {
    const l = msg.location;
    return `[location${l.live_period ? " (live)" : ""}: ${l.latitude}, ${l.longitude}]`;
  }
  if (msg.venue) return `[venue: ${msg.venue.title} — ${msg.venue.address}]`;
  if (msg.contact) {
    const c = msg.contact;
    return `[contact: ${[c.first_name, c.last_name].filter(Boolean).join(" ")} · ${c.phone_number}]`;
  }
  if (msg.poll) return `[poll: ${msg.poll.question}\n${msg.poll.options.map((o) => `- ${o.text}`).join("\n")}]`;
  if (msg.dice) return `[dice ${msg.dice.emoji}: rolled ${msg.dice.value}]`;
  return undefined;
}

/** Whether a document is worth inlining as text into the prompt. */
function isTextual(mime: string, name: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/x-yaml", "application/yaml"].includes(mime)) return true;
  return /\.(txt|md|markdown|json|ya?ml|csv|tsv|log|ts|tsx|js|jsx|py|rs|go|java|c|h|cpp|sh|bash|zsh|toml|ini|cfg|conf|xml|html?|css|sql)$/i.test(name);
}
