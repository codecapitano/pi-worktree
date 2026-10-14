import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFreshSession } from "../lib/fresh-session.ts";

for (const entries of [[], [{ id: "setup", type: "model_change", parentId: null, modelId: "test" }]]) {
  test(`writes a valid target session with ${entries.length} setup entries`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-fresh-session-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "target.jsonl");
    const header = { type: "session", version: 3, id: "target", cwd: "/repo-feature" };
    const calls = [];
    const factory = (...args) => {
      calls.push(args);
      return { getSessionFile: () => path, getHeader: () => header };
    };
    assert.deepEqual(await createFreshSession(factory, "/repo-feature", root, entries), { path });
    assert.deepEqual(calls, [["/repo-feature", root]]);
    const text = await readFile(path, "utf8");
    assert.ok(text.endsWith("\n"));
    assert.deepEqual(text.trim().split("\n").map(JSON.parse), [header, ...entries]);
  });
}

test("never overwrites an existing session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fresh-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "existing.jsonl");
  await writeFile(path, "keep history\n");
  const factory = () => ({ getSessionFile: () => path, getHeader: () => ({ type: "session" }) });
  await assert.rejects(createFreshSession(factory, "/repo-feature", undefined, []), { code: "EEXIST" });
  assert.equal(await readFile(path, "utf8"), "keep history\n");
});

test("refuses a manager without a session path or header", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-fresh-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "missing.jsonl");
  for (const [file, header] of [[undefined, { type: "session" }], [path, null]]) {
    await assert.rejects(createFreshSession(() => ({ getSessionFile: () => file, getHeader: () => header }), "/repo-feature", root, []), /session/i);
  }
  await assert.rejects(access(path));
});
