/**
 * Session — one pi AgentSession bound to one Route, with its event stream
 * wired into the Renderer's draft state machine.
 *
 * Key design choice: prompts are fired *without* awaiting the turn, so the
 * gateway's poll loop never blocks on a running agent — that's what keeps
 * steering (a message arriving mid-turn) possible (plan §12).
 *
 * M2: a Session either opens an existing pi session file (resume, preserving
 * context across restarts) or creates a fresh one; `onFinalized` lets the
 * Router persist a reconciliation signature after every settled turn.
 */

import { createAgentSession, type ResourceLoader, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { InputFile } from "grammy";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MessageLog } from "./context.ts";
import { errFields, log as rootLog } from "./log.ts";
import type { ImageContent } from "./media.ts";
import { Renderer } from "./renderer.ts";
import type { Route } from "./route.ts";
import { routeKey } from "./route.ts";
import type { TurnRef } from "./route.ts";
import type { Voice } from "./voice.ts";
import type { Writer } from "./writer.ts";

type PiSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

// Full coding-agent toolset; the workspace is isolated per route.
const AGENT_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

// tg_send_* tools → the chat action shown while they run.
const MEDIA_ACTION: Record<string, string> = {
  tg_send_photo: "upload_photo",
  tg_send_document: "upload_document",
  tg_send_voice: "upload_voice",
};

export interface SessionOptions {
  route: Route;
  writer: Writer;
  workspaceDir: string;
  /** If set, re-open this pi session file (resume); else create a new one. */
  sessionFile?: string;
  /** Per-route tg_* tools registered with the agent. */
  customTools?: ToolDefinition[];
  /** Shared local-voice engine (STT/TTS); enables spoken replies. */
  voice?: Voice;
  /** Shared pointer to the current message id (so tg_react can target it). */
  turn?: TurnRef;
  /** Resource loader providing the per-turn context-injection extension (§15). */
  resourceLoader?: ResourceLoader;
  /** Rolling log of message ids injected into context, so the model can reference any. */
  messageLog?: MessageLog;
  /** Called after each settled turn with the final assistant text (if any). */
  onFinalized?: (text: string | undefined) => void;
}

export class Session {
  private busy = false;
  private voiceMode = false;
  private spokeThisTurn = false; // set if the agent sent a voice note via tg_send_voice this turn
  private readonly unsubscribe: () => void;
  private readonly log: ReturnType<typeof rootLog.child>;
  private readonly onFinalized?: (text: string | undefined) => void;
  private readonly voice?: Voice;
  private readonly turn?: TurnRef;
  private readonly messageLog?: MessageLog;

  private constructor(
    route: Route,
    private readonly agent: PiSession,
    private readonly renderer: Renderer,
    private readonly writer: Writer,
    readonly workspaceDir: string,
    opts: {
      voice?: Voice;
      turn?: TurnRef;
      messageLog?: MessageLog;
      onFinalized?: (t: string | undefined) => void;
    },
  ) {
    this.voice = opts.voice;
    this.turn = opts.turn;
    this.messageLog = opts.messageLog;
    this.onFinalized = opts.onFinalized;
    this.log = rootLog.child({ route: routeKey(route) });
    this.unsubscribe = this.agent.subscribe((event) => this.onEvent(event));
    this.log.info("session ready", { sessionFile: this.agent.sessionFile ?? null });
  }

  static async create(opts: SessionOptions): Promise<Session> {
    mkdirSync(opts.workspaceDir, { recursive: true });
    const sessionManager = opts.sessionFile
      ? SessionManager.open(opts.sessionFile)
      : SessionManager.create(opts.workspaceDir);
    const customNames = (opts.customTools ?? []).map((t) => t.name);
    // Installed pi extensions register their tools at load time, but `tools` is a
    // hard allowlist — any name it omits is dropped, so without this the agent
    // can never call anything an installed extension provides (its hooks still
    // run; only its tools were being filtered out). Enumerate them from the
    // already-reloaded resource loader and allow them through, per docs/sdk.md:
    // "If you pass `tools`, include each custom or extension tool name you want
    // enabled." Keeping the allowlist (vs dropping it) preserves grep/find/ls,
    // which are otherwise inactive by default.
    const extensionNames = (opts.resourceLoader?.getExtensions().extensions ?? []).flatMap((e) => [...e.tools.keys()]);
    const { session } = await createAgentSession({
      cwd: opts.workspaceDir,
      // Allowlist over ALL tools: built-in coding tools, our custom tg_* tools, and installed-extension tools.
      tools: [...new Set([...AGENT_TOOLS, ...customNames, ...extensionNames])],
      customTools: opts.customTools,
      sessionManager,
      resourceLoader: opts.resourceLoader,
    });
    // Deliver steering one message at a time (§12); "all" produces incoherent turns.
    session.setSteeringMode("one-at-a-time");
    const onSent = opts.messageLog ? (id: number, text: string) => opts.messageLog!.add(id, "bot", text) : undefined;
    const renderer = new Renderer(opts.writer, opts.route, onSent);
    return new Session(opts.route, session, renderer, opts.writer, opts.workspaceDir, {
      voice: opts.voice,
      turn: opts.turn,
      messageLog: opts.messageLog,
      onFinalized: opts.onFinalized,
    });
  }

