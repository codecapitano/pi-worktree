import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finishWorktree, sessionFileOutsideWorktree } from "../lib/finish-worktree.ts";

function harness(overrides = {}) {
  const calls = [];
  const notifications = [];
  const freshUi = { notify: (message, level) => notifications.push({ message, level }) };
  const ctx = {
    cwd: "/repo-feature",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionFile: () => "/sessions/source.jsonl",
      getSessionDir: () => "/sessions",
      getLeafId: () => "last",
      getEntries: () => [{ id: "last" }],
    },
    ui: {
      ...freshUi,
      confirm: async () => true,
    },
    switchSession: async (_path, options) => {
      calls.push("switch");
      await options.withSession({ ui: freshUi });
      return { cancelled: false };
    },
    ...overrides.ctx,
  };
  const dependencies = {
    exists: async () => true,
    usesDefaultSessionDir: () => true,
    revalidate: async () => true,
    forkSession: async () => ({ path: "/sessions/main.jsonl" }),
    removeSession: async () => calls.push("unlink-fork"),
    isSessionSafe: async () => true,
    acceptFork: async () => true,
    isClean: async () => true,
    isCurrentWorktree: async () => true,
    removeWorktree: async () => { calls.push("remove"); return { code: 0, stderr: "" }; },
    ...overrides.dependencies,
  };
  return { ctx, dependencies, calls, notifications };
}

test("session safety rejects in-tree files, directories and symlinks into the tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-wt-session-safety-"));
  const source = join(root, "secondary");
  const outside = join(root, "sessions");
  try {
    await mkdir(source);
    await mkdir(outside);
    const nested = join(source, ".sessions");
    await mkdir(nested);
    const file = join(nested, "history.jsonl");
    await writeFile(file, "session\n");
    const link = join(outside, "linked-history");
    await symlink(file, link);
    assert.equal(await sessionFileOutsideWorktree(source, nested), false);
    assert.equal(await sessionFileOutsideWorktree(source, file), false);
    assert.equal(await sessionFileOutsideWorktree(source, link), false);
    assert.equal(await sessionFileOutsideWorktree(source, outside), true);
    assert.equal(await sessionFileOutsideWorktree(source, join(root, "missing")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finishes a clean worktree only after switching to main", async () => {
  const state = harness();
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "removed");
  assert.deepEqual(state.calls, ["switch", "remove"]);
  assert.match(state.notifications.at(-1).message, /Removed worktree/);
});

test("refuses when session history lives inside the worktree", async () => {
  const state = harness({ dependencies: { isSessionSafe: async () => false } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "refused");
  assert.deepEqual(state.calls, []);
  assert.match(state.notifications.at(-1).message, /Session files/);
});

test("refuses and discards the fork if it lives inside the worktree", async () => {
  const state = harness({ dependencies: { acceptFork: async () => false } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "refused");
  assert.deepEqual(state.calls, ["unlink-fork"]);
});

test("refuses to finish the main worktree", async () => {
  const state = harness({ ctx: { cwd: "/repo" } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "refused");
  assert.deepEqual(state.calls, []);
});

test("leaves a dirty worktree without switching", async () => {
  const state = harness({ dependencies: { isClean: async () => false } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "refused");
  assert.deepEqual(state.calls, []);
  assert.match(state.notifications.at(-1).message, /uncommitted, untracked, or ignored/);
});

test("does not switch when confirmation is declined", async () => {
  const state = harness({ ctx: { ui: { notify() {}, confirm: async () => false } } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "cancelled");
  assert.deepEqual(state.calls, []);
});

test("does not remove when Pi cancels the switch and discards the fork", async () => {
  const state = harness({ ctx: { switchSession: async () => ({ cancelled: true }) } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "cancelled");
  assert.deepEqual(state.calls, ["unlink-fork"]);
});

test("keeps the worktree if it becomes dirty after the switch", async () => {
  let checks = 0;
  const state = harness({ dependencies: { isClean: async () => ++checks === 1 } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "retained");
  assert.deepEqual(state.calls, ["switch"]);
  assert.match(state.notifications.at(-1).message, /left intact/);
});

test("keeps the worktree if non-force removal fails", async () => {
  const state = harness({ dependencies: { removeWorktree: async () => ({ code: 1, stderr: "contains untracked files" }) } });
  assert.equal(await finishWorktree(state.ctx, "/repo", state.dependencies), "retained");
  assert.deepEqual(state.calls, ["switch"]);
  assert.match(state.notifications.at(-1).message, /contains untracked files/);
});
