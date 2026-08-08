/**
 * Configuration. The only secret — the bot token — comes from the environment
 * (never argv, which is visible in `ps`). Everything else is a CLI flag.
 *
 * Two separate locations:
 *   - state dir  (--state-dir):  SQLite db (routes, media cache, scheduled tasks).
 *                                Small, worth backing up. Defaults under XDG config.
 *   - models dir (--models-dir): downloaded speech-model weights (~2GB). Large,
 *                                re-downloadable cache. Defaults under XDG cache.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  botToken: string;
  /** Hard allowlist of Telegram user ids (§1). Empty is a config error. */
  allowedUserIds: Set<number>;
  /** State: the SQLite db. */
  stateDir: string;
  dbPath: string;
  /** Model-weights cache (whisper + Supertonic). Separate from state. */
  modelsDir: string;
  pollTimeoutSec: number;
  whisperModel: string;
  supertonicVoice: string;
  timeZone: string;
  logLevel: LogLevel;
}

const USAGE = `pilegram — a pi coding agent over Telegram

Secret (environment only):
  TELEGRAM_BOT_TOKEN            bot token from @BotFather   [required]

Options:
  --allow <ids>                comma-separated allowed Telegram user ids   [required]
  --state-dir <path>           SQLite db location             (default: $XDG_CONFIG_HOME/pilegram)
  --models-dir <path>          speech-model cache             (default: $XDG_CACHE_HOME/pilegram)
  --db-path <path>             override the SQLite path       (default: <state-dir>/pilegram.db)
  --whisper-model <name>       whisper.cpp ggml model         (default: large-v3-turbo)
  --voice <id>                 Supertonic voice M1-M5/F1-F5   (default: M1)
  --tz <zone>                  IANA time zone shown to agent  (default: Europe/Stockholm)
  --poll-timeout <sec>         long-poll timeout              (default: 30)
  --log-level <level>          debug|info|warn|error          (default: info)
  -h, --help                   show this help
`;

function parseUserIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid user id in --allow: ${JSON.stringify(s)}`);
      return n;
    });
  if (ids.length === 0) throw new Error("--allow is required (comma-separated Telegram user ids)");
  return new Set(ids);
}

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid ${flag}: ${JSON.stringify(raw)} (expected a positive integer)`);
  return n;
}

/** XDG base (or its ~ fallback) + the pilegram subdir. */
function xdgDir(envVar: string, homeFallback: string): string {
  const base = process.env[envVar]?.trim();
  return join(base && base !== "" ? base : join(homedir(), homeFallback), "pilegram");
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        help: { type: "boolean", short: "h" },
        allow: { type: "string" },
        "state-dir": { type: "string" },
        "models-dir": { type: "string" },
        "db-path": { type: "string" },
        "whisper-model": { type: "string" },
        voice: { type: "string" },
        tz: { type: "string" },
        "poll-timeout": { type: "string" },
        "log-level": { type: "string" },
      },
    }));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    process.stderr.write(`Missing TELEGRAM_BOT_TOKEN in the environment (the one secret; keep it out of flags).\n\n${USAGE}`);
    process.exit(2);
  }

  const str = (k: string): string | undefined => (typeof values[k] === "string" ? (values[k] as string) : undefined);

  let allowedUserIds: Set<number>;
  try {
    allowedUserIds = parseUserIds(str("allow") ?? "");
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  let pollTimeoutSec: number;
  try {
    pollTimeoutSec = parsePositiveInt(str("poll-timeout"), 30, "--poll-timeout");
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  const stateDir = resolve(str("state-dir") ?? xdgDir("XDG_CONFIG_HOME", ".config"));
  const modelsDir = resolve(str("models-dir") ?? xdgDir("XDG_CACHE_HOME", ".cache"));
  const level = str("log-level") ?? "info";

  return {
    botToken,
    allowedUserIds,
    stateDir,
    dbPath: resolve(str("db-path") ?? join(stateDir, "pilegram.db")),
    modelsDir,
    pollTimeoutSec,
    whisperModel: str("whisper-model") ?? "large-v3-turbo",
    supertonicVoice: str("voice") ?? "M1",
    timeZone: str("tz") ?? "Europe/Stockholm",
    logLevel: (["debug", "info", "warn", "error"].includes(level) ? level : "info") as LogLevel,
  };
}
