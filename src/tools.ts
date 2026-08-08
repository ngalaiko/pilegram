/**
 * Per-route pi tools (tg_*). Registered via createAgentSession({ customTools }),
 * each closing over the route's Writer + media cache. This is the §11/Q4
 * mechanism; M5 (tg_ask/tg_confirm) and M7 (tg_send_voice) plug in here too.
 *
 * Convention (pi): throw on failure — the runtime marks the tool result as an
 * error the agent can react to.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { InputFile } from "grammy";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { Db } from "./db.ts";
import { guessMime, sha256 } from "./media.ts";
import { type QuestionRegistry, renderQuestionKeyboard } from "./questions.ts";
import type { Route, TurnRef } from "./route.ts";
import type { Scheduler } from "./scheduler.ts";
import { stripUnsafe } from "./sanitize.ts";
import type { Voice } from "./voice.ts";
import type { Writer } from "./writer.ts";

const PHOTO_MAX = 10 * 1024 * 1024; // Telegram photo cap (§6); larger must go as a document

export interface RouteToolContext {
  writer: Writer;
  db: Db;
  workspaceDir: string;
  questions: QuestionRegistry;
  turn: TurnRef;
  voice?: Voice;
  /** Update this topic's title/icon (no-op-safe; throws in the General thread). */
  setTopic: (opts: { name?: string; icon?: string }) => Promise<void>;
  /** The emojis allowed as topic icons (for tg_set_topic's description). */
  iconEmojis: string[];
  /** Current route; schedule_create uses its chat as the home for the task topic. */
  route: Route;
  /** LLM-managed scheduled task service, if enabled. */
  scheduler?: Scheduler;
}

