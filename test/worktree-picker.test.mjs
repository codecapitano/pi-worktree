import assert from "node:assert/strict";
import test from "node:test";

import {
	createWorktreePickerItems,
	filterWorktreePickerItems,
	isSubsequence,
} from "../lib/worktree-picker.ts";

const main = { path: "/repo", head: "abcdef0123456789", branch: "main", bare: false, locked: false, prunable: false };
const feature = { path: "/repo-feature-login", head: "1234567890abcdef", branch: "Feature/Login", bare: false, locked: false, prunable: false };

 test("filters every token by case-insensitive subsequence across picker fields", () => {
	const items = createWorktreePickerItems([main, feature], "/repo-feature-login");
	assert.deepEqual(filterWorktreePickerItems(items, "FE lg"), [items[1]]);
	assert.deepEqual(filterWorktreePickerItems(items, "g i 78"), [items[1]]);
	assert.deepEqual(filterWorktreePickerItems(items, "zz"), []);
});

test("preserves original worktree and path identity", () => {
	const worktree = { ...feature };
	const item = createWorktreePickerItems([worktree], worktree.path)[0];
	assert.equal(item.worktree, worktree);
	assert.equal(item.path, worktree.path);
	assert.equal(filterWorktreePickerItems([item], "login")[0], item);
});

test("labels current, main, detached, and locked states", () => {
	const detached = { path: "/repo-detached", head: "deadbeef12345678", branch: null, bare: false, locked: true, prunable: false };
	const items = createWorktreePickerItems([main, detached], "/repo");
	assert.match(items[0].label, /current/);
	assert.match(items[0].label, /main/);
	assert.match(items[1].label, /detached/);
	assert.match(items[1].label, /deadbeef/);
	assert.match(items[1].label, /locked/);
});

test("marks bare, prunable, and missing worktrees unavailable", () => {
	const items = createWorktreePickerItems([
		{ ...main, bare: true },
		{ ...main, path: "/prunable", prunable: true },
		{ ...main, path: "/missing", missing: true },
	]);
	assert.deepEqual(items.map((item) => item.unavailable), [true, true, true]);
	assert.equal(filterWorktreePickerItems(items, "main").length, 3);
});

test("subsequence matching is case insensitive", () => {
	assert.equal(isSubsequence("F/L", "feature/login"), true);
	assert.equal(isSubsequence("xyz", "feature/login"), false);
});
