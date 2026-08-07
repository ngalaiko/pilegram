/**
 * Live context injection (plan §15): re-assert channel context every turn via a
 * before_agent_start hook, framed as ordinary documentation (not <system>
 * directives, which can trip prompt-injection defenses and get surfaced to the
 * user). Includes a rolling table of recent message ids so the model can
 * reference ANY message (tg_react/tg_edit/tg_delete/tg_pin) at any time, not
 * just the current one.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface LogEntry {
  id: number;
  role: "user" | "bot";
  text: string;
}

export class MessageLog {
  private readonly entries: LogEntry[] = [];
  private readonly max = 20;

  add(id: number, role: "user" | "bot", text: string) {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 80) || "(no text)";
    this.entries.push({ id, role, text: snippet });
    while (this.entries.length > this.max) this.entries.shift();
  }

  render(): string {
    if (this.entries.length === 0) return "";
    const lines = this.entries.map((e) => `  #${e.id} ${e.role === "user" ? "user" : "you"}: ${e.text}`);
    return (
      "Recent messages in this chat (message_id → sender). You may reference ANY of these by " +
      "message_id with tg_react / tg_edit / tg_delete / tg_pin:\n" +
      lines.join("\n")
    );
  }
}

export interface ContextInfo {
  log: MessageLog;
  timeZone: string;
  isTopic: boolean;
  topicName: () => string | undefined;
  topicIcon: () => string | undefined;
}

function renderContext(info: ContextInfo): string {
  const now = new Date().toLocaleString("en-GB", { timeZone: info.timeZone, dateStyle: "full", timeStyle: "short" });
  const lines = [
    "## Telegram channel context",
    "You are talking to the user over Telegram; they are usually on mobile, so keep replies chat-friendly and concise.",
    "For short acknowledgements, prefer reacting (tg_react) over a text reply.",
    `Local time (${info.timeZone}): ${now}.`,
  ];
  if (info.isTopic) {
    const name = info.topicName() ?? "(unset)";
    const icon = info.topicIcon();
    lines.push(
      `This conversation is a Telegram topic — Title: "${name}"${icon ? ` · Icon: ${icon}` : ""}.`,
      "Keep the topic's title and icon relevant to what's being discussed: call tg_set_topic to update them whenever the focus shifts (and to set them the first time).",
    );
  }
  const log = info.log.render();
  if (log) lines.push("", log);
  return lines.join("\n");
}

/** Build the inline extension that injects the context each turn. */
export function contextExtension(info: ContextInfo) {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${renderContext(info)}` }));
  };
}
