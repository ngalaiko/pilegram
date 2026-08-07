/**
 * Structured JSON-lines logger.
 *
 * Plan §15 (security): "Log every update and every API response including
 * ok/error_code — the only way to debug flood behavior." Everything goes to
 * stdout as one JSON object per line so it's greppable and s6/journald-friendly.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

/** Set the minimum level to emit (from the --log-level flag). */
export function setLogLevel(level: Level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

export type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields) {
  if (LEVELS[level] < threshold) return;
  const record: Fields = { ts: new Date().toISOString(), level, msg, ...fields };
  const line = JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  // error/warn to stderr, the rest to stdout.
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
  /** Build a child logger that merges `base` fields into every record. */
  child(base: Fields) {
    return {
      debug: (msg: string, fields?: Fields) => emit("debug", msg, { ...base, ...fields }),
      info: (msg: string, fields?: Fields) => emit("info", msg, { ...base, ...fields }),
      warn: (msg: string, fields?: Fields) => emit("warn", msg, { ...base, ...fields }),
      error: (msg: string, fields?: Fields) => emit("error", msg, { ...base, ...fields }),
    };
  },
};

/** Normalize an unknown thrown value into loggable fields. */
export function errFields(e: unknown): Fields {
  if (e instanceof Error) return { err: e.message, stack: e.stack, name: e.name };
  return { err: String(e) };
}