  get sessionFile(): string | undefined {
    return this.agent.sessionFile;
  }

  lastAssistantText(): string | undefined {
    return this.agent.getLastAssistantText();
  }

  setName(name: string) {
    this.agent.setSessionName(name);
  }

  private onEvent(event: Parameters<Parameters<PiSession["subscribe"]>[0]>[0]) {
    switch (event.type) {
      case "agent_start":
        this.spokeThisTurn = false;
        this.renderer.onAgentStart();
        break;
      case "message_update": {
        const a = event.assistantMessageEvent;
        if (a.type === "text_delta") this.renderer.onText(a.delta);
        else if (a.type === "thinking_delta") this.renderer.onThinking(a.delta);
        break;
      }
      case "tool_execution_start": {
        // tg_send_* → a media chat action ("uploading…"); other tg_* (react/ask) → nothing.
        // Non-tg tools → the in-draft "🔧 …" status line.
        if (event.toolName === "tg_send_voice") this.spokeThisTurn = true; // don't also auto-speak
        const media = MEDIA_ACTION[event.toolName];
        if (media) this.renderer.setMediaAction(media);
        else if (!event.toolName.startsWith("tg_")) this.renderer.onToolStart(event.toolName, event.args);
        break;
      }
      case "tool_execution_end":
        this.renderer.setMediaAction(undefined);
        this.renderer.onToolEnd();
        break;
      case "queue_update":
        this.renderer.setQueueDepth(event.steering.length);
        break;
      case "agent_settled": {
        const finalText = this.agent.getLastAssistantText();
        this.renderer.onSettled(finalText);
        this.busy = false;
        // A voice-only turn's text is spoken, never rendered to Telegram — don't
        // record it as the last-rendered answer, or reconcile would suppress the
        // legitimate text repost if we crash before the voice note is sent.
        this.onFinalized?.(this.voiceMode ? undefined : finalText);
        // Voice mode: speak the answer as a voice note — unless the agent already
        // sent one itself via tg_send_voice, which would double up.
        if (this.voiceMode && this.voice && !this.spokeThisTurn && finalText && finalText.trim() !== "") void this.speak(finalText);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Route an inbound prompt (§12):
   *  - idle → prompt (react 👀)
   *  - running → steer into the current turn (react ⚡)
   *
   * `speak` sets the reply modality for the turn: true → voice-only reply
   * (matches a voice message in), false → normal text reply.
   */
  async handlePrompt(text: string, opts?: { images?: ImageContent[]; messageId?: number; speak?: boolean }) {
    const images = opts?.images;
    if (opts?.messageId !== undefined) {
      if (this.turn) this.turn.messageId = opts.messageId; // for tg_react
      this.messageLog?.add(opts.messageId, "user", text); // for the context-injected id table
    }

    if (this.busy) {
      this.log.info("steering into running turn");
      await this.agent.steer(text, images);
      return;
    }
    this.busy = true;
    this.voiceMode = opts?.speak ?? false; // reply modality matches the input
    this.renderer.setVoiceMode(this.voiceMode);
    // Do NOT await: the turn streams via the event subscription; the poll loop
    // must stay free to deliver steering messages.
    void this.agent
      .prompt(text, images ? { images } : undefined)
      .catch((e) => {
        this.log.error("prompt failed", errFields(e));
        this.renderer.onError(e);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  /** Synthesize `text` and send it as a voice note. Falls back to text on failure. */
  async speak(text: string) {
    if (!this.voice) return;
    try {
      const { path, durationSec } = await this.voice.synthesize(clipForSpeech(text), join(this.workspaceDir, "tts"));
      await this.writer.sendVoice(new InputFile(path), { duration: durationSec });
    } catch (e) {
      // Voice can be blocked by the user's privacy settings (and unblocked again
      // mid-session), so don't track state — just fall back to text this turn.
      this.log.warn("voice reply failed; sending text instead", errFields(e));
      await this.writer.persist(text).catch((e2) => this.log.error("text fallback failed", errFields(e2)));
    }
  }

  /** Send a plain notice through the Writer (keeps the single-choke-point rule). */
  notify(text: string): Promise<unknown> {
    return this.writer.persist(text);
  }

  async abort() {
    await this.agent.abort();
  }

  dispose() {
    this.unsubscribe();
    this.renderer.stop(); // clear heartbeat/chat-action/flush timers if a turn was live
    this.agent.dispose();
  }
}

/** Flatten markdown/code to something worth speaking, capped for length. */
function clipForSpeech(text: string): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^▸.*$/gm, "") // drop the tool-summary line
    .replace(/[*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 1500) s = `${s.slice(0, 1500)}…`;
  return s;
}
