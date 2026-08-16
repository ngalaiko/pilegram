/**
 * Router — maps a Route to its Session, backed by the SQLite `routes` table.
 *
 * On first contact a fresh pi session is created and its sessionFile persisted.
 * On a later boot, the same route re-opens THAT sessionFile, so each topic keeps
 * its own context across restarts (the M2 "survives kill -9" property). When a
 * persisted session is re-opened, we reconcile: if its last assistant answer
 * was never rendered to Telegram (crash between turn end and finalize), post it
 * with a "↻ reconnected" marker (plan §14).
 */

import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { GrammyError, type Api } from "grammy";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { contextExtension, MessageLog } from "./context.ts";
import type { Db } from "./db.ts";
import { errFields, log } from "./log.ts";
import type { QuestionRegistry } from "./questions.ts";
import type { Route, TurnRef } from "./route.ts";
import { routeKey } from "./route.ts";
import type { Scheduler } from "./scheduler.ts";
import { Session } from "./session.ts";
import { buildRouteTools } from "./tools.ts";
import type { Voice } from "./voice.ts";
import { Writer } from "./writer.ts";

function sig(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export class Router {
  private readonly sessions = new Map<string, Session>();
  private readonly creating = new Map<string, Promise<Session>>();
  private iconSet?: { emojis: string[]; byEmoji: Map<string, string> };
  private scheduler?: Scheduler;

  constructor(
    private readonly api: Api,
    private readonly config: Config,
    private readonly db: Db,
    private readonly questions: QuestionRegistry,
    private readonly voice: Voice,
  ) {}

  setScheduler(scheduler: Scheduler) {
    this.scheduler = scheduler;
  }

  /** Log known routes at boot (sessions themselves stay lazy). */
  restore() {
    const routes = this.db.listActiveRoutes();
    log.info("routes restored", { count: routes.length });
  }

  async getOrCreate(route: Route, opts?: { name?: string }): Promise<Session> {
    const key = routeKey(route);
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const inflight = this.creating.get(key);
    if (inflight) return inflight;

    const build = this.build(route, opts);
    this.creating.set(key, build);
    try {
      const session = await build;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.creating.delete(key);
    }
  }

  private async build(route: Route, opts?: { name?: string }): Promise<Session> {
    const { chatId } = route;
    const threadId = route.threadId ?? 0;

    const prior = this.db.getRoute(chatId, threadId);
    this.db.ensureRoute(chatId, threadId, opts?.name ?? prior?.name ?? null);

    const reopen = prior?.sessionFile ?? undefined;
    const writer = new Writer(this.api, route);
    // Every route shares the agent's home directory as its working directory —
    // there's no per-route workspace isolation. Each route still gets its own pi
    // session (persisted via session_file); only the filesystem cwd is shared.
    const workspace = homedir();
    const turn: TurnRef = {}; // shared current-message pointer for tg_react
    const messageLog = new MessageLog(); // rolling message-id table for context injection (§15)
    const isTopic = threadId !== 0;
    // Fetch once per router. Topic creation is available from General too.
    const iconEmojis = (await this.icons()).emojis;

    // Resource loader carrying the per-turn context-injection extension.
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir: getAgentDir(),
      extensionFactories: [
        contextExtension({
          log: messageLog,
          timeZone: this.config.timeZone,
          isTopic,
          topicName: () => this.db.getRoute(chatId, threadId)?.name ?? undefined,
          topicIcon: () => this.db.getRoute(chatId, threadId)?.icon ?? undefined,
        }),
      ],
    });
    await resourceLoader.reload();

    const session = await Session.create({
      route,
      writer,
      workspaceDir: workspace,
      sessionFile: reopen,
      voice: this.voice,
      turn,
      messageLog,
      resourceLoader,
      customTools: buildRouteTools({
        writer,
        db: this.db,
        workspaceDir: workspace,
        questions: this.questions,
        voice: this.voice,
        turn,
        iconEmojis,
        route,
        scheduler: this.scheduler,
        createTopic: (o) => this.createTopic(route.chatId, o),
        deleteTopic: (topicThreadId) => this.deleteTopic(route.chatId, topicThreadId),
        setTopic: (o) => this.renameTopic(route, { name: o.name, iconEmoji: o.icon }),
      }),
      onFinalized: (text) => {
        if (text && text.trim() !== "") this.db.setRouteLastRenderedSig(chatId, threadId, sig(text));
      },
    });

    if (!reopen) {
      this.db.setRouteSessionFile(chatId, threadId, session.sessionFile ?? null);
    }
    if (opts?.name) {
      session.setName(opts.name);
      this.db.setRouteName(chatId, threadId, opts.name);
    }
    if (reopen) this.reconcile(route, session, prior?.lastRenderedSig ?? null, writer);

    return session;
  }

  /** Post an answer that settled but was never rendered before a crash. */
  private reconcile(route: Route, session: Session, priorSig: string | null, writer: Writer) {
    const last = session.lastAssistantText();
    if (!last || last.trim() === "") return;
    if (sig(last) === priorSig) return; // already rendered
    log.info("reconciling unrendered answer", { route: routeKey(route) });
    writer.persist(`↻ reconnected\n\n${last}`).catch((e) => log.error("reconcile persist failed", errFields(e)));
    this.db.setRouteLastRenderedSig(route.chatId, route.threadId ?? 0, sig(last));
  }

  /** Telegram's allowed topic-icon custom-emoji set (fetched once). */
  private async icons(): Promise<{ emojis: string[]; byEmoji: Map<string, string> }> {
    if (!this.iconSet) {
      const byEmoji = new Map<string, string>();
      try {
        for (const s of await this.api.getForumTopicIconStickers()) {
          if (s.custom_emoji_id && s.emoji && !byEmoji.has(s.emoji)) byEmoji.set(s.emoji, s.custom_emoji_id);
        }
      } catch (e) {
        log.warn("getForumTopicIconStickers failed", errFields(e));
      }
      this.iconSet = { emojis: [...byEmoji.keys()], byEmoji };
    }
    return this.iconSet;
  }

  /** Create a forum topic and persist its route without eagerly starting pi. */
  async createTopic(chatId: number, opts: { name: string; icon?: string }): Promise<Route> {
    const name = cleanTopicName(opts.name);
    const icon_custom_emoji_id = opts.icon ? (await this.iconId(opts.icon)) : undefined;
    const topic = await this.api.createForumTopic(chatId, name, icon_custom_emoji_id ? { icon_custom_emoji_id } : undefined);
    const route: Route = { chatId, threadId: topic.message_thread_id };
    this.register(route, name);
    if (opts.icon) this.db.setRouteIcon(chatId, route.threadId!, opts.icon);
    return route;
  }

  /** Permanently delete a topic and dispose its associated agent session. */
  async deleteTopic(chatId: number, threadId: number): Promise<void> {
    if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new Error("provide a valid non-General topic thread id");
    try {
      await this.api.deleteForumTopic(chatId, threadId);
    } catch (e) {
      if (!isMissingTopic(e)) throw e;
      log.warn("topic already missing while deleting; marking route ended", { chatId, threadId, ...errFields(e) });
    }
    this.endRoute({ chatId, threadId });
  }

  /** Rename and/or re-icon a topic (shared by auto-title and the tg_set_topic tool). */
  async renameTopic(route: Route, opts: { name?: string; iconEmoji?: string }): Promise<void> {
    const threadId = route.threadId;
    if (threadId === undefined || threadId === 0) throw new Error("the General thread has no topic to rename");
    const edit: { name?: string; icon_custom_emoji_id?: string } = {};
    if (opts.name) edit.name = opts.name;
    if (opts.iconEmoji) edit.icon_custom_emoji_id = await this.iconId(opts.iconEmoji);
    if (edit.name === undefined && edit.icon_custom_emoji_id === undefined) return;
    await this.api.editForumTopic(route.chatId, threadId, edit);
    if (opts.name) {
      this.db.setRouteName(route.chatId, threadId, opts.name);
      this.sessions.get(routeKey(route))?.setName(opts.name);
    }
    if (opts.iconEmoji) this.db.setRouteIcon(route.chatId, threadId, opts.iconEmoji);
  }

  private async iconId(iconEmoji: string): Promise<string> {
    const id = (await this.icons()).byEmoji.get(iconEmoji);
    if (!id) throw new Error(`no topic icon available for ${iconEmoji}`);
    return id;
  }

  /** Persist a route without spawning its session (lazy — e.g. UI-created topic). */
  register(route: Route, name?: string) {
    this.db.ensureRoute(route.chatId, route.threadId ?? 0, name ?? null);
    if (name) this.db.setRouteName(route.chatId, route.threadId ?? 0, name);
  }

  /** Rename (forum_topic_edited): sync pi session name + persist. */
  setName(route: Route, name: string) {
    this.db.ensureRoute(route.chatId, route.threadId ?? 0, name);
    this.db.setRouteName(route.chatId, route.threadId ?? 0, name);
    const s = this.sessions.get(routeKey(route));
    if (s) s.setName(name);
  }

  /**
   * Drop the in-memory session (e.g. its topic was closed) without ending the
   * route. It rebuilds and resumes from its persisted session file the next time
   * a message or scheduled task arrives, so context is preserved on reopen.
   */
  suspend(route: Route) {
    const key = routeKey(route);
    const s = this.sessions.get(key);
    if (!s) return;
    s.dispose();
    this.sessions.delete(key);
    log.info("session suspended (topic closed)", { route: key });
  }

  /** End a route (/end or topic deleted): dispose + mark ended. */
  endRoute(route: Route) {
    const key = routeKey(route);
    const s = this.sessions.get(key);
    if (s) {
      s.dispose();
      this.sessions.delete(key);
    }
    this.db.setRouteStatus(route.chatId, route.threadId ?? 0, "ended");
  }

  disposeAll() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

function cleanTopicName(raw: string): string {
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 1 || name.length > 128) throw new Error("topic name must be 1-128 characters");
  return name;
}

function isMissingTopic(e: unknown): boolean {
  if (!(e instanceof GrammyError)) return false;
  if (e.error_code !== 400) return false;
  return /TOPIC_ID_INVALID|thread|topic|message thread/i.test(e.description ?? "");
}
