import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { finishWorktree } from "../lib/finish-worktree.ts";
import extension, {
	branchSlug,
	findWorktree,
	findWorktreeExact,
	parseWorktrees,
} from "../extensions/git-worktree.ts";

process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), "pi-worktree-agent-test-"));

const porcelain = `worktree /repo
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/main

worktree /repo-feature-a
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feature/a

worktree /repo-feature-a-2
HEAD cccccccccccccccccccccccccccccccccccccccc
branch refs/heads/feature-a
locked maintenance
`;

const worktrees = parseWorktrees(porcelain);

test("parses git worktree porcelain output", () => {
	assert.equal(worktrees.length, 3);
	assert.deepEqual(worktrees[1], {
		path: "/repo-feature-a",
		head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		branch: "feature/a",
		bare: false,
		locked: false,
		prunable: false,
	});
	assert.equal(worktrees[2].locked, true);
});

test("parses NUL-delimited worktree paths containing newlines", () => {
	const parsed = parseWorktrees(
		"worktree /repo\0HEAD aaaa\0branch refs/heads/main\0\0" +
			"worktree /repo-feature\nline\0HEAD bbbb\0branch refs/heads/feature/newline\0\0",
	);
	assert.equal(parsed.length, 2);
	assert.equal(parsed[1].path, "/repo-feature\nline");
	assert.equal(parsed[1].branch, "feature/newline");
});

test("exact lookup does not confuse branches with the same slug", () => {
	assert.equal(branchSlug("feature/a"), branchSlug("feature-a"));
	assert.equal(findWorktreeExact(worktrees, "feature/a")?.path, "/repo-feature-a");
	assert.equal(findWorktreeExact(worktrees, "feature-a")?.path, "/repo-feature-a-2");
	assert.equal(findWorktree(worktrees, "FEATURE-A"), undefined);
});

function loadExtension(exec) {
	const commands = new Map();
	const shortcuts = new Map();
	const userMessages = [];
	const handlers = new Map();
	const api = {
		exec,
		registerCommand(name, value) {
			commands.set(name, value);
		},
		registerShortcut(key, value) {
			shortcuts.set(key, value);
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		sendUserMessage(message, options) {
			userMessages.push({ message, options });
		},
		getCommands() {
			return [...commands].map(([name, command]) => ({
				name,
				description: command.description,
				source: "extension",
				sourceInfo: { path: "extensions/git-worktree.ts" },
			}));
		},
	};
	extension(api);
	return { commands, shortcuts, userMessages, handlers, api };
}

function loadCommand(exec, name = "worktree") {
	const loaded = loadExtension(exec);
	const command = loaded.commands.get(name);
	assert.ok(command);
	return command;
}

test("registers /wt and /worktree with the same command behavior", () => {
	const { commands } = loadExtension(async () => ({ code: 0, stdout: "", stderr: "" }));
	assert.deepEqual([...commands.keys()], ["wt", "worktree"]);
	assert.equal(commands.get("wt").handler, commands.get("worktree").handler);
	assert.equal(commands.get("wt").getArgumentCompletions, commands.get("worktree").getArgumentCompletions);
});

test("registers the default shortcut and dispatches /wt through Pi", async () => {
	const loaded = loadExtension(async () => ({ code: 0, stdout: "", stderr: "" }));
	const shortcut = loaded.shortcuts.get("ctrl+alt+w");
	assert.ok(shortcut);
	await shortcut.handler({
		mode: "tui",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify() {} },
	});
	assert.deepEqual(loaded.userMessages, [{
		message: "/wt",
		options: { expandPromptTemplates: true },
	}]);
});

test("reports an incompatible Pi shortcut host", async () => {
	const loaded = loadExtension(async () => ({ code: 0, stdout: "", stderr: "" }));
	delete loaded.api.sendUserMessage;
	const notifications = [];
	await loaded.shortcuts.get("ctrl+alt+w").handler({
		mode: "tui",
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
	});
	assert.match(notifications.at(-1).message, /upgrade to Pi 0\.84\.2/);
});

function context(overrides = {}) {
	const notifications = [];
	const confirmations = [];
	return {
		notifications,
		confirmations,
		ctx: {
			hasUI: true,
			mode: "tui",
			cwd: "/repo",
			isIdle: () => true,
			hasPendingMessages: () => false,
			sessionManager: {
				getSessionFile: () => fileURLToPath(import.meta.url),
				getEntries: () => [{ id: "latest" }],
				getLeafId: () => "latest",
				getSessionDir: () => "/sessions",
				usesDefaultSessionDir: () => true,
			},
			switchSession: async () => ({ cancelled: false }),
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
				async confirm(title, message) {
					confirmations.push({ title, message });
					return true;
				},
				async select() {
					return null;
				},
			},
			...overrides,
		},
	};
}

function repoPrelude(args) {
	if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
		return { code: 0, stdout: "true", stderr: "" };
	}
	if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
		return { code: 0, stdout: "/repo", stderr: "" };
	}
	return null;
}

test("refuses switching outside TUI mode before changing Git state", async () => {
	const calls = [];
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		return repoPrelude(args) ?? { code: 0, stdout: "", stderr: "" };
	}, "wt");
	const state = context({ mode: "json" });
	await command.handler("new feature/no-tui", state.ctx);
	assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "add"), false);
	assert.match(state.notifications.at(-1).message, /interactive Pi TUI mode/);
});

