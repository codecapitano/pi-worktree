/**
 * Git Worktree Extension
 *
 * Slash commands:
 *   /worktree                      list worktrees (interactive pick)
 *   /worktree ls                   list worktrees
 *   /worktree <branch>             create worktree for branch
 *   /worktree add <branch>         same as above
 *   /worktree open <branch>        show path (+ copy to clipboard on macOS)
 *   /worktree rm <branch>          remove worktree (confirms first)
 *   /worktree pr <number>          fetch PR branch via gh, create worktree
 *
 * Layout:
 *   ~/AGI/mobile/                  ← main checkout
 *   ~/AGI/mobile-fix-login/        ← worktree for fix/login
 *
 * Safety:
 * - must be inside a git repo
 * - never force-push / hard-reset / clean -fdx
 * - rm requires an interactive confirmation
 * - dirty worktrees are never force-removed
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";

type ExecResult = { code: number; stdout: string; stderr: string };

export type Worktree = {
	path: string;
	head: string;
	branch: string | null; // null = detached
	bare: boolean;
	locked: boolean;
	prunable: boolean;
};

async function run(
	pi: ExtensionAPI,
	args: string[],
	cwd?: string,
): Promise<ExecResult> {
	const result = await pi.exec("git", args, cwd ? { cwd } : undefined);
	return {
		code: result.code ?? 1,
		stdout: (result.stdout ?? "").trim(),
		stderr: (result.stderr ?? "").trim(),
	};
}

async function ensureRepo(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<string | null> {
	const inside = await run(pi, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout !== "true") {
		ctx.ui.notify("Not inside a git repository", "error");
		return null;
	}
	const top = await run(pi, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0 || !top.stdout) {
		ctx.ui.notify("Could not resolve repo root", "error");
		return null;
	}
	return top.stdout;
}

export function parseWorktrees(porcelain: string): Worktree[] {
	const items: Worktree[] = [];
	let current: Partial<Worktree> | null = null;

	const push = () => {
		if (current?.path) {
			items.push({
				path: current.path,
				head: current.head ?? "",
				branch: current.branch ?? null,
				bare: current.bare ?? false,
				locked: current.locked ?? false,
				prunable: current.prunable ?? false,
			});
		}
		current = null;
	};

	for (const line of porcelain.split("\n")) {
		if (line.length === 0) {
			push();
			continue;
		}
		if (line.startsWith("worktree ")) {
			push();
			current = { path: line.slice("worktree ".length) };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
		else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length);
			current.branch = ref.startsWith("refs/heads/")
				? ref.slice("refs/heads/".length)
				: ref;
		} else if (line === "detached") current.branch = null;
		else if (line === "bare") current.bare = true;
		else if (line.startsWith("locked")) current.locked = true;
		else if (line.startsWith("prunable")) current.prunable = true;
	}
	push();
	return items;
}

async function listWorktrees(pi: ExtensionAPI, cwd: string): Promise<Worktree[]> {
	const result = await run(pi, ["worktree", "list", "--porcelain"], cwd);
	if (result.code !== 0) return [];
	return parseWorktrees(result.stdout);
}

export function branchSlug(branch: string): string {
	return branch
		.replace(/^refs\/heads\//, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

function shortHead(head: string): string {
	return head.length > 8 ? head.slice(0, 8) : head;
}

function formatWt(wt: Worktree, mainPath: string): string {
	const isMain = wt.path === mainPath;
	const name = wt.branch ?? `(detached ${shortHead(wt.head)})`;
	const tags = [
		isMain ? "main" : null,
		wt.locked ? "locked" : null,
		wt.prunable ? "prunable" : null,
		wt.bare ? "bare" : null,
	]
		.filter(Boolean)
		.join(", ");
	return tags ? `${name}  →  ${wt.path}  (${tags})` : `${name}  →  ${wt.path}`;
}

async function detectDefaultBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const remoteHead = await run(
		pi,
		["symbolic-ref", "refs/remotes/origin/HEAD"],
		cwd,
	);
	if (remoteHead.code === 0 && remoteHead.stdout) {
		const match = remoteHead.stdout.match(/refs\/remotes\/origin\/(.+)$/);
		if (match?.[1]) return match[1];
	}
	for (const candidate of ["main", "master"]) {
		const local = await run(
			pi,
			["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
			cwd,
		);
		if (local.code === 0) return candidate;
		const remote = await run(
			pi,
			["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
			cwd,
		);
		if (remote.code === 0) return candidate;
	}
	return "main";
}

function mainWorktreePath(worktrees: Worktree[]): string {
	// First entry from `git worktree list` is the main worktree.
	return worktrees[0]?.path ?? "";
}

function resolveWorktreePath(mainPath: string, branch: string): string {
	const repo = basename(mainPath);
	const parent = dirname(mainPath);
	return join(parent, `${repo}-${branchSlug(branch)}`);
}

export function findWorktreeExact(
	worktrees: Worktree[],
	query: string,
): Worktree | undefined {
	const q = query.trim();
	if (!q) return undefined;
	return worktrees.find((w) => w.path === q || w.branch === q);
}

export function findWorktree(
	worktrees: Worktree[],
	query: string,
): Worktree | undefined {
	const q = query.trim();
	if (!q) return undefined;
	const exact = findWorktreeExact(worktrees, q);
	if (exact) return exact;

	const slug = branchSlug(q);
	const fuzzy = worktrees.filter(
		(w) =>
			(w.branch !== null && branchSlug(w.branch) === slug) ||
			w.path.endsWith(`/${q}`) ||
			w.path.endsWith(`-${slug}`),
	);
	return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

async function copyToClipboard(pi: ExtensionAPI, text: string): Promise<boolean> {
	// macOS pbcopy via bash; quiet-fail on Linux/etc.
	const piped = await pi
		.exec("bash", ["-c", 'printf %s "$1" | pbcopy', "--", text])
		.catch(() => null);
	return !!piped && (piped.code ?? 1) === 0;
}

async function refExists(
	pi: ExtensionAPI,
	cwd: string,
	ref: string,
): Promise<boolean> {
	const r = await run(pi, ["show-ref", "--verify", "--quiet", ref], cwd);
	return r.code === 0;
}

async function resolveRef(
	pi: ExtensionAPI,
	cwd: string,
	ref: string,
): Promise<string | null> {
	const result = await run(pi, ["rev-parse", "--verify", ref], cwd);
	return result.code === 0 && result.stdout ? result.stdout : null;
}

async function isValidBranch(
	pi: ExtensionAPI,
	cwd: string,
	branch: string,
): Promise<boolean> {
	const result = await run(pi, ["check-ref-format", "--branch", branch], cwd);
	return result.code === 0;
}

async function createWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	branch: string,
	base?: string,
): Promise<void> {
	if (!(await isValidBranch(pi, cwd, branch))) {
		ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
		return;
	}

	const worktrees = await listWorktrees(pi, cwd);
	const mainPath = mainWorktreePath(worktrees) || cwd;

	const existing = findWorktreeExact(worktrees, branch);
	if (existing) {
		const copied = await copyToClipboard(pi, existing.path);
		ctx.ui.notify(
			`Already exists\n${existing.branch ?? "detached"}  →  ${existing.path}${copied ? "\n(path copied)" : ""}\n\nNext: cd ${existing.path} && pi`,
			"info",
		);
		return;
	}

	const path = resolveWorktreePath(mainPath, branch);
	const pathTaken = worktrees.find((w) => w.path === path);
	if (pathTaken) {
		ctx.ui.notify(
			`Path already used by another worktree:\n${path}\n(${pathTaken.branch ?? "detached"})`,
			"error",
		);
		return;
	}

	const localRef = `refs/heads/${branch}`;
	const remoteRef = `refs/remotes/origin/${branch}`;
	const hasLocal = await refExists(pi, cwd, localRef);
	const hasRemote = await refExists(pi, cwd, remoteRef);

	// Refresh remote tip when we might need it.
	if (!hasLocal) {
		await run(pi, ["fetch", "origin", branch], cwd);
	}

	const hasLocalAfter = hasLocal || (await refExists(pi, cwd, localRef));
	const hasRemoteAfter = hasRemote || (await refExists(pi, cwd, remoteRef));

	let add: ExecResult;
	if (hasLocalAfter) {
		// Reuse existing local branch.
		add = await run(pi, ["worktree", "add", path, branch], cwd);
	} else if (hasRemoteAfter) {
		// Create local branch tracking origin/<branch>.
		add = await run(
			pi,
			["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`],
			cwd,
		);
	} else {
		// Brand-new branch off base (default: origin/main or main).
		const baseBranch = base ?? (await detectDefaultBranch(pi, cwd));
		// Prefer origin/<base> when available.
		const originBase = `origin/${baseBranch}`;
		const startPoint = (await refExists(
			pi,
			cwd,
			`refs/remotes/${originBase}`,
		))
			? originBase
			: (await refExists(pi, cwd, `refs/heads/${baseBranch}`))
				? baseBranch
				: baseBranch;

		// Make sure base is fresh when it's a remote ref.
		if (startPoint.startsWith("origin/")) {
			await run(pi, ["fetch", "origin", baseBranch], cwd);
		}

		add = await run(
			pi,
			["worktree", "add", "-b", branch, path, startPoint],
			cwd,
		);
	}

	if (add.code !== 0) {
		ctx.ui.notify(
			`worktree add failed:\n${add.stderr || add.stdout}`,
			"error",
		);
		return;
	}

	const copied = await copyToClipboard(pi, path);
	ctx.ui.notify(
		`Created ${branch}\n→ ${path}${copied ? "\n(path copied)" : ""}\n\nNext: cd ${path} && pi`,
		"info",
	);
}

async function openWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	query: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	const wt = findWorktree(worktrees, query);
	if (!wt) {
		ctx.ui.notify(
			`No worktree matching "${query}"\nTry /worktree ls`,
			"error",
		);
		return;
	}
	const copied = await copyToClipboard(pi, wt.path);
	ctx.ui.notify(
		`${wt.branch ?? "detached"}  →  ${wt.path}${copied ? "\n(path copied)" : ""}\n\nNext: cd ${wt.path} && pi`,
		"info",
	);
}

async function removeWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	query: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	const mainPath = mainWorktreePath(worktrees);
	const wt = findWorktreeExact(worktrees, query);

	if (!wt) {
		ctx.ui.notify(`No exact worktree matching "${query}". Use /worktree ls to copy the exact branch or path.`, "error");
		return;
	}
	if (wt.path === mainPath) {
		ctx.ui.notify("Refusing to remove the main worktree", "error");
		return;
	}
	if (wt.locked) {
		ctx.ui.notify(`Worktree is locked:\n${wt.path}`, "error");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("Removing a worktree requires interactive confirmation", "error");
		return;
	}

	const ok = await ctx.ui.confirm(
		"Remove worktree?",
		`${wt.branch ?? "detached"}\n${wt.path}\n\nBranch is kept. Only a clean worktree can be removed.`,
	);
	if (!ok) {
		ctx.ui.notify("Aborted", "warning");
		return;
	}

	const rm = await run(pi, ["worktree", "remove", wt.path], cwd);
	if (rm.code !== 0) {
		ctx.ui.notify(
			`worktree remove refused; the worktree was left intact:\n${rm.stderr || rm.stdout}`,
			"error",
		);
		return;
	}

	ctx.ui.notify(
		`Removed worktree\n${wt.branch ?? "detached"}  →  ${wt.path}\n(branch kept)`,
		"info",
	);
}

async function listAndMaybeOpen(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	if (worktrees.length === 0) {
		ctx.ui.notify("No worktrees found", "info");
		return;
	}
	const mainPath = mainWorktreePath(worktrees);
	const lines = worktrees.map((w) => formatWt(w, mainPath));

	if (!ctx.hasUI) {
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	const choice = await ctx.ui.select("Worktrees (select to copy path)", lines);
	if (!choice) return;
	const picked = worktrees.find((w) => formatWt(w, mainPath) === choice);
	if (!picked) return;

	const copied = await copyToClipboard(pi, picked.path);
	ctx.ui.notify(
		`${picked.branch ?? "detached"}  →  ${picked.path}${copied ? "\n(path copied)" : ""}\n\nNext: cd ${picked.path} && pi`,
		"info",
	);
}

async function createFromPr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	prNumber: string,
): Promise<void> {
	if (!/^\d+$/.test(prNumber)) {
		ctx.ui.notify(`Usage: /worktree pr <number>\nGot: ${prNumber}`, "error");
		return;
	}

	// gh pr checkout can move the current branch, so resolve and fetch the PR explicitly.
	const view = await pi.exec(
		"gh",
		["pr", "view", prNumber, "--json", "headRefName,number,title"],
		{ cwd },
	);

	if ((view.code ?? 1) !== 0) {
		ctx.ui.notify(
			`gh pr view ${prNumber} failed:\n${(view.stderr || view.stdout || "").trim()}\n\nIs GitHub CLI installed and authenticated?`,
			"error",
		);
		return;
	}

	let data: {
		headRefName?: string;
		number?: number;
		title?: string;
	};
	try {
		data = JSON.parse(view.stdout ?? "{}");
	} catch {
		ctx.ui.notify(`Could not parse gh output:\n${view.stdout}`, "error");
		return;
	}

	const branch = data.headRefName;
	if (!branch) {
		ctx.ui.notify(`PR #${prNumber} has no head branch`, "error");
		return;
	}

	if (!(await isValidBranch(pi, cwd, branch))) {
		ctx.ui.notify(`PR #${prNumber} has an invalid head branch: ${branch}`, "error");
		return;
	}

	const prRef = `refs/pi-worktree/pr/${prNumber}`;
	const fetchPr = await run(
		pi,
		["fetch", "origin", `+pull/${prNumber}/head:${prRef}`],
		cwd,
	);
	if (fetchPr.code !== 0) {
		ctx.ui.notify(
			`Could not fetch PR #${prNumber}:\n${fetchPr.stderr || fetchPr.stdout}`,
			"error",
		);
		return;
	}

	const fetchedHead = await resolveRef(pi, cwd, prRef);
	if (!fetchedHead) {
		ctx.ui.notify(`Could not resolve the fetched head for PR #${prNumber}`, "error");
		return;
	}

	const worktrees = await listWorktrees(pi, cwd);
	const mainPath = mainWorktreePath(worktrees) || cwd;
	const existing = findWorktreeExact(worktrees, branch);
	if (existing) {
		if (existing.head !== fetchedHead) {
			ctx.ui.notify(
				`Branch ${branch} is already checked out at a different commit. PR #${prNumber} was not opened.`,
				"error",
			);
			return;
		}
		await openWorktree(pi, ctx, cwd, branch);
		return;
	}

	const localRef = `refs/heads/${branch}`;
	const localHead = await resolveRef(pi, cwd, localRef);
	if (localHead && localHead !== fetchedHead) {
		ctx.ui.notify(
			`Local branch ${branch} does not match PR #${prNumber}. Rename or remove the local branch before retrying.`,
			"error",
		);
		return;
	}

	const path = resolveWorktreePath(mainPath, branch);
	if (worktrees.some((wt) => wt.path === path)) {
		ctx.ui.notify(`Worktree path is already in use:\n${path}`, "error");
		return;
	}

	const add = localHead
		? await run(pi, ["worktree", "add", path, branch], cwd)
		: await run(pi, ["worktree", "add", "-b", branch, path, prRef], cwd);
	if (add.code !== 0) {
		ctx.ui.notify(
			`worktree add failed:\n${add.stderr || add.stdout}`,
			"error",
		);
		return;
	}

	const copied = await copyToClipboard(pi, path);
	ctx.ui.notify(
		`PR #${prNumber} ${data.title ?? ""}\nCreated ${branch}\n→ ${path}${copied ? "\n(path copied)" : ""}\n\nNext: cd ${path} && pi`,
		"info",
	);
}

function parseArgs(raw: string): { cmd: string; rest: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { cmd: "ls", rest: "" };
	const [first, ...restParts] = trimmed.split(/\s+/);
	const rest = restParts.join(" ").trim();
	const sub = first.toLowerCase();
	if (["ls", "list", "add", "open", "rm", "remove", "pr", "help"].includes(sub)) {
		return { cmd: sub === "list" ? "ls" : sub === "remove" ? "rm" : sub, rest };
	}
	// Default: treat first token (and rest) as branch name for add.
	return { cmd: "add", rest: trimmed };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("worktree", {
		description:
			"Create, list, open, or remove git worktrees (/worktree, /worktree ls|add|open|rm|pr)",
		getArgumentCompletions: (prefix) => {
			const subs = ["ls", "add", "open", "rm", "pr", "help"];
			const p = prefix.trim();
			// Complete subcommands only for the first token.
			if (!p.includes(" ")) {
				const hits = subs.filter((s) => s.startsWith(p));
				return hits.map((s) => ({ value: s, label: s }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const cwd = await ensureRepo(pi, ctx);
			if (!cwd) return;

			const { cmd, rest } = parseArgs(args);

			switch (cmd) {
				case "help": {
					ctx.ui.notify(
						[
							"/worktree                 list + pick",
							"/worktree ls              list",
							"/worktree <branch>        create",
							"/worktree add <branch>    create",
							"/worktree open <branch>   show/copy path",
							"/worktree rm <branch>     remove (keeps branch)",
							"/worktree pr <number>     worktree from PR",
						].join("\n"),
						"info",
					);
					return;
				}
				case "ls": {
					await listAndMaybeOpen(pi, ctx, cwd);
					return;
				}
				case "add": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree add <branch>", "error");
						return;
					}
					const branch = rest.split(/\s+/)[0];
					await createWorktree(pi, ctx, cwd, branch);
					return;
				}
				case "open": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree open <branch>", "error");
						return;
					}
					await openWorktree(pi, ctx, cwd, rest.split(/\s+/)[0]);
					return;
				}
				case "rm": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree rm <branch>", "error");
						return;
					}
					await removeWorktree(pi, ctx, cwd, rest.split(/\s+/)[0]);
					return;
				}
				case "pr": {
					if (!rest) {
						ctx.ui.notify("Usage: /worktree pr <number>", "error");
						return;
					}
					await createFromPr(pi, ctx, cwd, rest.split(/\s+/)[0]);
					return;
				}
				default: {
					ctx.ui.notify(`Unknown /worktree command: ${cmd}`, "error");
				}
			}
		},
	});
}
