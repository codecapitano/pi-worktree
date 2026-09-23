import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import extension, {
	branchSlug,
	findWorktree,
	findWorktreeExact,
	parseWorktrees,
} from "../extensions/git-worktree.ts";

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

test("exact lookup does not confuse branches with the same slug", () => {
	assert.equal(branchSlug("feature/a"), branchSlug("feature-a"));
	assert.equal(findWorktreeExact(worktrees, "feature/a")?.path, "/repo-feature-a");
	assert.equal(findWorktreeExact(worktrees, "feature-a")?.path, "/repo-feature-a-2");
	assert.equal(findWorktree(worktrees, "FEATURE-A"), undefined);
});

function loadCommand(exec) {
	let command;
	extension({
		exec,
		registerCommand(_name, value) {
			command = value;
		},
	});
	assert.ok(command);
	return command;
}

function context(overrides = {}) {
	const notifications = [];
	const confirmations = [];
	return {
		notifications,
		confirmations,
		ctx: {
			hasUI: true,
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
		const state = context();
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

test("no-origin repository ignores stale origin base refs", async () => {
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

test("PR checkout creates a branch from the verified fetched ref", async () => {
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
		if (program === "bash") return { code: 1, stdout: "", stderr: "clipboard unavailable" };
		if (args[0] === "check-ref-format") return { code: 0, stdout: "feature/a", stderr: "" };
		if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "rev-parse" && args[2] === "refs/pi-worktree/pr/42") {
			return { code: 0, stdout: "bbbb", stderr: "" };
		}
		if (args[0] === "worktree" && args[1] === "list") {
			return { code: 0, stdout: `worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n`, stderr: "" };
		}
		if (args[0] === "rev-parse" && args[2] === "refs/heads/feature/a") {
			return { code: 1, stdout: "", stderr: "unknown revision" };
		}
		if (args[0] === "worktree" && args[1] === "add") {
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error(`unexpected call: ${program} ${args.join(" ")}`);
	});
	const state = context();

	await command.handler("pr 42", state.ctx);

	const ghView = calls.find(({ program }) => program === "gh");
	assert.deepEqual(ghView.args.slice(-2), ["--repo", "git@github.com:owner/repo.git"]);
	const add = calls.find(({ args }) => args[0] === "worktree" && args[1] === "add");
	assert.deepEqual(add.args, [
		"worktree",
		"add",
		"-b",
		"feature/a",
		"/repo-feature-a",
		"refs/pi-worktree/pr/42",
	]);
	assert.match(state.notifications.at(-1).message, /PR #42 Feature/);
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
