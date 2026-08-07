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
import type { Api } from "grammy";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { contextExtension, MessageLog } from "./context.ts";
import type { Db } from "./db.ts";
import { errFields, log } from "./log.ts";
import type { QuestionRegistry } from "./questions.ts";
import type { Route, TurnRef } from "./route.ts";
import { routeKey } from "./route.ts";
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

  constructor(
    private readonly api: Api,
    private readonly config: Config,
    private readonly db: Db,
    private readonly questions: QuestionRegistry,
    private readonly voice: Voice,
  ) {}

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
    const key = routeKey(route);

    const prior = this.db.getRoute(chatId, threadId);
    this.db.ensureRoute(chatId, threadId, opts?.name ?? prior?.name ?? null);

    const reopen = prior?.sessionFile ?? undefined;
    const writer = new Writer(this.api, route);
    const workspace = join(this.config.stateDir, "workspaces", key);
    const turn: TurnRef = {}; // shared current-message pointer for tg_react
    const messageLog = new MessageLog(); // rolling message-id table for context injection (§15)
    const isTopic = threadId !== 0;
    const iconEmojis = isTopic ? (await this.icons()).emojis : []; // allowed topic-icon emojis, for tg_set_topic

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

  /** Rename and/or re-icon a topic (shared by auto-title and the tg_set_topic tool). */
  async renameTopic(route: Route, opts: { name?: string; iconEmoji?: string }): Promise<void> {
    const threadId = route.threadId;
    if (threadId === undefined || threadId === 0) throw new Error("the General thread has no topic to rename");
    const edit: { name?: string; icon_custom_emoji_id?: string } = {};
    if (opts.name) edit.name = opts.name;
    if (opts.iconEmoji) {
      const id = (await this.icons()).byEmoji.get(opts.iconEmoji);
      if (!id) throw new Error(`no topic icon available for ${opts.iconEmoji}`);
      edit.icon_custom_emoji_id = id;
    }
    if (edit.name === undefined && edit.icon_custom_emoji_id === undefined) return;
    await this.api.editForumTopic(route.chatId, threadId, edit);
    if (opts.name) {
      this.db.setRouteName(route.chatId, threadId, opts.name);
      this.sessions.get(routeKey(route))?.setName(opts.name);
    }
    if (opts.iconEmoji) this.db.setRouteIcon(route.chatId, threadId, opts.iconEmoji);
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
