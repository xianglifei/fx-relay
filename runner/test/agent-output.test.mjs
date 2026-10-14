import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarizeAgentOutput, conventionFilesIn, CONVENTION_FILES } from "../lib/agent-output.mjs";

test("summarizeAgentOutput: keeps the tail (adapters print summary last)", () => {
  const out = "progress line 1\nprogress line 2\n**Done**: fixed the bug, added 8 lines";
  assert.equal(summarizeAgentOutput(out), out);
  const long = "x".repeat(2000) + "\nSUMMARY_AT_END";
  const s = summarizeAgentOutput(long, 100);
  assert.equal(s.length, 101); // ellipsis + 100 chars
  assert.match(s, /SUMMARY_AT_END$/);
});

test("summarizeAgentOutput: empty/null → null", () => {
  assert.equal(summarizeAgentOutput(""), null);
  assert.equal(summarizeAgentOutput(null), null);
  assert.equal(summarizeAgentOutput("   \n  "), null);
});

test("conventionFilesIn: detects existing convention files, priority order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "relay-conv-"));
  try {
    assert.deepEqual(conventionFilesIn(dir), []);
    await writeFile(path.join(dir, "CLAUDE.md"), "# conv\n");
    assert.deepEqual(conventionFilesIn(dir), ["CLAUDE.md"]);
    await writeFile(path.join(dir, "AGENTS.md"), "# conv\n");
    assert.deepEqual(conventionFilesIn(dir), ["AGENTS.md", "CLAUDE.md"]); // AGENTS.md first
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CONVENTION_FILES lists known files", () => {
  assert.ok(CONVENTION_FILES.includes("AGENTS.md"));
  assert.ok(CONVENTION_FILES.includes(".cursorrules"));
});
