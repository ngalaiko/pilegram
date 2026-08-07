/**
 * SQLite persistence (bun:sqlite).
 *
 * Plan §0 lists routes / cursors / file_ids / approvals tables; those arrive
 * with their milestones. M0 only needs the durable long-poll offset so that a
 * restart mid-conversation replays nothing.
 *
 * Schema evolves via a simple linear migration list keyed on `PRAGMA user_version`.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.ts";

const MIGRATIONS: string[] = [
  // v1 — M0: key/value meta (holds the poll offset).
  `CREATE TABLE meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // v2 — M2: one row per route (chat + topic). thread_id 0 == General/no-thread.
  `CREATE TABLE routes (
     chat_id           INTEGER NOT NULL,
     thread_id         INTEGER NOT NULL,
     session_file      TEXT,
     name              TEXT,
     status            TEXT NOT NULL DEFAULT 'active',
     last_rendered_sig TEXT,
     created_at        INTEGER NOT NULL,
     updated_at        INTEGER NOT NULL,
     PRIMARY KEY (chat_id, thread_id)
   );`,
  // v3 — M4: content-hash → Telegram file_id cache, to skip re-uploads.
  `CREATE TABLE media (
     sha256         TEXT PRIMARY KEY,
     file_id        TEXT NOT NULL,
     file_unique_id TEXT,
     mime_type      TEXT,
     kind           TEXT,
     updated_at     INTEGER NOT NULL
   );`,
  // v4 — auto-titling: whether a topic has already been auto-named (once only).
  `ALTER TABLE routes ADD COLUMN titled INTEGER NOT NULL DEFAULT 0;`,
  // v5 — the topic's current icon emoji (for context display; set via editForumTopic).
  `ALTER TABLE routes ADD COLUMN icon TEXT;`,
];

export interface RouteRow {
  chatId: number;
  threadId: number;
  sessionFile: string | null;
  name: string | null;
  status: "active" | "ended";
  lastRenderedSig: string | null;
  titled: boolean;
  icon: string | null;
}

interface RouteDbRow {
  chat_id: number;
  thread_id: number;
  session_file: string | null;
  name: string | null;
  status: string;
  last_rendered_sig: string | null;
  titled: number;
  icon: string | null;
}

function toRouteRow(r: RouteDbRow): RouteRow {
  return {
    chatId: r.chat_id,
    threadId: r.thread_id,
    sessionFile: r.session_file,
    name: r.name,
    status: r.status === "ended" ? "ended" : "active",
    lastRenderedSig: r.last_rendered_sig,
    titled: r.titled === 1,
    icon: r.icon,
  };
}

export class Db {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const current = (this.db.query("PRAGMA user_version;").get() as { user_version: number }).user_version;
    if (current >= MIGRATIONS.length) return;
    const tx = this.db.transaction(() => {
      for (let v = current; v < MIGRATIONS.length; v++) {
        this.db.exec(MIGRATIONS[v]!);
      }
      // PRAGMA can't be parameterized; MIGRATIONS.length is our own trusted int.
      this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length};`);
    });
    tx();
    log.info("db migrated", { from: current, to: MIGRATIONS.length });
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value;
  }

  private setMeta(key: string, value: string) {
    this.db
      .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** The getUpdates offset to resume from (undefined before the first update). */
  getPollOffset(): number | undefined {
    const v = this.getMeta("poll_offset");
    return v === undefined ? undefined : Number(v);
  }

  setPollOffset(offset: number) {
    this.setMeta("poll_offset", String(offset));
  }

  // ---- routes (M2) ----

  getRoute(chatId: number, threadId: number): RouteRow | undefined {
    const row = this.db.query("SELECT * FROM routes WHERE chat_id = ? AND thread_id = ?").get(chatId, threadId) as
      | RouteDbRow
      | null;
    return row ? toRouteRow(row) : undefined;
  }

  listActiveRoutes(): RouteRow[] {
    const rows = this.db.query("SELECT * FROM routes WHERE status = 'active'").all() as RouteDbRow[];
    return rows.map(toRouteRow);
  }

  /** Create the route row if absent (used on first contact / topic creation). */
  ensureRoute(chatId: number, threadId: number, name: string | null) {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO routes (chat_id, thread_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)
         ON CONFLICT(chat_id, thread_id) DO NOTHING`,
      )
      .run(chatId, threadId, name, now, now);
  }

  private updateRoute(chatId: number, threadId: number, column: string, value: string | null) {
    // column is an internal literal, never user input.
    this.db
      .query(`UPDATE routes SET ${column} = ?, updated_at = ? WHERE chat_id = ? AND thread_id = ?`)
      .run(value, Date.now(), chatId, threadId);
  }

  setRouteSessionFile(chatId: number, threadId: number, file: string | null) {
    this.updateRoute(chatId, threadId, "session_file", file);
  }
  setRouteName(chatId: number, threadId: number, name: string) {
    this.updateRoute(chatId, threadId, "name", name);
  }
  setRouteIcon(chatId: number, threadId: number, icon: string) {
    this.updateRoute(chatId, threadId, "icon", icon);
  }
  setRouteStatus(chatId: number, threadId: number, status: "active" | "ended") {
    this.updateRoute(chatId, threadId, "status", status);
  }
  setRouteLastRenderedSig(chatId: number, threadId: number, sig: string) {
    this.updateRoute(chatId, threadId, "last_rendered_sig", sig);
  }

  markRouteTitled(chatId: number, threadId: number) {
    this.db.query("UPDATE routes SET titled = 1, updated_at = ? WHERE chat_id = ? AND thread_id = ?").run(Date.now(), chatId, threadId);
  }

  // ---- media file_id cache (M4) ----

  getMediaFileId(sha256: string): string | undefined {
    const row = this.db.query("SELECT file_id FROM media WHERE sha256 = ?").get(sha256) as { file_id: string } | null;
    return row?.file_id;
  }

  putMedia(sha256: string, fileId: string, fileUniqueId: string | undefined, mimeType: string | undefined, kind: string) {
    this.db
      .query(
        `INSERT INTO media (sha256, file_id, file_unique_id, mime_type, kind, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO UPDATE SET file_id = excluded.file_id, file_unique_id = excluded.file_unique_id, updated_at = excluded.updated_at`,
      )
      .run(sha256, fileId, fileUniqueId ?? null, mimeType ?? null, kind, Date.now());
  }

  close() {
    this.db.close();
  }
}
