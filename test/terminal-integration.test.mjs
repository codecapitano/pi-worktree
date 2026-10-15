import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension from "../extensions/git-worktree.ts";
import { saveTerminalCwd } from "../lib/config.ts";

function load(exec = () => { throw new Error("must not run Git"); }) {
	const handlers = new Map();
	const commands = new Map();
	extension({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut() {},
		exec,
	});
	return { handlers, commands };
}

test("terminal directory reporting follows session lifecycle and restores on disable or quit", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-worktree-terminal-integration-"));
	const env = { ...process.env };
	const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const originalCwd = process.cwd();
	const writes = [];
	const originalWrite = process.stdout.write;
	t.after(async () => {
		for (const key of ["PI_CODING_AGENT_DIR", "TERM_PROGRAM", "TMUX", "STY"]) {
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = env[key];
		}
		if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
		else delete process.stdout.isTTY;
		await rm(agentDir, { recursive: true, force: true });
	});
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.TERM_PROGRAM = "iTerm.app";
	delete process.env.TMUX;
	delete process.env.STY;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	t.mock.method(process.stdout, "write", function (data, ...args) {
		if (typeof data === "string" && data.startsWith("\x1b]1337;CurrentDir=")) {
			writes.push(data);
			return true;
		}
		return originalWrite.call(this, data, ...args);
	});
	const ctx = { mode: "tui", hasUI: true, cwd: "/repo-feature", ui: { notify() {} } };
	let loaded = load();
	await loaded.handlers.get("session_start")({}, ctx);
	assert.deepEqual(writes, [], "default must not change terminal state");

	await saveTerminalCwd(true);
	await loaded.handlers.get("session_start")({}, { ...ctx, mode: "json" });
	await loaded.handlers.get("session_start")({}, { ...ctx, hasUI: false });
	assert.deepEqual(writes, [], "non-TUI sessions and unavailable UIs never emit terminal escapes");
	await loaded.handlers.get("session_start")({}, ctx);
	assert.equal(writes.at(-1), "\x1b]1337;CurrentDir=/repo-feature\x07");
	await loaded.handlers.get("session_shutdown")({ reason: "resume" }, ctx);
	assert.equal(writes.length, 1, "session replacement must not restore the launching directory");
	loaded = load();
	await loaded.handlers.get("session_start")({}, { ...ctx, cwd: "/repo-other" });
	assert.equal(writes.at(-1), "\x1b]1337;CurrentDir=/repo-other\x07");
	await loaded.handlers.get("session_shutdown")({ reason: "reload" }, ctx);
	assert.equal(writes.length, 2);

	await loaded.commands.get("wt").handler("config terminal-cwd off", ctx);
	assert.equal(writes.at(-1), `\x1b]1337;CurrentDir=${originalCwd}\x07`);
	await loaded.commands.get("wt").handler("config terminal-cwd on", ctx);
	assert.equal(writes.at(-1), "\x1b]1337;CurrentDir=/repo-feature\x07");
	await loaded.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
	assert.equal(writes.at(-1), `\x1b]1337;CurrentDir=${originalCwd}\x07`);
	const count = writes.length;
	await loaded.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
	assert.equal(writes.length, count, "shutdown is idempotent");

	// A preference toggle applies to the current session, never an unconfirmed target.
	await saveTerminalCwd(false);
	const target = join(agentDir, "target");
	await mkdir(target);
	loaded = load(async (_program, args) => {
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true" };
		if (args[0] === "rev-parse") return { code: 0, stdout: agentDir };
		if (args[0] === "ls-files") return { code: 0, stdout: "README.md\0" };
		if (args[0] === "worktree") return { code: 0, stdout: `worktree ${agentDir}\nHEAD aaaa\nbranch refs/heads/main\n\nworktree ${target}\nHEAD bbbb\nbranch refs/heads/feature\n` };
		throw new Error(`unexpected Git command ${args.join(" ")}`);
	});
	let screens = 0;
	const switchingCtx = {
		...ctx, cwd: agentDir,
		switchSession() { throw new Error("cancelled switch must not replace session"); },
		ui: {
			notify() {},
			async select(_title, options) { return ++screens === 1 ? options[1] : undefined; },
		},
	};
	await loaded.commands.get("wt").handler("switch feature", switchingCtx);
	assert.equal(screens, 2);
	assert.equal(writes.at(-1), `\x1b]1337;CurrentDir=${agentDir}\x07`);
	assert.equal(writes.some((data) => data.includes("CurrentDir=" + target)), false);
	await loaded.handlers.get("session_shutdown")({ reason: "quit" }, switchingCtx);
});
