import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("refuses creation before changing Git when the session is not persisted", async () => {
	const calls = [];
	const command = loadCommand(async (_program, args) => {
		calls.push(args);
		return repoPrelude(args) ?? { code: 0, stdout: "", stderr: "" };
	}, "wt");
	const state = context({
		sessionManager: {
			getSessionFile: () => undefined,
			getEntries: () => [],
			getLeafId: () => null,
			getSessionDir: () => "/sessions",
		},
	});
	await command.handler("new feature/no-session", state.ctx);
	assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "add"), false);
	assert.match(state.notifications.at(-1).message, /persisted session/);
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
		const child = spawn(program, args, options);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

test("creates and safely removes a real temporary worktree while retaining its branch", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-worktree-test-"));
	const repo = join(root, "repo");
	await mkdir(repo);
	try {
		for (const args of [
			["init", "-b", "main"],
			["config", "user.name", "Test User"],
			["config", "user.email", "test@example.com"],
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
		throw new Error(`unexpected call: ${args.join(" ")}`);
	});
	const state = context({ cwd: repo });
	state.ctx.ui.confirm = async () => false;

	await command.handler("new feature/new", state.ctx);

	const add = calls.find((args) => args[0] === "worktree" && args[1] === "add");
	assert.deepEqual(add, ["worktree", "add", "-b", "feature/new", target, "main"]);
	await assert.doesNotReject(() => access(targetParent));
});

test("PR checkout creates a branch from the verified fetched ref", async (t) => {
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
				stdout: JSON.stringify({ headRefName: "feature/a", headRefOid: "bbbb", number: 42, title: "Feature" }),
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
		throw new Error(`unexpected call: ${program} ${args.join(" ")}`);
	});
	const state = context({ cwd: repo });
	state.ctx.ui.confirm = async (title, message) => {
		state.confirmations.push({ title, message });
		return false;
	};

	await command.handler("pr 42", state.ctx);

	const ghView = calls.find(({ program }) => program === "gh");
	assert.deepEqual(ghView.args.slice(-2), ["--repo", "git@github.com:owner/repo.git"]);
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
				stdout: JSON.stringify({ headRefName: "feature/a", headRefOid: "bbbb", number: 42, title: "Feature" }),
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
