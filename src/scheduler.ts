import { GrammyError, type Api } from "grammy";
import { randomUUID } from "node:crypto";
import { nextCronRun } from "./cron.ts";
import type { Config } from "./config.ts";
import type { Db, ScheduledTaskRow } from "./db.ts";
import { errFields, log as rootLog } from "./log.ts";
import type { Route } from "./route.ts";
import { Router } from "./router.ts";

const POLL_MS = 30_000;
const ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

export interface ScheduleCreateParams {
  title: string;
  cron: string;
  prompt: string;
  timezone?: string;
}

export interface NotificationCreateParams {
  title: string;
  prompt: string;
  runAt?: string;
  delaySeconds?: number;
}

export interface ScheduleUpdateParams {
  id: string;
  title?: string;
  cron?: string;
  prompt?: string;
  timezone?: string;
  enabled?: boolean;
}

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly log = rootLog.child({ component: "scheduler" });

  constructor(
    private readonly api: Api,
    private readonly config: Config,
    private readonly db: Db,
    private readonly router: Router,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    void this.tick();
    this.log.info("scheduler started");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async create(source: Route, params: ScheduleCreateParams): Promise<ScheduledTaskRow> {
    const title = cleanTitle(params.title);
    const timezone = params.timezone?.trim() || this.config.timeZone;
    const prompt = params.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    const nextRunAt = nextCronRun(params.cron, timezone);
    const topic = await this.api.createForumTopic(source.chatId, `📆 ${title}`);
    const taskRoute: Route = { chatId: source.chatId, threadId: topic.message_thread_id };
    this.router.register(taskRoute, `📆 ${title}`);

    const now = Date.now();
    const task: ScheduledTaskRow = {
      id: randomUUID(),
      kind: "recurring",
      sourceChatId: source.chatId,
      sourceThreadId: source.threadId ?? 0,
      taskChatId: taskRoute.chatId,
      taskThreadId: taskRoute.threadId ?? 0,
      title,
      cron: params.cron.trim(),
      timezone,
      prompt,
      enabled: true,
      nextRunAt,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.createScheduledTask(task);
    return task;
  }

  createNotification(source: Route, params: NotificationCreateParams): ScheduledTaskRow {
    const title = cleanTitle(params.title);
    const prompt = params.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    const nextRunAt = notificationRunAt(params);
    const now = Date.now();
    const task: ScheduledTaskRow = {
      id: randomUUID(),
      kind: "one_off",
      sourceChatId: source.chatId,
      sourceThreadId: source.threadId ?? 0,
      taskChatId: source.chatId,
      taskThreadId: source.threadId ?? 0,
      title,
      cron: "",
      timezone: this.config.timeZone,
      prompt,
      enabled: true,
      nextRunAt,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.createScheduledTask(task);
    return task;
  }

  list(): ScheduledTaskRow[] {
    return this.db.listScheduledTasks();
  }

  update(params: ScheduleUpdateParams): ScheduledTaskRow {
    if (!ID_RE.test(params.id)) throw new Error("invalid task id");
    const current = this.db.getScheduledTask(params.id);
    if (!current) throw new Error(`scheduled task not found: ${params.id}`);
    if (current.kind !== "recurring") throw new Error(`not a recurring scheduled task: ${params.id}`);
    const cron = params.cron?.trim() ?? current.cron;
    const timezone = params.timezone?.trim() || current.timezone;
    const prompt = params.prompt?.trim() ?? current.prompt;
    const title = params.title === undefined ? current.title : cleanTitle(params.title);
    const enabled = params.enabled ?? current.enabled;
    const nextRunAt = enabled ? nextCronRun(cron, timezone) : current.nextRunAt;
    this.db.updateScheduledTask(params.id, { title, cron, timezone, prompt, enabled, nextRunAt });
    const updated = this.db.getScheduledTask(params.id)!;
    if (title !== current.title) {
      void this.router.renameTopic({ chatId: updated.taskChatId, threadId: updated.taskThreadId }, { name: `📆 ${title}` }).catch((e) =>
        this.log.warn("failed to rename scheduled-task topic", { id: params.id, ...errFields(e) }),
      );
    }
    return updated;
  }

  pause(id: string): ScheduledTaskRow {
    return this.update({ id, enabled: false });
  }

  resume(id: string): ScheduledTaskRow {
    return this.update({ id, enabled: true });
  }

  delete(id: string) {
    if (!ID_RE.test(id)) throw new Error("invalid task id");
    const current = this.db.getScheduledTask(id);
    if (!current) throw new Error(`scheduled task not found: ${id}`);
    this.db.deleteScheduledTask(id);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const due = this.db.listDueScheduledTasks(Date.now());
      for (const task of due) await this.runTask(task).catch((e) => this.log.error("scheduled task failed", { id: task.id, ...errFields(e) }));
    } finally {
      this.running = false;
    }
  }

  private async runTask(task: ScheduledTaskRow) {
    const now = Date.now();
    const nextRunAt = task.kind === "recurring" ? nextCronRun(task.cron, task.timezone, new Date(now)) : now;
    // Advance before dispatch so a crash/restart never tight-loops the same due task.
    if (task.kind === "recurring") this.db.updateScheduledTask(task.id, { lastRunAt: now, nextRunAt });
    else this.db.updateScheduledTask(task.id, { lastRunAt: now, enabled: false, nextRunAt });
    try {
      await this.dispatch(task);
    } catch (e) {
      if (!isMissingThread(e)) throw e;
      this.log.warn("scheduled-task topic is missing; recreating", { id: task.id, title: task.title, ...errFields(e) });
      const recovered = await this.recreateTaskTopic(task);
      await this.dispatch(recovered);
    }
  }

  private async dispatch(task: ScheduledTaskRow) {
    const route: Route = { chatId: task.taskChatId, threadId: task.taskThreadId };
    const session = await this.router.getOrCreate(route, { name: task.kind === "recurring" ? `📆 ${task.title}` : undefined });
    await session.notify(task.kind === "recurring" ? `⏰ Scheduled task: ${task.title}` : `🔔 ${task.title}`);
    const label = task.kind === "recurring" ? "scheduled task" : "one-off notification";
    await session.handlePrompt(`[${label}: ${task.title}]\n${task.prompt}`);
  }

  private async recreateTaskTopic(task: ScheduledTaskRow): Promise<ScheduledTaskRow> {
    if (task.kind !== "recurring") throw new Error("one-off notification target thread is missing");
    const oldRoute: Route = { chatId: task.taskChatId, threadId: task.taskThreadId };
    this.router.endRoute(oldRoute);
    const topic = await this.api.createForumTopic(task.taskChatId, `📆 ${task.title}`);
    const newRoute: Route = { chatId: task.taskChatId, threadId: topic.message_thread_id };
    this.router.register(newRoute, `📆 ${task.title}`);
    this.db.setScheduledTaskRoute(task.id, newRoute.chatId, newRoute.threadId ?? 0);
    return this.db.getScheduledTask(task.id)!;
  }
}

function isMissingThread(e: unknown): boolean {
  if (!(e instanceof GrammyError)) return false;
  if (e.error_code !== 400) return false;
  return /thread|topic|message thread/i.test(e.description ?? "");
}

function notificationRunAt(params: NotificationCreateParams): number {
  if (params.delaySeconds !== undefined) {
    if (!Number.isFinite(params.delaySeconds) || params.delaySeconds <= 0) throw new Error("delaySeconds must be positive");
    return Date.now() + Math.ceil(params.delaySeconds * 1000);
  }
  if (!params.runAt) throw new Error("provide runAt or delaySeconds");
  const t = Date.parse(params.runAt);
  if (!Number.isFinite(t)) throw new Error("runAt must be an absolute RFC3339/ISO timestamp");
  if (t <= Date.now()) throw new Error("runAt must be in the future");
  return t;
}

function cleanTitle(raw: string): string {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length < 1 || title.length > 80) throw new Error("title must be 1-80 characters");
  return title;
}