test("refuses creation before changing Git when conversation history has no session file", async () => {
	const calls = [];
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		return repoPrelude(args) ?? { code: 0, stdout: "", stderr: "" };
	}, "wt");
	const state = context({
		sessionManager: {
			getSessionFile: () => undefined,
			getEntries: () => [{ id: "message", type: "message" }],
			getLeafId: () => "message",
			getSessionDir: () => "/sessions",
		},
	});
	await command.handler("new feature/no-session", state.ctx);
	assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "add"), false);
	assert.match(state.notifications.at(-1).message, /session file is missing/);
});

test("reports a Pi host without session replacement support", async () => {
	const command = loadCommand(async (_program, args) => {
		const prelude = repoPrelude(args);
		if (prelude) return prelude;
		if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: porcelain, stderr: "" };
		throw new Error(`unexpected call: ${args.join(" ")}`);
	}, "wt");
	const state = context({ cwd: "/repo", switchSession: undefined });
	await command.handler("switch feature/a", state.ctx);
	assert.match(state.notifications.at(-1).message, /upgrade to Pi 0\.84\.2/);
});

test("exact and bare switch commands warn before entering an existing worktree", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-trust-test-"));
	const repo = join(root, "repo");
	const target = join(root, "repo-pr-42");
	await mkdir(repo);
	await mkdir(target);
	try {
		const command = loadCommand(async (_program, args) => {
			if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true", stderr: "" };
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo, stderr: "" };
			if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree ${repo}\nHEAD aaaa\nbranch refs/heads/main\n\nworktree ${target}\nHEAD bbbb\nbranch refs/heads/pr-42\n`, stderr: "" };
			if (args[0] === "ls-files") return { code: 0, stdout: "README.md\0", stderr: "" };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		}, "wt");
		for (const args of ["switch pr-42", "pr-42"]) {
			let switched = false;
			const state = context({
				cwd: repo,
				switchSession: async () => { switched = true; return { cancelled: false }; },
			});
			state.ctx.ui.confirm = async (title, message) => {
				state.confirmations.push({ title, message });
				return false;
			};
			await command.handler(args, state.ctx);
			assert.equal(switched, false, args);
			assert.equal(state.confirmations.length, 1, `${args}: ${JSON.stringify(state.notifications)}`);
			assert.match(state.confirmations[0].message, /AGENTS\.md/);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses an incomplete checkout before switch confirmation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-incomplete-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const target = join(root, "target");
	await mkdir(repo);
	await mkdir(target);
	const calls = [];
	const command = loadCommand(async (_program, args, options) => {
		calls.push({ args, cwd: options?.cwd });
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true" };
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo };
		if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree ${repo}\0HEAD aaaa\0branch refs/heads/main\0\0worktree ${target}\0HEAD bbbb\0branch refs/heads/feature\0\0` };
		if (args[0] === "ls-files") return { code: 0, stdout: "" };
		if (args[0] === "ls-tree") return { code: 0, stdout: "README.md\0" };
		throw new Error(`unexpected call: ${args.join(" ")}`);
	}, "wt");
	let switched = false;
	const state = context({ cwd: repo, switchSession: async () => { switched = true; return { cancelled: false }; } });
	state.ctx.ui.confirm = async (title, message) => {
		state.confirmations.push({ title, message });
		return false;
	};
	await command.handler("switch feature", state.ctx);
	assert.equal(state.confirmations.length, 0);
	assert.equal(switched, false);
	assert.ok(state.notifications.some(({ message, level }) => level === "error" && /incomplete checkout/i.test(message) && message.includes(target) && /no files changed/i.test(message)));
	assert.deepEqual(calls.filter(({ args }) => ["ls-files", "ls-tree"].includes(args[0])), [
		{ args: ["ls-files", "-z"], cwd: target },
		{ args: ["ls-tree", "-r", "--name-only", "-z", "HEAD"], cwd: target },
	]);
});

for (const scenario of [
	{ name: "index inspection failure", index: { code: 1, stderr: "index unavailable" }, refused: true },
	{ name: "all staged deletions", index: { code: 0, stdout: "" }, tree: { code: 0, stdout: "README.md\0" }, refused: true },
	{ name: "HEAD inspection failure", index: { code: 0, stdout: "" }, tree: { code: 1, stderr: "HEAD unavailable" }, refused: true },
	{ name: "truly empty HEAD", index: { code: 0, stdout: "" }, tree: { code: 0, stdout: "" } },
	{ name: "dirty populated checkout", index: { code: 0, stdout: "README.md\0" } },
	{ name: "sparse checkout", index: { code: 0, stdout: "excluded/file.md\0" } },
	{ name: "late empty index", index: { code: 0, stdout: "README.md\0" }, tree: { code: 0, stdout: "README.md\0" }, late: true },
]) {
	test(`checkout safeguard handles ${scenario.name}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-worktree-inspection-test-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, "repo");
		const target = join(root, "target");
		await mkdir(repo);
		await mkdir(target);
		let indexReads = 0;
		const calls = [];
		const command = loadCommand(async (_program, args, options) => {
			calls.push(args);
			if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true" };
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo };
			if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree ${repo}\0HEAD aaaa\0branch refs/heads/main\0\0worktree ${target}\0HEAD bbbb\0branch refs/heads/feature\0\0` };
			assert.equal(options.cwd, target);
			if (args[0] === "ls-files") return scenario.late && ++indexReads > 1 ? { code: 0, stdout: "" } : scenario.index;
			if (args[0] === "ls-tree") return scenario.tree;
			throw new Error(`unexpected call: ${args.join(" ")}`);
		}, "wt");
		let switched = false;
		const state = context({ cwd: repo, switchSession: async () => { switched = true; return { cancelled: false }; } });
		state.ctx.ui.confirm = async (title, message) => {
			state.confirmations.push({ title, message });
			return Boolean(scenario.late);
		};
		await command.handler("switch feature", state.ctx);
		assert.equal(switched, false);
		assert.equal(state.confirmations.length, scenario.refused ? 0 : 1);
		if (scenario.refused || scenario.late) {
			assert.ok(state.notifications.some(({ message }) => /Could not inspect worktree checkout|Incomplete checkout/.test(message) && message.includes(target) && /no files changed/.test(message)), JSON.stringify(state.notifications));
		} else {
			assert.match(state.notifications.at(-1).message, /Worktree retained/);
		}
		if (scenario.late) assert.equal(indexReads, 2, "revalidate before preparing the fork");
		assert.equal(calls.some((args) => ["restore", "reset", "rm", "read-tree"].includes(args[0])), false);
	});
}

