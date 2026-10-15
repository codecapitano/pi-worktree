import assert from "node:assert/strict";
import test from "node:test";

import * as terminal from "../lib/terminal-cwd.ts";

function setup(env = { TERM_PROGRAM: "iTerm.app" }, isTTY = true) {
	const writes = [];
	assert.equal(typeof terminal.createTerminalCwdReporter, "function");
	const reporter = terminal.createTerminalCwdReporter("/repo", { isTTY, write: (data) => writes.push(data) }, env);
	return { reporter, writes };
}

test("reports the active directory only when opted in", () => {
	const { reporter, writes } = setup();
	reporter.update("/repo-feature", false);
	assert.deepEqual(writes, []);
	reporter.update("/repo-feature", true);
	assert.deepEqual(writes, ["\x1b]1337;CurrentDir=/repo-feature\x07"]);
});

test("disabling or quitting restores the original directory once", () => {
	const { reporter, writes } = setup();
	reporter.restore();
	reporter.update("/repo-feature", true);
	reporter.update("/repo-feature", true);
	reporter.update("/repo-feature", false);
	reporter.restore();
	assert.deepEqual(writes, ["\x1b]1337;CurrentDir=/repo-feature\x07", "\x1b]1337;CurrentDir=/repo\x07"]);
	reporter.update("/other", true);
	reporter.restore();
	assert.equal(writes.at(-1), "\x1b]1337;CurrentDir=/repo\x07");
});

for (const [name, env, isTTY] of [
	["another terminal", { TERM_PROGRAM: "Apple_Terminal" }, true],
	["tmux", { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" }, true],
	["screen", { TERM_PROGRAM: "iTerm.app", STY: "screen" }, true],
	["redirected output", { TERM_PROGRAM: "iTerm.app" }, false],
]) {
	test(`does not emit escapes for ${name}`, () => {
		const { reporter, writes } = setup(env, isTTY);
		assert.equal(reporter.supported, false);
		reporter.update("/target", true);
		reporter.restore();
		assert.deepEqual(writes, []);
	});
}

test("rejects terminal control characters but permits spaces and unicode", () => {
	const { reporter, writes } = setup();
	for (const path of ["relative", "/repo\nline", "/repo\x07", "/repo\x1b]bad", "/repo\x9c", "/repo\x7f"]) reporter.update(path, true);
	assert.deepEqual(writes, []);
	reporter.update("/repo space/日本語", true);
	assert.equal(writes[0], "\x1b]1337;CurrentDir=/repo space/日本語\x07");
});

test("terminal write failures do not throw or mark a directory as reported", () => {
	let attempts = 0;
	const reporter = terminal.createTerminalCwdReporter("/repo", {
		isTTY: true,
		write() { attempts++; throw new Error("closed"); },
	}, { TERM_PROGRAM: "iTerm.app" });
	assert.doesNotThrow(() => reporter.update("/target", true));
	reporter.restore();
	assert.equal(attempts, 1);
});
