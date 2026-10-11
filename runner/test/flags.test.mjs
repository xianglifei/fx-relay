import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../lib/flags.mjs";

test("space-separated values", () => {
  const { flags } = parseFlags(["work", "--agent", "claude", "--once"]);
  assert.deepEqual(flags, { agent: "claude", once: true });
});

test("--key=value form", () => {
  const { flags } = parseFlags(["seed", "--dir=../baseline-template", "--repo", "demo-app"]);
  assert.deepEqual(flags, { dir: "../baseline-template", repo: "demo-app" });
});

test("values that look like flags are not consumed", () => {
  const { flags, pos } = parseFlags(["--once", "--agent"]);
  assert.deepEqual(flags, { once: true, agent: true });
  assert.deepEqual(pos, []);
});

test("positionals collected", () => {
  const { flags, pos } = parseFlags(["config", "https://x.dev", "tok123", "--verbose"]);
  assert.deepEqual(flags, { verbose: true });
  assert.deepEqual(pos, ["config", "https://x.dev", "tok123"]);
});