test("refuses a real no-checkout worktree created successfully through new", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-no-checkout-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const target = join(root, "repo-feature");
	await mkdir(repo);
	const git = async (args, cwd = repo) => {
		const result = await execute("git", args, { cwd, timeout: 5000 });
		assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
		return result;
	};
	for (const args of [
		["init", "-b", "main"],
		["config", "user.name", "Test User"],
		["config", "user.email", "test@example.com"],
		["config", "commit.gpgsign", "false"],
		["config", "core.hooksPath", join(root, "disabled-hooks")],
	]) await git(args);
	await writeFile(join(repo, "README.md"), "keep this\n");
	await git(["add", "README.md"]);
	await git(["commit", "-m", "initial"]);
	const calls = [];
	const command = loadCommand(async (program, args, options) => {
		calls.push(args);
		const injected = args[0] === "worktree" && args[1] === "add" ? [...args.slice(0, 2), "--no-checkout", ...args.slice(2)] : args;
		return execute(program, injected, { cwd: options?.cwd ?? repo, timeout: 5000 });
	}, "wt");
	const state = context({ cwd: repo });
	let switched = false;
	state.ctx.switchSession = async () => { switched = true; return { cancelled: false }; };
	await command.handler("new feature", state.ctx);
	assert.ok(state.notifications.some(({ message }) => /Created feature/.test(message)), JSON.stringify(state.notifications));
	assert.ok(state.notifications.some(({ message }) => /Incomplete checkout/.test(message) && message.includes(target)), JSON.stringify(state.notifications));
	for (const args of ["add feature", "switch feature", "feature"]) {
		await command.handler(args, state.ctx);
		assert.match(state.notifications.at(-1).message, /Incomplete checkout/);
	}
	assert.equal(state.confirmations.length, 0);
	assert.equal(switched, false);
	assert.equal((await git(["ls-files", "-z"], target)).stdout, "");
	assert.equal((await git(["ls-tree", "-r", "--name-only", "-z", "HEAD"], target)).stdout, "README.md\0");
	await assert.rejects(access(join(target, "README.md")));
	await access(join(target, ".git"));
	await git(["show-ref", "--verify", "refs/heads/feature"]);
	assert.equal(calls.some((args) => ["restore", "reset", "rm", "read-tree"].includes(args[0]) || (args[0] === "worktree" && args[1] === "remove")), false);
});

test("reports the Git requirement when porcelain-z listing fails", async () => {
	const command = loadCommand(async (_program, args) => {
		const prelude = repoPrelude(args);
		if (prelude) return prelude;
		if (args[0] === "worktree" && args[1] === "list") {
			return { code: 129, stdout: "", stderr: "unknown option z" };
		}
		throw new Error(`unexpected call: ${args.join(" ")}`);
	}, "wt");
	const state = context();
	await command.handler("ls", state.ctx);
	assert.match(state.notifications.at(-1).message, /requires Git 2\.36 or newer/);
});

