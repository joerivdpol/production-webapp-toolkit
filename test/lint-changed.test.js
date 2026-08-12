import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseNameStatus, parseNullPaths, selectLintablePaths } from "../scripts/lint-changed.js";

describe("changed-file parsing", () => {
  it("parses added and modified files with spaces", () => {
    const input = Buffer.from("A\0src/new file.ts\0M\0src/existing.js\0");
    assert.deepEqual(parseNameStatus(input), ["src/new file.ts", "src/existing.js"]);
  });

  it("uses destinations for renamed and copied files", () => {
    const input = Buffer.from("R100\0old.ts\0new name.ts\0C075\0source.js\0copy.jsx\0");
    assert.deepEqual(parseNameStatus(input), ["new name.ts", "copy.jsx"]);
  });

  it("ignores deleted files", () => {
    assert.deepEqual(parseNameStatus(Buffer.from("D\0removed.ts\0M\0kept.tsx\0")), ["kept.tsx"]);
  });

  it("parses NUL-delimited untracked paths", () => {
    assert.deepEqual(parseNullPaths(Buffer.from("one file.ts\0two.js\0")), ["one file.ts", "two.js"]);
  });

  it("deduplicates and selects only lintable extensions", () => {
    assert.deepEqual(
      selectLintablePaths(["a.ts", "notes.md"], ["a.ts", "b.TSX", "asset.json"]),
      ["a.ts", "b.TSX"],
    );
  });
});
