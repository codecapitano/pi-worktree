import assert from "node:assert/strict";
import test from "node:test";
import { confirmWorktreeSwitch } from "../lib/switch-confirmation.ts";

function setup(choices, save = async () => ({ ok: true, diagnostic: null })) {
	const screens = [];
	const notifications = [];
	const saved = [];
	return {
		screens, notifications, saved,
		ui: {
			async select(title, options) {
				screens.push({ title, options });
				const choice = choices.shift();
				return choice === undefined ? undefined : options[choice];
			},
			notify(message, level) { notifications.push({ message, level }); },
		},
		preference: {
			enabled: false,
			async save(value) { saved.push(value); return save(value); },
		},
	};
}

test("toggling remembers the preference and returns to confirmation", async () => {
	const state = setup([1, 0]);
	assert.equal(await confirmWorktreeSwitch(state.ui, "Continue?", "/target", state.preference), true);
	assert.deepEqual(state.saved, [true]);
	assert.match(state.screens[1].options[1], /Follow Pi's worktree/);
	assert.match(state.screens[1].title, /iTerm2.*reuse/);
});

test("cancel never approves the switch but retains explicitly saved preferences", async () => {
	for (const cancel of [2, undefined]) {
		const state = setup([1, cancel]);
		assert.equal(await confirmWorktreeSwitch(state.ui, "Continue?", "/target", state.preference), false);
		assert.deepEqual(state.saved, [true]);
	}
});

test("failed persistence keeps the displayed preference unchanged", async () => {
	const state = setup([1, 2], async () => ({ ok: false, diagnostic: "disk full" }));
	assert.equal(await confirmWorktreeSwitch(state.ui, "Continue?", "/target", state.preference), false);
	assert.match(state.screens[1].options[1], /Keep original directory/);
	assert.deepEqual(state.notifications, [{ message: "disk full", level: "error" }]);
});

test("remembered follow mode can be disabled", async () => {
	const state = setup([1, 0]);
	state.preference.enabled = true;
	assert.equal(await confirmWorktreeSwitch(state.ui, "Continue?", "/target", state.preference), true);
	assert.deepEqual(state.saved, [false]);
	assert.match(state.screens[1].options[1], /Keep original directory/);
});

test("switch confirmation exposes the remembered terminal pane preference", async () => {
	const state = setup([0]);
	assert.equal(await confirmWorktreeSwitch(state.ui, "Continue?", "/target\nReview AGENTS.md before continuing.", state.preference), true);
	assert.match(state.screens[0].title, /AGENTS\.md/);
	assert.ok(state.screens[0].options.some((option) => /New terminal panes.*Keep original directory/.test(option)));
	assert.deepEqual(state.saved, []);
});