test("/wt done refuses to remove the main worktree", async () => {
	const repo = await mkdtemp(join(tmpdir(), "pi-worktree-main-test-"));
	try {
		const calls = [];
		const command = loadCommand(async (_program, args) => {
			calls.push(args);
			if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true", stderr: "" };
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo, stderr: "" };
			if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree ${repo}\nHEAD aaaa\nbranch refs/heads/main\n`, stderr: "" };
			throw new Error(`unexpected call: ${args.join(" ")}`);
		}, "wt");
		const state = context({ cwd: repo });
		await command.handler("done", state.ctx);
		assert.match(state.notifications.at(-1).message, /Refusing to remove the main worktree/);
		assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("/wt done rejects arguments", async () => {
	const command = loadCommand(async (_program, args) => repoPrelude(args) ?? { code: 0, stdout: "", stderr: "" }, "wt");
	const state = context();
	await command.handler("done feature/a", state.ctx);
	assert.match(state.notifications.at(-1).message, /Usage: \/wt done/);
});

test("removal requires an interactive context", async () => {
	const calls = [];
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		const prelude = repoPrelude(args);
		if (prelude) return prelude;
		if (args[0] === "worktree" && args[1] === "list") {
			return { code: 0, stdout: porcelain, stderr: "" };
		}
		throw new Error(`unexpected call: ${args.join(" ")}`);
	});
	const state = context({ hasUI: false });

	await command.handler("rm feature/a", state.ctx);

	assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
	assert.match(state.notifications.at(-1).message, /requires interactive confirmation/);
});

test("dirty worktree removal never retries with force", async () => {
	const calls = [];
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		const prelude = repoPrelude(args);
		if (prelude) return prelude;
		if (args[0] === "worktree" && args[1] === "list") {
			return { code: 0, stdout: porcelain, stderr: "" };
		}
		if (args[0] === "worktree" && args[1] === "remove") {
			return { code: 1, stdout: "", stderr: "contains modified or untracked files" };
		}
		throw new Error(`unexpected call: ${args.join(" ")}`);
	});
	const state = context();

	await command.handler("rm feature/a", state.ctx);

	const removals = calls.filter((args) => args[0] === "worktree" && args[1] === "remove");
	assert.deepEqual(removals, [["worktree", "remove", "/repo-feature-a"]]);
	assert.match(state.notifications.at(-1).message, /left intact/);
});

function execute(program, args, options = {}) {
	return new Promise((resolve) => {
		// Bound fixture commands while leaving time for a 120-second sandbox approval.
		const child = spawn(program, args, { timeout: 125000, killSignal: "SIGKILL", ...options });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
		child.on("close", (code, signal) => resolve({
			code: code ?? 1,
			stdout,
			stderr: signal ? `${stderr}\nFixture command timed out or was terminated (${signal}): ${program} ${args.join(" ")}` : stderr,
		}));
	});
}

test("reports when a fixture command times out", async () => {
	const result = await execute(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 100 });
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /timed out/);
});

test("finishes a real clean checkout after session replacement and retains its branch", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-done-test-"));
	const repo = join(root, "repo");
	const secondary = join(root, "secondary");
	await mkdir(repo);
	try {
		for (const args of [
			["init", "-b", "main"],
			["config", "user.name", "Test User"],
			["config", "user.email", "test@example.com"],
			["config", "commit.gpgsign", "false"],
			["config", "core.hooksPath", join(root, "disabled-hooks")],
		]) {
			const result = await execute("git", args, { cwd: repo });
			assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
		}
		await writeFile(join(repo, "README.md"), "test\n");
		await writeFile(join(repo, ".gitignore"), ".env\n");
		for (const args of [["add", "README.md", ".gitignore"], ["commit", "-m", "initial"], ["worktree", "add", "-b", "feature/test", secondary]]) {
			const result = await execute("git", args, { cwd: repo });
			assert.equal(result.code, 0, result.stderr);
		}
		await writeFile(join(secondary, ".env"), "keep this\n");
		const state = context({ cwd: secondary });
		let replaced = false;
		state.ctx.switchSession = async (_session, options) => {
			replaced = true;
			await options.withSession({ ui: state.ctx.ui });
			return { cancelled: false };
		};
		const dependencies = {
			exists: async () => true,
			usesDefaultSessionDir: () => true,
			revalidate: async () => true,
			forkSession: async () => ({ path: "/sessions/fork.jsonl" }),
			removeSession: async () => {},
			isSessionSafe: async () => true,
			isCurrentWorktree: async () => true,
			isClean: async () => (await execute("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], { cwd: secondary })).stdout === "",
			removeWorktree: async () => {
				assert.equal(replaced, true);
				return execute("git", ["worktree", "remove", secondary], { cwd: repo });
			},
		};
		assert.equal(await finishWorktree(state.ctx, repo, dependencies), "refused");
		assert.equal(replaced, false);
		await access(join(secondary, ".env"));
		await rm(join(secondary, ".env"));
		assert.equal(await finishWorktree(state.ctx, repo, dependencies), "removed");
		await assert.rejects(access(secondary));
		assert.equal((await execute("git", ["show-ref", "--verify", "refs/heads/feature/test"], { cwd: repo })).code, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("creates and safely removes a real temporary worktree while retaining its branch", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-test-"));
	const repo = join(root, "repo");
	await mkdir(repo);
	try {
		for (const args of [
			["init", "-b", "main"],
			["config", "user.name", "Test User"],
			["config", "user.email", "test@example.com"],
			["config", "commit.gpgsign", "false"],
			["config", "core.hooksPath", join(root, "disabled-hooks")],
		]) {
			const result = await execute("git", args, { cwd: repo });
			assert.equal(result.code, 0, result.stderr);
		}
		await writeFile(join(repo, "README.md"), "test\n");
		for (const args of [["add", "README.md"], ["commit", "-m", "initial"]]) {
			const result = await execute("git", args, { cwd: repo });
			assert.equal(result.code, 0, result.stderr);
		}

		const command = loadCommand(async (program, args, options = {}) => {
			if (program === "bash") return { code: 1, stdout: "", stderr: "clipboard unavailable" };
			return execute(program, args, { cwd: options.cwd ?? repo });
		});
		const state = context({ cwd: repo });
		await command.handler("add feature/test", state.ctx);

		const listed = await execute("git", ["worktree", "list", "--porcelain"], { cwd: repo });
		const created = parseWorktrees(listed.stdout).find((wt) => wt.branch === "feature/test");
		assert.ok(created, listed.stdout);

		await command.handler("rm feature/test", state.ctx);
		const after = await execute("git", ["worktree", "list", "--porcelain"], { cwd: repo });
		assert.doesNotMatch(after.stdout, /branch refs\/heads\/feature\/test/);
		const branch = await execute("git", ["show-ref", "--verify", "refs/heads/feature/test"], { cwd: repo });
		assert.equal(branch.code, 0, "the branch must remain after worktree removal");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses the sibling worktree layout without a workspace worktrees directory", async () => {
	const calls = [];
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		const prelude = repoPrelude(args);
		if (prelude) return prelude;
		if (args[0] === "check-ref-format") return { code: 0, stdout: "feature/new", stderr: "" };
		if (args[0] === "worktree" && args[1] === "list") {
			return { code: 0, stdout: `worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n`, stderr: "" };
		}
		if (args[0] === "remote" && args[1] === "get-url") {
			return { code: 2, stdout: "", stderr: "No such remote 'origin'" };
		}
		if (args[0] === "show-ref" && args.at(-1) === "refs/heads/main") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "show-ref" && args.at(-1).startsWith("refs/remotes/origin/")) {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
		if (args[0] === "worktree" && args[1] === "add") {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (_program === "bash") return { code: 1, stdout: "", stderr: "clipboard unavailable" };
		throw new Error(`unexpected call: ${args.join(" ")}`);
	});
	const state = context();

	await command.handler("add feature/new", state.ctx);

	assert.equal(calls.some((args) => args[0] === "symbolic-ref"), false);
	const add = calls.find((args) => args[0] === "worktree" && args[1] === "add");
	assert.deepEqual(add, ["worktree", "add", "-b", "feature/new", "/repo-feature-new", "main"]);
});

test("creates new worktrees in an existing workspace worktrees directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-workspace-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const targetParent = join(root, "worktrees", "repo");
	const target = join(targetParent, "feature-new");
	await mkdir(repo, { recursive: true });
	await mkdir(join(root, "worktrees"));
	const calls = [];
	let added = false;
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo, stderr: "" };
		if (args[0] === "check-ref-format") return { code: 0, stdout: "feature/new", stderr: "" };
		if (args[0] === "worktree" && args[1] === "list") {
			return {
				code: 0,
				stdout: added
					? `worktree ${repo}\nHEAD aaaa\nbranch refs/heads/main\n\nworktree ${target}\nHEAD bbbb\nbranch refs/heads/feature/new\n`
					: `worktree ${repo}\nHEAD aaaa\nbranch refs/heads/main\n`,
				stderr: "",
			};
		}
		if (args[0] === "remote" && args[1] === "get-url") return { code: 2, stdout: "", stderr: "No such remote 'origin'" };
		if (args[0] === "show-ref" && args.at(-1) === "refs/heads/main") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
		if (args[0] === "worktree" && args[1] === "add") {
			added = true;
			await mkdir(target, { recursive: true });
			return { code: 0, stdout: "", stderr: "" };
		}
		if (_program === "bash") return { code: 1, stdout: "", stderr: "clipboard unavailable" };
		if (args[0] === "ls-files") return { code: 0, stdout: "README.md\0", stderr: "" };
		throw new Error(`unexpected call: ${args.join(" ")}`);
	});
	const state = context({ cwd: repo });
	state.ctx.ui.confirm = async () => false;

	await command.handler("new feature/new", state.ctx);

	const add = calls.find((args) => args[0] === "worktree" && args[1] === "add");
	assert.deepEqual(add, ["worktree", "add", "-b", "feature/new", target, "main"]);
	await assert.doesNotReject(() => access(targetParent));
});

test("PR checkout from a fresh session creates a branch from the verified fetched ref", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-pr-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const targetParent = join(root, "worktrees", "repo");
	const target = join(targetParent, "feature-a");
	await mkdir(repo);
	await mkdir(join(root, "worktrees"));
	const calls = [];
	let added = false;
	const command = loadCommand(async (program, args) => {
		calls.push({ program, args });
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo, stderr: "" };
		if (program === "gh") {
			return {
				code: 0,
				stdout: JSON.stringify({ headRefName: "feature/a", headRefOid: "bbbb", baseRefName: "main", number: 42, title: "Feature" }),
				stderr: "",
			};
		}
		if (args[0] === "remote" && args[1] === "get-url") {
			return { code: 0, stdout: "git@github.com:owner/repo.git", stderr: "" };
		}
		if (program === "bash") return { code: 1, stdout: "", stderr: "clipboard unavailable" };
		if (args[0] === "check-ref-format") return { code: 0, stdout: "feature/a", stderr: "" };
		if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "rev-parse" && args[2] === "refs/pi-worktree/pr/42") {
			return { code: 0, stdout: "bbbb", stderr: "" };
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return {
				code: 0,
				stdout: added
					? `worktree ${repo}\nHEAD aaaa\nbranch refs/heads/main\n\nworktree ${target}\nHEAD bbbb\nbranch refs/heads/feature/a\n`
					: `worktree ${repo}\nHEAD aaaa\nbranch refs/heads/main\n`,
				stderr: "",
			};
		}
		if (args[0] === "rev-parse" && args[2] === "refs/heads/feature/a") {
			return { code: 1, stdout: "", stderr: "unknown revision" };
		}
		if (args[0] === "worktree" && args[1] === "add") {
			added = true;
			await mkdir(target, { recursive: true });
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "ls-files") return { code: 0, stdout: "README.md\0", stderr: "" };
		throw new Error(`unexpected call: ${program} ${args.join(" ")}`);
	});
	const state = context({ cwd: repo });
	state.ctx.ui.confirm = async (title, message) => {
		state.confirmations.push({ title, message });
		return false;
	};

	state.ctx.sessionManager = {
		getSessionFile: () => join(root, "unwritten-session.jsonl"),
		getEntries: () => [],
		getLeafId: () => null,
		getSessionDir: () => join(root, "sessions"),
		usesDefaultSessionDir: () => true,
	};
	await command.handler("pr 42", state.ctx);

	const ghView = calls.find(({ program }) => program === "gh");
	assert.deepEqual(ghView.args.slice(-2), ["--repo", "git@github.com:owner/repo.git"]);
	assert.ok(ghView.args[ghView.args.indexOf("--json") + 1].split(",").includes("baseRefName"));
	assert.ok(calls.some(({ args }) => args[0] === "fetch" && args.includes("+refs/heads/main:refs/remotes/origin/main")));
	const add = calls.find(({ args }) => args[0] === "worktree" && args[1] === "add");
	assert.deepEqual(add.args, [
		"worktree",
		"add",
		"-b",
		"feature/a",
		target,
		"refs/pi-worktree/pr/42",
	]);
	assert.ok(state.notifications.some(({ message }) => /PR #42 Feature/.test(message)));
	assert.ok(state.notifications.some(({ message }) => /Worktree retained at .*worktrees\/repo\/feature-a$/.test(message)));
	await assert.doesNotReject(() => access(targetParent));
	assert.equal(state.confirmations.length, 1);
	assert.match(state.confirmations[0].message, /AGENTS\.md/);
	assert.match(state.confirmations[0].message, /trusted \.pi resources/);
});

test("PR checkout refuses an unpopulated target after successful creation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-pr-incomplete-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const target = join(root, "repo-feature");
	await mkdir(repo);
	let added = false;
	const calls = [];
	const command = loadCommand(async (program, args) => {
		calls.push(args);
		if (program === "gh") return { code: 0, stdout: JSON.stringify({ headRefName: "feature", headRefOid: "bbbb", baseRefName: "main", number: 42 }) };
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true" };
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo };
		if (args[0] === "remote") return { code: 0, stdout: "git@github.com:owner/repo.git" };
		if (args[0] === "check-ref-format" || args[0] === "fetch") return { code: 0, stdout: "" };
		if (args[0] === "rev-parse") return args[2] === "refs/pi-worktree/pr/42" ? { code: 0, stdout: "bbbb" } : { code: 1, stdout: "" };
		if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree ${repo}\0HEAD aaaa\0branch refs/heads/main\0\0${added ? `worktree ${target}\0HEAD bbbb\0branch refs/heads/feature\0\0` : ""}` };
		if (args[0] === "worktree" && args[1] === "add") {
			added = true;
			await mkdir(target);
			return { code: 0, stdout: "" };
		}
		if (args[0] === "ls-files") return { code: 0, stdout: "" };
		if (args[0] === "ls-tree") return { code: 0, stdout: "README.md\0" };
		throw new Error(`unexpected call: ${args.join(" ")}`);
	}, "wt");
	let switched = false;
	const state = context({ cwd: repo, switchSession: async () => { switched = true; return { cancelled: false }; } });
	await command.handler("pr 42", state.ctx);
	assert.equal(added, true);
	assert.equal(state.confirmations.length, 0);
	assert.equal(switched, false);
	assert.match(state.notifications.at(-1).message, /Incomplete checkout/);
	assert.ok(state.notifications.at(-1).message.includes(target));
	assert.equal(calls.some((args) => ["restore", "reset", "rm", "read-tree"].includes(args[0]) || (args[0] === "worktree" && args[1] === "remove")), false);
	await access(target);
});

