import assert from "node:assert/strict";
import test from "node:test";

import { continueConversationInWorktree } from "../lib/session-switch.ts";

function harness(overrides = {}) {
  const notifications = [];
  const switches = [];
  const cleaned = [];
  const sourceFile = "/sessions/source.jsonl";
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionFile: () => sourceFile,
      getSessionDir: () => "/sessions/repo",
      getLeafId: () => "last",
      getEntries: () => [{ id: "first" }, { id: "last" }],
    },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    switchSession: async (path, options) => {
      switches.push(path);
      await options.withSession({ ui: ctx.ui });
      return { cancelled: false };
    },
    ...overrides,
  };
  const dependencies = {
    exists: async () => true,
    usesDefaultSessionDir: () => false,
    revalidate: async () => true,
    forkSession: async (_source, target, sessionDir) => ({ path: `${sessionDir ?? `/sessions/default${target}`}/fork.jsonl` }),
    removeSession: async (path) => cleaned.push(path),
    ...overrides.dependencies,
  };
  return { ctx, dependencies, notifications, switches, cleaned };
}

test("forks the current conversation into the target and switches with a fresh context", async () => {
  const state = harness();
  const result = await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies);
  assert.equal(result, "switched");
  assert.deepEqual(state.switches, ["/sessions/repo/fork.jsonl"]);
  assert.match(state.notifications.at(-1).message, /repo-feature/);
});

test("uses the target default session directory when the source uses its default", async () => {
  const calls = [];
  const state = harness({
    sessionManager: {
      getSessionFile: () => "/sessions/source.jsonl",
      getSessionDir: () => "/sessions/default/repo",
      getLeafId: () => "last",
      getEntries: () => [{ id: "last" }],
    },
    dependencies: {
      usesDefaultSessionDir: () => true,
      forkSession: async (...args) => {
        calls.push(args);
        return { path: "/sessions/target/fork.jsonl" };
      },
    },
  });
  await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies);
  assert.equal(calls[0][2], undefined);
});

test("switches a fresh session whose assigned file has not been written", async () => {
  const entries = [{ id: "setup", type: "model_change", modelId: "test" }];
  const calls = [];
  const state = harness({
    sessionManager: {
      getSessionFile: () => "/sessions/unwritten.jsonl",
      getSessionDir: () => "/sessions/repo",
      getEntries: () => entries,
      getLeafId: () => "setup",
    },
    dependencies: {
      exists: async () => false,
      createSession: async (...args) => { calls.push(args); return { path: "/sessions/new.jsonl" }; },
      forkSession: async () => { assert.fail("must not fork an unwritten file"); },
    },
  });
  assert.equal(await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), "switched");
  assert.deepEqual(calls, [["/repo-feature", "/sessions/repo", entries]]);
  assert.deepEqual(state.switches, ["/sessions/new.jsonl"]);
});

test("starts an empty session in the target default session directory", async () => {
  const calls = [];
  const state = harness({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionDir: () => "/sessions/repo",
      getEntries: () => [],
      getLeafId: () => null,
    },
    dependencies: {
      usesDefaultSessionDir: () => true,
      createSession: async (...args) => { calls.push(args); return { path: "/sessions/target/new.jsonl" }; },
    },
  });
  assert.equal(await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), "switched");
  assert.deepEqual(calls, [["/repo-feature", undefined, []]]);
});

test("cleans up a fresh target session when switching is cancelled", async () => {
  const state = harness({
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionDir: () => "/sessions/repo",
      getEntries: () => [],
      getLeafId: () => null,
    },
    switchSession: async () => ({ cancelled: true }),
    dependencies: { createSession: async () => ({ path: "/sessions/new.jsonl" }) },
  });
  assert.equal(await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), "cancelled");
  assert.deepEqual(state.cleaned, ["/sessions/new.jsonl"]);
});

test("refuses a missing file for an existing conversation", async () => {
  const state = harness({
    sessionManager: {
      getSessionFile: () => "/sessions/lost.jsonl",
      getSessionDir: () => "/sessions/repo",
      getEntries: () => [{ id: "last", type: "message" }],
      getLeafId: () => "last",
    },
    dependencies: { exists: async () => false },
  });
  assert.equal(await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), "refused");
  assert.deepEqual(state.switches, []);
  assert.match(state.notifications.at(-1).message, /avoid losing history/);
});

test("refuses unsafe switching states before creating a fork", async () => {
  for (const overrides of [
    { mode: "print" },
    { hasUI: false },
    { isIdle: () => false },
    { hasPendingMessages: () => true },
    { sessionManager: { getSessionFile: () => undefined, getSessionDir: () => "/sessions", getLeafId: () => "message", getEntries: () => [{ id: "message", type: "message" }] } },
    { sessionManager: { getSessionFile: () => "/sessions/source.jsonl", getSessionDir: () => "/sessions", getLeafId: () => "old", getEntries: () => [{ id: "old" }, { id: "new" }] } },
  ]) {
    let forked = false;
    const state = harness({ ...overrides, dependencies: { forkSession: async () => { forked = true; return { path: "x" }; } } });
    assert.equal(await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), "refused");
    assert.equal(forked, false);
  }
});

test("cleans up a fork when switching is cancelled", async () => {
  const state = harness({
    switchSession: async () => ({ cancelled: true }),
  });
  assert.equal(await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), "cancelled");
  assert.deepEqual(state.cleaned, ["/sessions/repo/fork.jsonl"]);
});

test("does not delete a live fork when a post-switch callback fails", async () => {
  const state = harness({ dependencies: { afterSwitch: async () => { throw new Error("notification failed"); } } });
  await assert.rejects(continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), /notification failed/);
  assert.deepEqual(state.cleaned, []);
  assert.equal(state.switches.length, 1);
});

test("revalidates the worktree before and after creating the fork", async () => {
  let validations = 0;
  const state = harness({ dependencies: { revalidate: async () => ++validations === 1 } });
  assert.equal(await continueConversationInWorktree(state.ctx, "/repo-feature", state.dependencies), "refused");
  assert.equal(validations, 2);
  assert.deepEqual(state.cleaned, ["/sessions/repo/fork.jsonl"]);
  assert.deepEqual(state.switches, []);
});
