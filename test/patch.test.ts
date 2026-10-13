import { describe, expect, it } from "vitest";
import { reversePatch } from "../src/diff/patch";

// The patch OpenCode 2.0.26 returned for the fix-and-run fixture.
const recorded =
  "diff --git a/calc.py b/calc.py\nindex 12ee743..4693ad3 100644\n--- a/calc.py\n+++ b/calc.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n";

describe("reversePatch", () => {
  it("restores the recorded edit", () => {
    expect(reversePatch("def add(a, b):\n    return a + b\n", recorded)).toBe("def add(a, b):\n    return a - b\n");
  });

  it("handles several hunks, additions and deletions", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "B", "c", "d", "e", "f", "g", "i", "j", "k"].join("\n");
    const patch = [
      "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c",
      "@@ -7,4 +7,4 @@", " g", "-h", " i", " j", "+k",
    ].join("\n");
    expect(reversePatch(after, patch)).toBe(before);
  });

  it("reverses a new file to empty", () => {
    expect(reversePatch("x\ny", "@@ -0,0 +1,2 @@\n+x\n+y")).toBe("");
  });

  it("refuses when the file changed since the patch", () => {
    expect(reversePatch("def add(a, b):\n    return a * b\n", recorded)).toBeUndefined();
  });

  it("keeps CRLF line endings", () => {
    expect(reversePatch("one\r\ntwo\r\n", "@@ -1,2 +1,2 @@\n one\n-TWO\n+two")).toBe("one\r\nTWO\r\n");
  });
});
