import { describe, expect, test } from "bun:test";
import { renderMarkdownBlocks, renderMarkdownChunks } from "./markdown.ts";

describe("renderMarkdownBlocks", () => {
  test("renders a heading as bold and escapes raw HTML", () => {
    const [block] = renderMarkdownBlocks("# Title <script>");
    expect(block).toContain("<b>");
    expect(block).toContain("&lt;script&gt;");
  });

  test("renders a fenced code block as pre/code with escaping", () => {
    const [block] = renderMarkdownBlocks("```js\nconst x = 1 < 2;\n```");
    expect(block).toContain('<pre><code class="language-js">');
    expect(block).toContain("const x = 1 &lt; 2;");
  });

  test("renders bullet and ordered lists", () => {
    expect(renderMarkdownBlocks("- a\n- b")[0]).toBe("• a\n• b");
    expect(renderMarkdownBlocks("3. a\n4. b")[0]).toBe("3. a\n4. b");
  });

  test("escapes ampersands in link text and href", () => {
    const [block] = renderMarkdownBlocks("[a & b](https://x.test/?q=1&y=2)");
    expect(block).toContain('<a href="https://x.test/?q=1&amp;y=2">a &amp; b</a>');
  });

  test("renders a table as a monospace block", () => {
    const [block] = renderMarkdownBlocks("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(block!.startsWith("<pre>")).toBe(true);
    expect(block).toContain("a");
    expect(block).toContain("1");
  });
});

describe("renderMarkdownChunks", () => {
  test("keeps every chunk within the Telegram message limit", () => {
    const big = "```\n" + "x".repeat(9000) + "\n```";
    const chunks = renderMarkdownChunks(big);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });

  test("returns a single chunk for short input", () => {
    expect(renderMarkdownChunks("hello **world**")).toEqual(["hello <b>world</b>"]);
  });
});
