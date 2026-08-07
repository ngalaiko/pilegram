/**
 * Writer — the single choke point for every Telegram write on a route.
 *
 * Plan's one invariant (§0): "all Telegram writes for a route go through that
 * route's Writer." Never call bot.api.* from an event handler directly.
 *
 * Responsibilities:
 *  - Serialize: one in-flight request at a time, in submission order, so drafts
 *    and the final message can never race / reorder.
 *  - Rate limit / 429: on 429 sleep exactly parameters.retry_after (§15 —
 *    ignoring it escalates the cooldown), then retry the same op.
 *
 * The draft flush *cadence* is controlled upstream by the Renderer (coalesced
 * ~250ms); the Writer just guarantees ordering and 429 safety.
 */

import type { Api, InputFile } from "grammy";
import { GrammyError } from "grammy";
import type { InputMediaDocument, InputMediaPhoto, Message } from "grammy/types";
import type { Route } from "./route.ts";
import { errFields, type Fields, log as rootLog } from "./log.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Writer {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly log: ReturnType<typeof rootLog.child>;

  constructor(
    private readonly api: Api,
    private readonly route: Route,
  ) {
    this.log = rootLog.child({ route: `${route.chatId}-${route.threadId ?? 0}` });
  }

  private get thread(): { message_thread_id?: number } {
    return this.route.threadId !== undefined ? { message_thread_id: this.route.threadId } : {};
  }

  /** Serialize an op onto the route's queue, retrying on 429. */
  private enqueue<T>(label: string, op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => this.execWithRetry(label, op));
    // Keep the chain alive regardless of individual failures.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execWithRetry<T>(label: string, op: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await op();
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 429) {
          const retryAfter = e.parameters?.retry_after ?? 1;
          this.log.warn("429 — honoring retry_after", { label, retryAfter, attempt });
          await sleep(retryAfter * 1000);
          continue;
        }
        this.log.error("telegram write failed", { label, attempt, ...errFields(e) });
        throw e;
      }
    }
  }

  /** Stream/update the ephemeral draft (animated on repeat draft_id). */
  sendDraft(draftId: number, text: string): Promise<true> {
    return this.enqueue("sendMessageDraft", () =>
      this.api.raw.sendMessageDraft({
        chat_id: this.route.chatId,
        draft_id: draftId,
        text,
        ...this.thread,
      }),
    );
  }

  /** Persist a real message (finalize / greeting / error). */
  persist(text: string, extra?: Fields): Promise<Message> {
    return this.enqueue("sendMessage", () =>
      this.api.sendMessage(this.route.chatId, text, { ...this.thread, ...(extra as object) }),
    );
  }

  /** photo may be an InputFile (upload) or a file_id/URL string (re-send). */
  sendPhoto(photo: InputFile | string, opts?: { caption?: string; has_spoiler?: boolean }): Promise<Message> {
    return this.enqueue("sendPhoto", () => this.api.sendPhoto(this.route.chatId, photo, { ...this.thread, ...opts }));
  }

  sendDocument(doc: InputFile | string, opts?: { caption?: string }): Promise<Message> {
    return this.enqueue("sendDocument", () => this.api.sendDocument(this.route.chatId, doc, { ...this.thread, ...opts }));
  }

  sendVoice(voice: InputFile | string, opts?: { duration?: number; caption?: string }): Promise<Message> {
    return this.enqueue("sendVoice", () => this.api.sendVoice(this.route.chatId, voice, { ...this.thread, ...opts }));
  }

  sendMediaGroup(media: readonly InputMediaPhoto[] | readonly InputMediaDocument[]): Promise<Message[]> {
    return this.enqueue("sendMediaGroup", () => this.api.sendMediaGroup(this.route.chatId, media, { ...this.thread }));
  }

  sendLocation(latitude: number, longitude: number): Promise<Message> {
    return this.enqueue("sendLocation", () => this.api.sendLocation(this.route.chatId, latitude, longitude, { ...this.thread }));
  }

  sendVenue(latitude: number, longitude: number, title: string, address: string): Promise<Message> {
    return this.enqueue("sendVenue", () => this.api.sendVenue(this.route.chatId, latitude, longitude, title, address, { ...this.thread }));
  }

  pin(messageId: number): Promise<true> {
    return this.enqueue("pinChatMessage", () => this.api.pinChatMessage(this.route.chatId, messageId, { disable_notification: true }));
  }

  unpinAll(): Promise<true> {
    return this.enqueue("unpinAll", () =>
      this.route.threadId !== undefined
        ? this.api.unpinAllForumTopicMessages(this.route.chatId, this.route.threadId)
        : this.api.unpinAllChatMessages(this.route.chatId),
    );
  }

  editText(messageId: number, text: string): Promise<unknown> {
    return this.enqueue("editMessageText", () => this.api.editMessageText(this.route.chatId, messageId, text));
  }

  deleteMessage(messageId: number): Promise<true> {
    return this.enqueue("deleteMessage", () => this.api.deleteMessage(this.route.chatId, messageId));
  }

  /** Resolve once everything enqueued so far has been sent (ordering barrier). */
  async flush(): Promise<void> {
    await this.tail.catch(() => {});
  }

  /** Send a chat action ("typing", "record_voice", …). Best-effort, not queued
   * (a status ping that must not block or be blocked by message sends). Auto-expires. */
  async sendChatAction(action: string): Promise<void> {
    try {
      await this.api.sendChatAction(this.route.chatId, action as never, this.thread);
    } catch (e) {
      this.log.debug("sendChatAction failed", errFields(e));
    }
  }

  /** Set a single reaction on a message (§10). Emoji must be a Telegram-permitted reaction. */
  react(messageId: number, emoji: string): Promise<true> {
    return this.enqueue("setMessageReaction", () =>
      this.api.setMessageReaction(this.route.chatId, messageId, [{ type: "emoji", emoji: emoji as never }]),
    );
  }
}