/** Send a question with tappable options; resolves to the chosen option text(s). */
function askQuestion(
  ctx: RouteToolContext,
  question: string,
  options: string[],
  opts: { multi: boolean; timeoutSec?: number },
  signal: AbortSignal | undefined,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    function onAbort() {
      finish(() => {
        ctx.questions.cancel(id);
        reject(new Error("question cancelled"));
      });
    }

    const id = ctx.questions.create(options, opts.multi, (indices) => {
      finish(() => (indices === null ? reject(new Error("question dismissed")) : resolve(indices.map((i) => options[i]!))));
    });

    const keyboard = renderQuestionKeyboard(id, options, new Set(), opts.multi);
    ctx.writer.persist(stripUnsafe(question), { reply_markup: keyboard }).catch((e) => {
      finish(() => {
        ctx.questions.cancel(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });

    if (opts.timeoutSec && opts.timeoutSec > 0) {
      timer = setTimeout(
        () =>
          finish(() => {
            ctx.questions.cancel(id);
            reject(new Error(`question timed out after ${opts.timeoutSec}s`));
          }),
        opts.timeoutSec * 1000,
      );
    }
    signal?.addEventListener("abort", onAbort);
  });
}

function resolve(workspaceDir: string, p: string): string {
  return isAbsolute(p) ? p : join(workspaceDir, p);
}

function readOrThrow(workspaceDir: string, p: string): { path: string; bytes: Buffer } {
  const path = resolve(workspaceDir, p);
  if (!existsSync(path)) throw new Error(`file not found: ${p}`);
  return { path, bytes: readFileSync(path) };
}

export function buildRouteTools(ctx: RouteToolContext): ToolDefinition[] {
  const sendPhoto = defineTool({
    name: "tg_send_photo",
    label: "Send Photo",
    description:
      "Send an image to the user in this Telegram chat. Use for charts, screenshots, or images you produced. Max 10MB (send larger images with tg_send_document).",
    promptSnippet: "tg_send_photo({path, caption?, spoiler?}) — send an image to the user",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image (absolute, or relative to the workspace)." }),
      caption: Type.Optional(Type.String({ description: "Optional caption." })),
      spoiler: Type.Optional(Type.Boolean({ description: "Hide behind a spoiler until tapped." })),
    }),
    async execute(_id, params) {
      const { path, bytes } = readOrThrow(ctx.workspaceDir, params.path);
      if (bytes.byteLength > PHOTO_MAX) throw new Error("image exceeds Telegram's 10MB photo cap — use tg_send_document");
      const hash = sha256(bytes);
      const cached = ctx.db.getMediaFileId(hash);
      const opts = { caption: params.caption, has_spoiler: params.spoiler };
      const msg = cached
        ? await ctx.writer.sendPhoto(cached, opts)
        : await ctx.writer.sendPhoto(new InputFile(bytes, basename(path)), opts);
      const largest = msg.photo?.at(-1);
      if (largest) ctx.db.putMedia(hash, largest.file_id, largest.file_unique_id, guessMime(path, "image/jpeg"), "photo");
      return { content: [{ type: "text" as const, text: `Sent photo (message_id ${msg.message_id}).` }], details: {} };
    },
  });

  const sendDocument = defineTool({
    name: "tg_send_document",
    label: "Send Document",
    description: "Send a file to the user in this Telegram chat (any type). Use for logs, generated files, or large images.",
    promptSnippet: "tg_send_document({path, caption?}) — send a file to the user",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file (absolute, or relative to the workspace)." }),
      caption: Type.Optional(Type.String({ description: "Optional caption." })),
    }),
    async execute(_id, params) {
      const { path, bytes } = readOrThrow(ctx.workspaceDir, params.path);
      const hash = sha256(bytes);
      const cached = ctx.db.getMediaFileId(hash);
      const opts = { caption: params.caption };
      const msg = cached
        ? await ctx.writer.sendDocument(cached, opts)
        : await ctx.writer.sendDocument(new InputFile(bytes, basename(path)), opts);
      const doc = msg.document;
      if (doc) ctx.db.putMedia(hash, doc.file_id, doc.file_unique_id, doc.mime_type ?? guessMime(path), "document");
      return { content: [{ type: "text" as const, text: `Sent ${basename(path)} (message_id ${msg.message_id}).` }], details: {} };
    },
  });

  const ask = defineTool({
    name: "tg_ask",
    label: "Ask User",
    description:
      "Ask the user a question with tappable options and wait for their answer. Prefer this over asking in prose when there are discrete options. Set multiSelect to let the user pick several (they tick options, then tap Done). Returns the chosen option(s).",
    promptSnippet: "tg_ask({question, options[], multiSelect?}) — ask the user to pick option(s)",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.String(), { minItems: 2, maxItems: 8 }),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow picking multiple options (tick + Done)." })),
      timeoutSec: Type.Optional(Type.Number({ description: "Auto-cancel after this many seconds." })),
    }),
    async execute(_id, params, signal) {
      const chosen = await askQuestion(ctx, params.question, params.options, { multi: params.multiSelect ?? false, timeoutSec: params.timeoutSec }, signal);
      const text = chosen.length === 0 ? "(none selected)" : chosen.join(", ");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  const confirm = defineTool({
    name: "tg_confirm",
    label: "Confirm",
    description: 'Ask the user a yes/no question with tappable Yes/No buttons and wait. Returns "Yes" or "No".',
    promptSnippet: "tg_confirm({question}) — ask the user to confirm (Yes/No)",
    parameters: Type.Object({
      question: Type.String(),
      timeoutSec: Type.Optional(Type.Number({ description: "Auto-cancel after this many seconds." })),
    }),
    async execute(_id, params, signal) {
      const chosen = await askQuestion(ctx, params.question, ["Yes", "No"], { multi: false, timeoutSec: params.timeoutSec }, signal);
      return { content: [{ type: "text" as const, text: chosen[0] ?? "No" }], details: {} };
    },
  });

  const react = defineTool({
    name: "tg_react",
    label: "React",
    description:
      "React with a single emoji instead of a text reply. Prefer this for acknowledgements / messages that don't need words (e.g. 👍 👎 ❤ 🔥 🎉 🙏 👀 🤔 😁 💯 🤯 👌). Defaults to the user's current message; pass messageId to react to any other message.",
    promptSnippet: "tg_react({emoji, messageId?}) — react to a message instead of replying in text",
    parameters: Type.Object({
      emoji: Type.String({ description: "A single emoji from Telegram's reaction set." }),
      messageId: Type.Optional(Type.Number({ description: "Message to react to; defaults to the current message." })),
    }),
    async execute(_id, params) {
      const messageId = params.messageId ?? ctx.turn.messageId;
      if (messageId === undefined) throw new Error("no message to react to");
      await ctx.writer.react(messageId, params.emoji.trim());
      return { content: [{ type: "text" as const, text: `Reacted ${params.emoji}.` }], details: {} };
    },
  });

  const sendAlbum = defineTool({
    name: "tg_send_album",
    label: "Send Album",
    description:
      "Send several images (or several files) as one Telegram album. Items must be the same kind — images group as photos, anything else as documents. 2-10 items; caption goes on the first.",
    promptSnippet: "tg_send_album({paths[], caption?}) — send several images/files as one album",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 2, maxItems: 10 }),
      caption: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const items = params.paths.map((p) => readOrThrow(ctx.workspaceDir, p));
      const allImages = items.every((it) => /\.(jpe?g|png|gif|webp)$/i.test(it.path));
      const file = (it: { path: string; bytes: Buffer }) => new InputFile(it.bytes, basename(it.path));
      const cap = (i: number) => (i === 0 && params.caption ? { caption: params.caption } : {});
      const media = allImages
        ? items.map((it, i) => ({ type: "photo" as const, media: file(it), ...cap(i) }))
        : items.map((it, i) => ({ type: "document" as const, media: file(it), ...cap(i) }));
      const msgs = await ctx.writer.sendMediaGroup(media);
      return { content: [{ type: "text" as const, text: `Sent album of ${msgs.length} (message_ids: ${msgs.map((m) => m.message_id).join(", ")}).` }], details: {} };
    },
  });

  const sendLocation = defineTool({
    name: "tg_send_location",
    label: "Send Location",
    description: "Share a location on the map. If title and address are given, sends a named venue; otherwise a plain pin.",
    promptSnippet: "tg_send_location({latitude, longitude, title?, address?})",
    parameters: Type.Object({
      latitude: Type.Number(),
      longitude: Type.Number(),
      title: Type.Optional(Type.String()),
      address: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const msg =
        params.title && params.address
          ? await ctx.writer.sendVenue(params.latitude, params.longitude, params.title, params.address)
          : await ctx.writer.sendLocation(params.latitude, params.longitude);
      return { content: [{ type: "text" as const, text: `Sent location (message_id ${msg.message_id}).` }], details: {} };
    },
  });

  const pin = defineTool({
    name: "tg_pin",
    label: "Pin Note",
    description: "Post a short note and pin it in this chat/topic so it stays visible (e.g. a summary or key result). Use tg_unpin to clear pins.",
    promptSnippet: "tg_pin({text}) — post and pin a note",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      const msg = await ctx.writer.persist(params.text);
      await ctx.writer.pin(msg.message_id);
      return { content: [{ type: "text" as const, text: `Pinned (message_id ${msg.message_id}).` }], details: {} };
    },
  });

  const unpin = defineTool({
    name: "tg_unpin",
    label: "Unpin",
    description: "Unpin all pinned messages in this chat/topic.",
    promptSnippet: "tg_unpin() — unpin all pinned messages here",
    parameters: Type.Object({}),
    async execute() {
      await ctx.writer.unpinAll();
      return { content: [{ type: "text" as const, text: "Unpinned all messages." }], details: {} };
    },
  });

  const editMessage = defineTool({
    name: "tg_edit",
    label: "Edit Message",
    description: "Edit the text of a message you previously sent, by its message_id (returned by the send tools).",
    promptSnippet: "tg_edit({messageId, text}) — edit a message you sent",
    parameters: Type.Object({ messageId: Type.Number(), text: Type.String() }),
    async execute(_id, params) {
      await ctx.writer.editText(params.messageId, params.text);
      return { content: [{ type: "text" as const, text: `Edited message ${params.messageId}.` }], details: {} };
    },
  });

  const deleteMessage = defineTool({
    name: "tg_delete",
    label: "Delete Message",
    description: "Delete a message by its message_id (one you sent, or the user's current message). Telegram only allows deleting messages under 48h old.",
    promptSnippet: "tg_delete({messageId}) — delete a message",
    parameters: Type.Object({ messageId: Type.Number() }),
    async execute(_id, params) {
      await ctx.writer.deleteMessage(params.messageId);
      return { content: [{ type: "text" as const, text: `Deleted message ${params.messageId}.` }], details: {} };
    },
  });

  const setTopic = defineTool({
    name: "tg_set_topic",
    label: "Set Topic",
    description:
      "Set this Telegram topic's title and/or icon to reflect the conversation — keep them relevant as the subject evolves. " +
      `Provide name (a short 2-5 word title) and/or icon (exactly ONE of these allowed emojis): ${ctx.iconEmojis.join(" ")}`,
    promptSnippet: "tg_set_topic({name?, icon?}) — set the topic's title and/or icon",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "New topic title (2-5 words)." })),
      icon: Type.Optional(Type.String({ description: "One of the allowed topic icons." })),
    }),
    async execute(_id, params) {
      if (!params.name && !params.icon) throw new Error("provide name and/or icon");
      await ctx.setTopic({ name: params.name, icon: params.icon });
      const changed = [params.name ? `name → "${params.name}"` : "", params.icon ? `icon → ${params.icon}` : ""].filter(Boolean).join(", ");
      return { content: [{ type: "text" as const, text: `Updated topic ${changed}.` }], details: {} };
    },
  });

  const scheduleCreate = defineTool({
    name: "schedule_create",
    label: "Create Scheduled Task",
    description:
      "Create a recurring scheduled task. Use when the user asks you to run something later or repeatedly. " +
      "Do not expose cron syntax unless asked; infer an appropriate cron expression and timezone. " +
      "Each task gets one dedicated Telegram topic/thread, reused for every execution.",
    promptSnippet: "schedule_create({title, cron, prompt, timezone?}) — create a recurring task with its own thread",
    parameters: Type.Object({
      title: Type.String({ description: "Short human title for the task/thread." }),
      cron: Type.String({ description: "5-field cron expression: minute hour day-of-month month day-of-week." }),
      prompt: Type.String({ description: "Prompt to run at each scheduled time." }),
      timezone: Type.Optional(Type.String({ description: "IANA time zone. Defaults to the gateway timezone." })),
    }),
    async execute(_id, params) {
      if (!ctx.scheduler) throw new Error("scheduler is not available");
      const task = await ctx.scheduler.create(ctx.route, params);
      return { content: [{ type: "text" as const, text: formatTask(task) }], details: {} };
    },
  });

  const scheduleList = defineTool({
    name: "schedule_list",
    label: "List Scheduled Tasks",
    description: "List all scheduled tasks managed by pilegram.",
    promptSnippet: "schedule_list() — list scheduled tasks",
    parameters: Type.Object({}),
    async execute() {
      if (!ctx.scheduler) throw new Error("scheduler is not available");
      const tasks = ctx.scheduler.list();
      return { content: [{ type: "text" as const, text: tasks.length ? tasks.map(formatTask).join("\n\n") : "No scheduled tasks." }], details: {} };
    },
  });

  const scheduleUpdate = defineTool({
    name: "schedule_update",
    label: "Update Scheduled Task",
    description: "Update a scheduled task's title, cron, timezone, prompt, or enabled state.",
    promptSnippet: "schedule_update({id, title?, cron?, prompt?, timezone?, enabled?}) — update a task",
    parameters: Type.Object({
      id: Type.String(),
      title: Type.Optional(Type.String()),
      cron: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      timezone: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      if (!ctx.scheduler) throw new Error("scheduler is not available");
      return { content: [{ type: "text" as const, text: formatTask(ctx.scheduler.update(params)) }], details: {} };
    },
  });

  const schedulePause = defineTool({
    name: "schedule_pause",
    label: "Pause Scheduled Task",
    description: "Pause a scheduled task without deleting it.",
    promptSnippet: "schedule_pause({id}) — pause a task",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      if (!ctx.scheduler) throw new Error("scheduler is not available");
      return { content: [{ type: "text" as const, text: formatTask(ctx.scheduler.pause(params.id)) }], details: {} };
    },
  });

  const scheduleResume = defineTool({
    name: "schedule_resume",
    label: "Resume Scheduled Task",
    description: "Resume a paused scheduled task and recompute its next run.",
    promptSnippet: "schedule_resume({id}) — resume a task",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      if (!ctx.scheduler) throw new Error("scheduler is not available");
      return { content: [{ type: "text" as const, text: formatTask(ctx.scheduler.resume(params.id)) }], details: {} };
    },
  });

  const scheduleDelete = defineTool({
    name: "schedule_delete",
    label: "Delete Scheduled Task",
    description: "Delete a scheduled task. Its existing Telegram topic is left in place for history.",
    promptSnippet: "schedule_delete({id}) — delete a task",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      if (!ctx.scheduler) throw new Error("scheduler is not available");
      ctx.scheduler.delete(params.id);
      return { content: [{ type: "text" as const, text: `Deleted scheduled task ${params.id}.` }], details: {} };
    },
  });

  const tools: ToolDefinition[] = [
    sendPhoto,
    sendDocument,
    ask,
    confirm,
    react,
    sendAlbum,
    sendLocation,
    pin,
    unpin,
    editMessage,
    deleteMessage,
    setTopic,
    scheduleCreate,
    scheduleList,
    scheduleUpdate,
    schedulePause,
    scheduleResume,
    scheduleDelete,
  ];

  if (ctx.voice) {
    const voice = ctx.voice;
    tools.push(
      defineTool({
        name: "tg_send_voice",
        label: "Send Voice",
        description:
          "Speak a reply as a voice note (local TTS). Always accompany voice with the text too — voice alone is unsearchable. Provide `text` to synthesize, or `path` to an existing audio file.",
        promptSnippet: "tg_send_voice({text?|path?}) — send a spoken voice note",
        parameters: Type.Object({
          text: Type.Optional(Type.String({ description: "Text to speak." })),
          path: Type.Optional(Type.String({ description: "Path to an existing audio file (absolute or workspace-relative)." })),
        }),
        async execute(_id, params) {
          if (params.path) {
            const p = isAbsolute(params.path) ? params.path : join(ctx.workspaceDir, params.path);
            if (!existsSync(p)) throw new Error(`file not found: ${params.path}`);
            await ctx.writer.sendVoice(new InputFile(p));
            return { content: [{ type: "text" as const, text: `Sent voice note (${basename(p)}).` }], details: {} };
          }
          if (params.text) {
            const { path, durationSec } = await voice.synthesize(params.text, join(ctx.workspaceDir, "tts"));
            await ctx.writer.sendVoice(new InputFile(path), { duration: durationSec });
            return { content: [{ type: "text" as const, text: `Sent voice note (${durationSec}s).` }], details: {} };
          }
          throw new Error("tg_send_voice needs either `text` or `path`");
        },
      }),
    );
  }

  return tools;
}

function formatTask(task: {
  id: string;
  title: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  taskChatId: number;
  taskThreadId: number;
}): string {
  const next = new Date(task.nextRunAt).toISOString();
  const last = task.lastRunAt ? new Date(task.lastRunAt).toISOString() : "never";
  return [
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.enabled ? "enabled" : "paused"}`,
    `cron: ${task.cron} (${task.timezone})`,
    `next_run_at: ${next}`,
    `last_run_at: ${last}`,
    `thread: ${task.taskChatId}/${task.taskThreadId}`,
    `prompt: ${task.prompt}`,
  ].join("\n");
}