test("subcommand suggestions explain each option without changing command values", async () => {
	for (const name of ["wt", "worktree"]) {
		const command = loadCommand(async () => {
			throw new Error("subcommand completion must not run Git");
		}, name);
		const completions = await command.getArgumentCompletions("");
		assert.deepEqual(completions.map(({ value }) => value), [
			"switch", "new", "add", "pr", "open", "path", "ls", "rm", "done", "config", "help",
		]);
		for (const item of completions) {
			assert.equal(item.label, item.value);
			assert.equal(typeof item.description, "string", `${item.value} needs a description`);
			assert.ok(item.description.trim().length > 0);
		}
	}
});

test("filtered subcommand suggestions retain descriptions", async () => {
	const command = loadCommand(async () => {
		throw new Error("subcommand completion must not run Git");
	}, "wt");
	const all = await command.getArgumentCompletions("");
	assert.deepEqual(
		await command.getArgumentCompletions("  sw"),
		all.filter(({ value }) => value === "switch"),
	);
	assert.deepEqual(await command.getArgumentCompletions("unknown"), []);
});

test("completes registered worktree branches for switch commands", async () => {
	const command = loadCommand(async (_program, args) => {
		if (args[0] === "worktree" && args[1] === "list") {
			return { code: 0, stdout: porcelain, stderr: "" };
		}
		throw new Error(`unexpected call: ${args.join(" ")}`);
	}, "wt");
	const completions = await command.getArgumentCompletions("switch feature/");
	assert.deepEqual(completions.map((item) => item.label), ["feature/a"]);
});

