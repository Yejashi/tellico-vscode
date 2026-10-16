import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachable, buildPromptFiles, findMentions, MAX_ATTACHMENT } from "../src/prompt";

describe("@-mentions", () => {
  it("finds paths, line ranges and their spans", () => {
    const text = "fix @src/a.ts#L3-9 and @b.py, then see (@docs/x.md).";
    const ms = findMentions(text);
    expect(ms.map((m) => [m.path, m.range, text.slice(m.start, m.end)])).toEqual([
      ["src/a.ts", { start: 3, end: 9 }, "@src/a.ts#L3-9"],
      ["b.py", undefined, "@b.py"],
      ["docs/x.md", undefined, "@docs/x.md"],
    ]);
  });

  it("ignores e-mail addresses and a lone @", () => {
    expect(findMentions("mail me@host.org or @ alone")).toEqual([]);
  });

  it("keeps escaped spaces inside a path", () => {
    const ms = findMentions("see @my\\ dir/a\\ b.ts#L2 now");
    expect(ms.map((m) => [m.path, m.range])).toEqual([["my dir/a b.ts", { start: 2, end: 2 }]]);
  });

  it("accepts a single line and an L on the end", () => {
    expect(findMentions("@a.ts#L7")[0].range).toEqual({ start: 7, end: 7 });
    expect(findMentions("@a.ts#L9-L3")[0].range).toEqual({ start: 3, end: 9 });
  });
});

describe("prompt files", () => {
  const root = "/work/proj";
  const exists = (p: string) => ["/work/proj/src/a.ts", "/work/proj/calc.py", "/elsewhere/n.txt"].includes(p);

  it("attaches mentioned files that exist, with their mention", () => {
    const files = buildPromptFiles({ text: "look at @src/a.ts#L2-4 and @nope.ts", root, exists });
    expect(files).toEqual([{ uri: "file:///work/proj/src/a.ts?start=2&end=4", name: "src/a.ts#L2-4", mention: { start: 8, end: 22, text: "@src/a.ts#L2-4" } }]);
  });

  it("adds the active editor, attachments and images once each", () => {
    const files = buildPromptFiles({
      text: "@calc.py",
      root,
      exists,
      attachments: [
        { kind: "file", path: "/elsewhere/n.txt" },
        { kind: "file", path: "calc.py" },
        { kind: "image", name: "shot.png", dataUrl: "data:image/png;base64,AAAA" },
        { kind: "image", name: "evil", dataUrl: "javascript:alert(1)" },
      ],
      active: { path: "/work/proj/src/a.ts", range: { start: 5, end: 5 } },
    });
    expect(files.map((f) => f.name)).toEqual(["calc.py", "/elsewhere/n.txt", "shot.png", "src/a.ts#L5"]);
  });
});

describe("attachable", () => {
  it("takes directories and readable files under the cap, nothing else", () => {
    const d = mkdtempSync(join(tmpdir(), "tellico-attach-"));
    writeFileSync(join(d, "ok.txt"), "x");
    writeFileSync(join(d, "big.log"), "");
    truncateSync(join(d, "big.log"), MAX_ATTACHMENT + 1);
    writeFileSync(join(d, "locked"), "x");
    chmodSync(join(d, "locked"), 0o000);
    mkdirSync(join(d, "sub"));
    expect(attachable(join(d, "ok.txt"))).toBe(true);
    expect(attachable(join(d, "sub"))).toBe(true);
    expect(attachable(join(d, "big.log"))).toBe(false);
    expect(attachable(join(d, "missing"))).toBe(false);
    if (process.getuid?.() !== 0) expect(attachable(join(d, "locked"))).toBe(false);
  });
});
