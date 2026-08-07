/**
 * A Route identifies one conversation surface: a chat, optionally a forum topic.
 * In DM single-session mode (plan §2.4) threadId is undefined (thread 0).
 */
export interface Route {
  chatId: number;
  threadId?: number;
}

/** Stable string key for maps / workspace dir names. */
export function routeKey(route: Route): string {
  return `${route.chatId}-${route.threadId ?? 0}`;
}

/**
 * Mutable per-route pointer to the message currently being handled, shared
 * between the Session and its tools so tg_react knows which message to react to.
 */
export interface TurnRef {
  messageId?: number;
}
