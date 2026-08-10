/**
 * Media helpers: download inbound Telegram files into the working directory,
 * turn image bytes into pi ImageContent, and hash/mime utilities for the
 * outbound file_id cache.
 *
 * Bot API getFile caps at 20MB (plan §8) — larger files throw a friendly error.
 */

import type { Api } from "grammy";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/** Structurally compatible with pi-ai's ImageContent (see PromptOptions.images). */
export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface Downloaded {
  path: string;
  bytes: Uint8Array;
  mime: string;
  name: string;
  sizeBytes: number;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

export function guessMime(name: string, fallback = "application/octet-stream"): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? fallback;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toImageContent(bytes: Uint8Array, mime: string): ImageContent {
  return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime };
}

function safeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
}

/**
 * Download a Telegram file by file_id into `destDir`. Returns the saved path
 * and the bytes. Throws with a clear message if the file exceeds the 20MB
 * Bot API getFile ceiling.
 */
export async function downloadTelegramFile(
  api: Api,
  botToken: string,
  fileId: string,
  destDir: string,
  opts?: { fallbackName?: string; mime?: string },
): Promise<Downloaded> {
  const file = await api.getFile(fileId); // throws 400 "file is too big" past 20MB
  if (!file.file_path) throw new Error("Telegram returned no file_path (file too large for the Bot API?)");

  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const name = safeName(opts?.fallbackName ?? basename(file.file_path));
  const mime = opts?.mime ?? guessMime(name);
  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, name);
  writeFileSync(path, bytes);

  return { path, bytes, mime, name, sizeBytes: bytes.byteLength };
}