test("remote branch fetch failure does not create a branch from the default base", async () => {
	const calls = [];
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		const prelude = repoPrelude(args);
		if (prelude) return prelude;
		if (args[0] === "check-ref-format") return { code: 0, stdout: "feature/remote", stderr: "" };
		if (args[0] === "worktree" && args[1] === "list") {
			return { code: 0, stdout: `worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n`, stderr: "" };
		}
		if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
		if (args[0] === "remote" && args[1] === "get-url") {
			return { code: 0, stdout: "git@github.com:owner/repo.git", stderr: "" };
		}
		if (args[0] === "ls-remote") return { code: 0, stdout: "bbbb\trefs/heads/feature/remote", stderr: "" };
		if (args[0] === "fetch") return { code: 1, stdout: "", stderr: "network failure" };
		throw new Error(`unexpected call: ${args.join(" ")}`);
	});
	const state = context();

	await command.handler("add feature/remote", state.ctx);

	assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "add"), false);
	assert.match(state.notifications.at(-1).message, /Could not fetch origin\/feature\/remote/);
});

test("PR checkout refuses a stale local branch", async () => {
	const calls = [];
	const command = loadCommand(async (program, args) => {
		calls.push({ program, args });
		const prelude = repoPrelude(args);
		if (prelude) return prelude;
		if (program === "gh") {
			return {
				code: 0,
				stdout: JSON.stringify({ headRefName: "feature/a", headRefOid: "bbbb", baseRefName: "main", number: 42, title: "Feature" }),
				stderr: "",
			};
		}
		if (args[0] === "remote" && args[1] === "get-url") {
			return { code: 0, stdout: "git@github.com:owner/repo.git", stderr: "" };
		}
		if (args[0] === "check-ref-format") return { code: 0, stdout: "feature/a", stderr: "" };
		if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "rev-parse" && args[2] === "refs/pi-worktree/pr/42") {
			return { code: 0, stdout: "bbbb", stderr: "" };
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return {
				code: 0,
				stdout: `worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n`,
				stderr: "",
			};
		}
		if (args[0] === "rev-parse" && args[2] === "refs/heads/feature/a") {
			return { code: 0, stdout: "aaaa", stderr: "" };
		}
		throw new Error(`unexpected call: ${program} ${args.join(" ")}`);
	});
	const state = context();

	await command.handler("pr 42", state.ctx);

	assert.equal(calls.some(({ args }) => args[0] === "worktree" && args[1] === "add"), false);
	assert.match(state.notifications.at(-1).message, /does not match PR #42/);
});

