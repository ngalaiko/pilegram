/**
 * Render pi's CommonMark output to Telegram HTML (§3, regular tier).
 *
 * Telegram HTML is a small subset — no headings, lists, tables, or hr. We map:
 *   heading → bold, list → "•"/"n." lines, table → monospace <pre>, code → <pre>,
 *   hr → a rule line. Text is HTML-escaped; unsupported inline HTML is escaped too.
 *
 * Returns block-level HTML strings so chunking (packChunks) never splits inside a
 * tag. Used only on the finalized message — drafts stay plain text, since partial
 * markdown mid-stream would produce invalid HTML.
 */

import { marked, type Token, type Tokens } from "marked";

const MSG_MAX = 4096;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

function renderInline(tokens: Token[] | undefined, raw: string): string {
  if (!tokens) return esc(raw);
  let out = "";
  for (const t of tokens as Tokens.Generic[]) {
    switch (t.type) {
      case "text":
        out += t.tokens ? renderInline(t.tokens, t.raw) : esc((t as Tokens.Text).text ?? t.raw);
        break;
      case "escape":
        out += esc((t as Tokens.Escape).text);
        break;
      case "strong":
        out += `<b>${renderInline(t.tokens, t.raw)}</b>`;
        break;
      case "em":
        out += `<i>${renderInline(t.tokens, t.raw)}</i>`;
        break;
      case "del":
        out += `<s>${renderInline(t.tokens, t.raw)}</s>`;
        break;
      case "codespan":
        out += `<code>${esc((t as Tokens.Codespan).text)}</code>`;
        break;
      case "br":
        out += "\n";
        break;
      case "link": {
        const l = t as Tokens.Link;
        out += `<a href="${escAttr(l.href)}">${renderInline(l.tokens, l.raw)}</a>`;
        break;
      }
      case "image":
        out += esc(`[image: ${(t as Tokens.Image).text || (t as Tokens.Image).href}]`);
        break;
      default:
        out += esc((t as Tokens.Generic).raw ?? "");
    }
  }
  return out;
}

function renderTable(t: Tokens.Table): string {
  const cell = (c: Tokens.TableCell) => c.text.replace(/\s+/g, " ").trim();
  const rows = [t.header.map(cell), ...t.rows.map((r) => r.map(cell))];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  const lines = [fmt(rows[0]!), sep, ...rows.slice(1).map(fmt)];
  return `<pre>${esc(lines.join("\n"))}</pre>`;
}

function renderList(t: Tokens.List): string {
  const lines: string[] = [];
  t.items.forEach((item, i) => {
    const marker = t.ordered ? `${(Number(t.start) || 1) + i}.` : "•";
    const body = renderInline(item.tokens, item.text).replace(/\n+/g, " ").trim();
    lines.push(`${marker} ${body}`);
  });
  return lines.join("\n");
}

function renderBlock(t: Tokens.Generic): string {
  switch (t.type) {
    case "space":
      return "";
    case "heading":
      return `<b>${renderInline(t.tokens, t.raw)}</b>`;
    case "paragraph":
      return renderInline(t.tokens, t.raw);
    case "text":
      return t.tokens ? renderInline(t.tokens, t.raw) : esc((t as Tokens.Text).text ?? t.raw);
    case "code": {
      const c = t as Tokens.Code;
      const cls = c.lang ? ` class="language-${escAttr(c.lang.split(/\s+/)[0] ?? "")}"` : "";
      return `<pre><code${cls}>${esc(c.text)}</code></pre>`;
    }
    case "blockquote": {
      const inner = (t.tokens as Tokens.Generic[]).map(renderBlock).filter(Boolean).join("\n");
      return `<blockquote>${inner}</blockquote>`;
    }
    case "list":
      return renderList(t as Tokens.List);
    case "table":
      return renderTable(t as Tokens.Table);
    case "hr":
      return "──────────";
    case "html":
      return esc((t as Tokens.HTML).text).trim();
    default:
      return esc((t as Tokens.Generic).raw ?? "").trim();
  }
}

/** Parse markdown → Telegram-HTML block strings. */
export function renderMarkdownBlocks(md: string): string[] {
  const tokens = marked.lexer(md);
  return tokens.map((t) => renderBlock(t as Tokens.Generic).trim()).filter((s) => s.length > 0);
}

/** Pack block strings into <= max-char chunks on block boundaries (never splits a tag). */
export function packChunks(blocks: string[], max = MSG_MAX): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const b of blocks) {
    const piece = b.length > max ? hardSplit(b, max) : [b];
    for (const p of piece) {
      if (cur === "") cur = p;
      else if (cur.length + 2 + p.length <= max) cur += `\n\n${p}`;
      else {
        chunks.push(cur);
        cur = p;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Last-resort split of an oversized single block (e.g. a huge code block). */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

/** Full pipeline: markdown → ready-to-send Telegram-HTML chunks. */
export function renderMarkdownChunks(md: string): string[] {
  return packChunks(renderMarkdownBlocks(md));
}
