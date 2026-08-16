import { expect, test } from "bun:test";
import { Renderer } from "./renderer.ts";
import type { Route } from "./route.ts";
import type { Writer } from "./writer.ts";

const route: Route = { chatId: 1, threadId: 0 };

/** A Writer stub that records provisional messages, edits, and final output. */
function fakeWriter(opts?: { rejectHtml?: boolean }) {
  const sent: { text: string; html: boolean }[] = [];
  const edits: { id: number; text: string; html: boolean }[] = [];
  const deleted: number[] = [];
  const writer = {
    async persist(text: string, extra?: { parse_mode?: string }) {
      const html = extra?.parse_mode === "HTML";
      if (html && opts?.rejectHtml) throw new Error("Bad Request: can't parse entities");
      sent.push({ text, html });
      return { message_id: sent.length };
    },
    async editText(id: number, text: string, extra?: { parse_mode?: string }) {
      const html = extra?.parse_mode === "HTML";
      if (html && opts?.rejectHtml) throw new Error("Bad Request: can't parse entities");
      edits.push({ id, text, html });
      return { message_id: id };
    },
    async deleteMessage(id: number) {
      deleted.push(id);
      return true;
    },
    async sendChatAction() {},
  } as unknown as Writer;
  return { sent, edits, deleted, writer };
}

/** Let the Renderer's fire-and-forget persist chains settle. */
const flush = () => new Promise((r) => setTimeout(r, 20));

test("finalizes as Telegram HTML", async () => {
  const { sent, edits, writer } = fakeWriter();
  const r = new Renderer(writer, route);
  r.onAgentStart();
  r.onText("hello **world**");
  await flush();
  r.onSettled("hello **world**");
  await flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.html).toBe(false); // provisional preview
  expect(edits).toHaveLength(1);
  expect(edits[0]!.html).toBe(true);
  expect(edits[0]!.text).toContain("<b>world</b>");
});

test("falls back to plain text when Telegram rejects the HTML", async () => {
  const { sent, writer } = fakeWriter({ rejectHtml: true });
  const r = new Renderer(writer, route);
  r.onAgentStart();
  r.onSettled("some `code` here");
  await flush();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.html).toBe(false);
  expect(sent[0]!.text).not.toContain("<code>");
  expect(sent[0]!.text).toContain("code");
});

test("strips zero-width characters from the finalized text", async () => {
  const { sent, writer } = fakeWriter();
  const r = new Renderer(writer, route);
  r.onAgentStart();
  r.onSettled(`a${String.fromCharCode(0x200b)}b`);
  await flush();
  expect(sent[0]!.text).toContain("ab");
  expect(sent[0]!.text).not.toContain(String.fromCharCode(0x200b));
});

test("does not persist an empty answer", async () => {
  const { sent, writer } = fakeWriter();
  const r = new Renderer(writer, route);
  r.onAgentStart();
  r.onSettled("");
  await flush();
  expect(sent).toHaveLength(0);
});

test("deletes a thinking-only preview instead of persisting it", async () => {
  const { sent, deleted, writer } = fakeWriter();
  const r = new Renderer(writer, route);
  r.onAgentStart();
  r.onThinking("thinking");
  await flush();
  r.onSettled("");
  await flush();
  expect(sent).toHaveLength(1);
  expect(deleted).toEqual([1]);
});