async function prRefreshHarness(t, { base = "release/1.x", head = "feature/a", existing = false, baseFails = false, fetchedHead = "bbbb" } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-pr-refresh-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const target = join(root, "repo-feature-a");
	await mkdir(repo);
	if (existing) await mkdir(target);
	const calls = [];
	let added = false;
	const command = loadCommand(async (program, args) => {
		calls.push({ program, args });
		if (program === "gh") return { code: 0, stdout: JSON.stringify({ headRefName: head, headRefOid: "bbbb", baseRefName: base ?? undefined }) };
		if (program === "bash") return { code: 1, stdout: "" };
		if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { code: 0, stdout: "true" };
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: repo };
		if (args[0] === "remote") return { code: 0, stdout: "git@github.com:owner/repo.git" };
		if (args[0] === "check-ref-format") return execute("git", args, { cwd: repo });
		if (args[0] === "fetch") return args.includes(`+refs/heads/${base}:refs/remotes/origin/${base}`) && baseFails
			? { code: 1, stderr: "base fetch denied" } : { code: 0, stdout: "" };
		if (args[0] === "rev-parse") return args[2] === "refs/pi-worktree/pr/42"
			? { code: 0, stdout: fetchedHead } : { code: 1, stdout: "" };
		if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout:
			`worktree ${repo}\nHEAD aaaa\nbranch refs/heads/main\n\n${existing || added ? `worktree ${target}\nHEAD bbbb\nbranch refs/heads/feature/a\n` : ""}` };
		if (args[0] === "worktree" && args[1] === "add") {
			added = true;
			await mkdir(target);
			return { code: 0, stdout: "" };
		}
		if (args[0] === "ls-files") return { code: 0, stdout: "README.md\0" };
		throw new Error(`unexpected call: ${program} ${args.join(" ")}`);
	}, "wt");
	let switched = false;
	const state = context({ cwd: repo, switchSession: async () => { switched = true; return { cancelled: false }; } });
	state.ctx.ui.confirm = async (title, message) => {
		calls.push({ program: "confirm", args: [] });
		state.confirmations.push({ title, message });
		return false;
	};
	await command.handler("pr 42", state.ctx);
	return { calls, state, added, switched, target };
}

for (const existing of [false, true]) {
	test(`PR checkout refreshes a non-main base before ${existing ? "reusing" : "creating"} its worktree`, async (t) => {
		const { calls, state, added, target } = await prRefreshHarness(t, { existing });
		const fetches = calls.filter(({ args }) => args[0] === "fetch");
		assert.deepEqual(fetches.map(({ args }) => args), [
			["fetch", "origin", "+pull/42/head:refs/pi-worktree/pr/42"],
			["fetch", "origin", "+refs/heads/release/1.x:refs/remotes/origin/release/1.x"],
		]);
		const baseIndex = calls.indexOf(fetches[1]);
		assert.ok(baseIndex < calls.findIndex(({ args }) => args[0] === "worktree"));
		assert.ok(baseIndex < calls.findIndex(({ program }) => program === "confirm"));
		assert.equal(added, !existing);
		assert.equal(state.confirmations.length, 1);
		assert.ok(state.notifications.some(({ message }) => message.includes(`Worktree retained at ${target}`)));
		if (existing) assert.ok(state.notifications.some(({ message }) => /Using existing PR worktree/.test(message)));
	});

	test(`PR base-fetch failure blocks ${existing ? "existing-worktree reuse" : "worktree creation"}`, async (t) => {
		const { calls, state, added, switched } = await prRefreshHarness(t, { existing, baseFails: true });
		assert.equal(added, false);
		assert.equal(switched, false);
		assert.equal(state.confirmations.length, 0);
		assert.equal(calls.some(({ args }) => args[0] === "worktree"), false);
		assert.equal(state.notifications.at(-1).level, "error");
		assert.match(state.notifications.at(-1).message, /Could not refresh origin\/release\/1\.x:\nbase fetch denied/);
	});
}

for (const name of [undefined, "", "HEAD", "@{-1}", "bad:ref", "-option", "bad..ref", "bad ref", "branch.lock"]) {
	test(`PR checkout rejects invalid base branch ${JSON.stringify(name)} before fetching`, async (t) => {
		// Omission is explicit because the harness's default is a valid release branch.
		const { calls, state } = await prRefreshHarness(t, { base: name === undefined ? null : name });
		assert.equal(calls.some(({ args }) => args[0] === "fetch" || args[0] === "worktree"), false);
		assert.equal(state.confirmations.length, 0);
		assert.match(state.notifications.at(-1).message, /invalid base branch/);
	});
}

for (const head of ["HEAD", "@{-1}", "bad:ref", "-option"]) {
	test(`PR checkout rejects unsafe head branch ${head}`, async (t) => {
		const { calls, state } = await prRefreshHarness(t, { head });
		assert.equal(calls.some(({ args }) => args[0] === "fetch"), false);
		assert.match(state.notifications.at(-1).message, /invalid head branch/);
	});
}

test("PR checkout still refuses a fetched head SHA mismatch", async (t) => {
	const { calls, state } = await prRefreshHarness(t, { fetchedHead: "cccc" });
	assert.equal(calls.filter(({ args }) => args[0] === "fetch").length, 1);
	assert.equal(calls.some(({ args }) => args[0] === "worktree"), false);
	assert.equal(state.confirmations.length, 0);
	assert.match(state.notifications.at(-1).message, /does not match GitHub's reported head/);
});

for (const base of ["main", "release/1.x"]) {
	test(`PR checkout refreshes real origin/${base} without changing local target branches or the original checkout`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "pi-worktree-pr-real-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const upstream = join(root, "upstream");
		const repo = join(root, "repo");
		await mkdir(upstream);
		async function git(cwd, args) {
			const result = await execute("git", args, { cwd });
			assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
			return result.stdout.trim();
		}
		for (const args of [
			["init", "-b", "main"],
			["config", "user.name", "Test User"],
			["config", "user.email", "test@example.com"],
			["config", "commit.gpgsign", "false"],
			["config", "core.hooksPath", join(root, "disabled-hooks")],
		]) await git(upstream, args);
		await writeFile(join(upstream, "README.md"), "initial\n");
		await git(upstream, ["add", "README.md"]);
		await git(upstream, ["commit", "-m", "initial"]);
		await git(upstream, ["branch", "release/1.x"]);
		await git(root, ["clone", upstream, repo]);
		await git(repo, ["config", "commit.gpgsign", "false"]);
		await git(repo, ["config", "core.hooksPath", join(root, "disabled-hooks")]);
		await git(repo, ["branch", "--no-track", "release/1.x", "origin/release/1.x"]);
		const originalMain = await git(repo, ["rev-parse", "refs/heads/main"]);
		const originalRelease = await git(repo, ["rev-parse", "refs/heads/release/1.x"]);
		const originalHead = await git(repo, ["rev-parse", "HEAD"]);
		const staleBase = await git(repo, ["rev-parse", `refs/remotes/origin/${base}`]);

		await git(upstream, ["switch", "-c", "feature/a"]);
		await writeFile(join(upstream, "feature.txt"), "PR head\n");
		await git(upstream, ["add", "feature.txt"]);
		await git(upstream, ["commit", "-m", "PR change"]);
		const head = await git(upstream, ["rev-parse", "HEAD"]);
		await git(upstream, ["update-ref", "refs/pull/42/head", head]);
		await git(upstream, ["switch", base]);
		await writeFile(join(upstream, "README.md"), "advanced review base\n");
		await git(upstream, ["add", "README.md"]);
		await git(upstream, ["commit", "-m", "advance target"]);
		const freshBase = await git(upstream, ["rev-parse", "HEAD"]);
		assert.notEqual(staleBase, freshBase);

		await writeFile(join(repo, "README.md"), "keep my staged work\n");
		await git(repo, ["add", "README.md"]);
		await writeFile(join(repo, "README.md"), "keep my unstaged work too\n");
		await writeFile(join(repo, "untracked.txt"), "keep my untracked file\n");
		async function checkoutState() {
			return {
				head: await git(repo, ["rev-parse", "HEAD"]),
				branch: await git(repo, ["symbolic-ref", "HEAD"]),
				status: await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]),
				index: await git(repo, ["diff", "--cached"]),
				working: await git(repo, ["diff"]),
				untracked: await git(repo, ["hash-object", "untracked.txt"]),
			};
		}
		const before = await checkoutState();
		const command = loadCommand(async (program, args, options = {}) => {
			if (program === "gh") {
				assert.deepEqual(args.slice(-2), ["--repo", upstream]);
				assert.ok(args[args.indexOf("--json") + 1].split(",").includes("baseRefName"));
				return { code: 0, stdout: JSON.stringify({ headRefName: "feature/a", headRefOid: head, baseRefName: base }) };
			}
			if (program === "bash") return { code: 1, stdout: "" };
			return execute(program, args, { cwd: options.cwd ?? repo });
		}, "wt");
		const state = context({ cwd: repo });
		state.ctx.ui.confirm = async (title, message) => {
			state.confirmations.push({ title, message });
			return false;
		};
		await command.handler("pr 42", state.ctx);
		assert.equal(await git(repo, ["rev-parse", `refs/remotes/origin/${base}`]), freshBase);
		assert.equal(await git(repo, ["rev-parse", "refs/heads/main"]), originalMain);
		assert.equal(await git(repo, ["rev-parse", "refs/heads/release/1.x"]), originalRelease);
		assert.equal(await git(repo, ["rev-parse", "HEAD"]), originalHead);
		assert.deepEqual(await checkoutState(), before);
		const created = parseWorktrees(await git(repo, ["worktree", "list", "--porcelain"])).find((wt) => wt.branch === "feature/a");
		assert.ok(created, JSON.stringify(state.notifications));
		assert.equal(created.head, head);
		assert.equal(state.confirmations.length, 1);
	});
}
