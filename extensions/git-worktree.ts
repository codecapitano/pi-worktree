/**
 * Git Worktree Extension
 *
 * Canonical command: /wt. /worktree is the long alias.
 * Pick or switch worktrees, create branch and PR worktrees, show paths,
 * list and safely remove checkouts, and configure the picker shortcut.
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
import { access, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getConfigPath, readConfigSync, saveShortcut, validateShortcut } from "../lib/config.ts";
import { continueConversationInWorktree, preflightConversationSwitch } from "../lib/session-switch.ts";
import { showWorktreePicker } from "../lib/worktree-picker.ts";

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
	const inside = await run(pi, ["rev-parse", "--is-inside-work-tree"], ctx.cwd);
	if (inside.code !== 0 || inside.stdout !== "true") {
		ctx.ui.notify("Not inside a git repository", "error");
		return null;
	}
	const top = await run(pi, ["rev-parse", "--show-toplevel"], ctx.cwd);
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

	const delimiter = porcelain.includes("\0") ? "\0" : "\n";
	for (const line of porcelain.split(delimiter)) {
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
	const result = await run(pi, ["worktree", "list", "--porcelain", "-z"], cwd);
	if (result.code !== 0) {
		throw new Error(`Could not list Git worktrees. pi-worktree requires Git 2.36 or newer.\n${result.stderr || result.stdout}`);
	}
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

async function detectDefaultBranch(
	pi: ExtensionAPI,
	cwd: string,
	hasOrigin: boolean,
): Promise<string> {
	if (hasOrigin) {
		const remoteHead = await run(
			pi,
			["symbolic-ref", "refs/remotes/origin/HEAD"],
			cwd,
		);
		if (remoteHead.code === 0 && remoteHead.stdout) {
			const match = remoteHead.stdout.match(/refs\/remotes\/origin\/(.+)$/);
			if (match?.[1]) return match[1];
		}
	}
	for (const candidate of ["main", "master"]) {
		const local = await run(
			pi,
			["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
			cwd,
		);
		if (local.code === 0) return candidate;
		if (hasOrigin) {
			const remote = await run(
				pi,
				["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
				cwd,
			);
			if (remote.code === 0) return candidate;
		}
	}
	return "main";
}

function mainWorktreePath(worktrees: Worktree[]): string {
	// First entry from `git worktree list` is the main worktree.
	return worktrees[0]?.path ?? "";
}

async function resolveWorktreePath(mainPath: string, branch: string): Promise<string> {
	const repo = basename(mainPath);
	const parent = dirname(mainPath);
	const workspaceWorktrees = join(parent, "worktrees");
	try {
		if ((await stat(workspaceWorktrees)).isDirectory()) {
			return join(workspaceWorktrees, repo, branchSlug(branch));
		}
	} catch {
		// No workspace worktrees directory: retain the sibling layout.
	}
	return join(parent, `${repo}-${branchSlug(branch)}`);
}

async function ensureWorktreeParent(ctx: ExtensionCommandContext, path: string): Promise<boolean> {
	try {
		await mkdir(dirname(path), { recursive: true });
		return true;
	} catch (error) {
		ctx.ui.notify(`Could not create worktree directory:\n${(error as Error).message}`, "error");
		return false;
	}
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

async function getOriginUrl(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string | null> {
	const result = await run(pi, ["remote", "get-url", "origin"], cwd);
	return result.code === 0 && result.stdout ? result.stdout : null;
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
): Promise<Worktree | undefined> {
	if (!(await isValidBranch(pi, cwd, branch))) {
		ctx.ui.notify(`Invalid branch name: ${branch}`, "error");
		return;
	}

	const worktrees = await listWorktrees(pi, cwd);
	const mainPath = mainWorktreePath(worktrees) || cwd;

	const existing = findWorktreeExact(worktrees, branch);
	if (existing) {
		ctx.ui.notify(`Using existing worktree\n${existing.branch ?? "detached"}  →  ${existing.path}`, "info");
		return existing;
	}

	const path = await resolveWorktreePath(mainPath, branch);
	const pathTaken = worktrees.find((w) => w.path === path);
	if (pathTaken) {
		ctx.ui.notify(
			`Path already used by another worktree:\n${path}\n(${pathTaken.branch ?? "detached"})`,
			"error",
		);
		return;
	}
	if (!(await ensureWorktreeParent(ctx, path))) return;

	const localRef = `refs/heads/${branch}`;
	const remoteRef = `refs/remotes/origin/${branch}`;
	const hasLocal = await refExists(pi, cwd, localRef);
	let hasRemote = await refExists(pi, cwd, remoteRef);
	const originUrl = await getOriginUrl(pi, cwd);

	if (!hasLocal) {
		if (!originUrl) {
			hasRemote = false;
		} else {
			const remoteCheck = await run(
				pi,
				["ls-remote", "--exit-code", "--heads", "origin", branch],
				cwd,
			);
			if (remoteCheck.code === 0) {
				const fetched = await run(
					pi,
					["fetch", "origin", `+refs/heads/${branch}:${remoteRef}`],
					cwd,
				);
				if (fetched.code !== 0) {
					ctx.ui.notify(
						`Could not fetch origin/${branch}:\n${fetched.stderr || fetched.stdout}`,
						"error",
					);
					return;
				}
				hasRemote = true;
			} else if (remoteCheck.code === 2) {
				hasRemote = false;
			} else {
				ctx.ui.notify(
					`Could not check origin for ${branch}:\n${remoteCheck.stderr || remoteCheck.stdout}`,
					"error",
				);
				return;
			}
		}
	}

	let add: ExecResult;
	if (hasLocal) {
		// Reuse existing local branch.
		add = await run(pi, ["worktree", "add", path, branch], cwd);
	} else if (hasRemote) {
		// Create local branch tracking origin/<branch>.
		add = await run(
			pi,
			["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`],
			cwd,
		);
	} else {
		// Brand-new branch off base (default: origin/main or main).
		const baseBranch = base ?? (await detectDefaultBranch(pi, cwd, originUrl !== null));
		// Prefer origin/<base> only when the origin remote still exists.
		const originBase = `origin/${baseBranch}`;
		const hasRemoteBase =
			originUrl !== null &&
			(await refExists(pi, cwd, `refs/remotes/${originBase}`));
		const startPoint = hasRemoteBase
			? originBase
			: (await refExists(pi, cwd, `refs/heads/${baseBranch}`))
				? baseBranch
				: baseBranch;

		// Make sure base is fresh when it's a remote ref.
		if (startPoint.startsWith("origin/")) {
			const fetchedBase = await run(
				pi,
				["fetch", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
				cwd,
			);
			if (fetchedBase.code !== 0) {
				ctx.ui.notify(
					`Could not refresh ${startPoint}:\n${fetchedBase.stderr || fetchedBase.stdout}`,
					"error",
				);
				return;
			}
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

	ctx.ui.notify(`Created ${branch}\n→ ${path}`, "info");
	return findWorktreeExact(await listWorktrees(pi, cwd), branch);
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
			`No worktree matching "${query}"\nTry /wt ls`,
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
		ctx.ui.notify(`No exact worktree matching "${query}". Use /wt ls to copy the exact branch or path.`, "error");
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

async function createFromPr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	prNumber: string,
): Promise<Worktree | undefined> {
	if (!/^\d+$/.test(prNumber)) {
		ctx.ui.notify(`Usage: /wt pr <number>\nGot: ${prNumber}`, "error");
		return;
	}

	const originUrl = await getOriginUrl(pi, cwd);
	if (!originUrl) {
		ctx.ui.notify("The repository has no origin remote", "error");
		return;
	}

	// Resolve PR metadata against the same origin from which Git fetches the PR ref.
	const view = await pi.exec(
		"gh",
		[
			"pr",
			"view",
			prNumber,
			"--json",
			"headRefName,headRefOid,number,title",
			"--repo",
			originUrl,
		],
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
		headRefOid?: string;
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
	if (!branch || !data.headRefOid) {
		ctx.ui.notify(`PR #${prNumber} has no resolvable head branch`, "error");
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
	if (!fetchedHead || fetchedHead !== data.headRefOid) {
		ctx.ui.notify(
			`Fetched head for PR #${prNumber} does not match GitHub's reported head`,
			"error",
		);
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
		ctx.ui.notify(`Using existing PR worktree\n${branch}  →  ${existing.path}`, "info");
		return existing;
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

	const path = await resolveWorktreePath(mainPath, branch);
	if (worktrees.some((wt) => wt.path === path)) {
		ctx.ui.notify(`Worktree path is already in use:\n${path}`, "error");
		return;
	}
	if (!(await ensureWorktreeParent(ctx, path))) return;

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

	ctx.ui.notify(`PR #${prNumber} ${data.title ?? ""}\nCreated ${branch}\n→ ${path}`, "info");
	return findWorktreeExact(await listWorktrees(pi, cwd), branch);
}

let switchInProgress = false;

async function canonicalPath(path: string): Promise<string | null> {
	try { return await realpath(path); } catch { return null; }
}

function supportsSwitchMode(ctx: ExtensionCommandContext): boolean {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify("Worktree switching requires interactive Pi TUI mode", "error");
		return false;
	}
	return true;
}

function supportsSwitching(ctx: ExtensionCommandContext): boolean {
	if (!supportsSwitchMode(ctx)) return false;
	if (typeof ctx.switchSession !== "function") {
		ctx.ui.notify("This Pi version cannot replace sessions; upgrade to Pi 0.84.2 or newer", "error");
		return false;
	}
	return true;
}

async function canStartSwitch(ctx: ExtensionCommandContext): Promise<boolean> {
	return supportsSwitching(ctx) && preflightConversationSwitch(
		ctx as any,
		(path) => access(path).then(() => true, () => false),
	);
}

async function switchToWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	worktree: Worktree,
): Promise<void> {
	if (!supportsSwitching(ctx)) return;
	if (switchInProgress) {
		ctx.ui.notify("A worktree switch is already in progress", "warning");
		return;
	}
	if (worktree.bare || worktree.prunable) {
		ctx.ui.notify("This worktree is not available for switching", "error");
		return;
	}
	const target = await canonicalPath(worktree.path);
	if (!target) {
		ctx.ui.notify("The selected worktree no longer exists", "error");
		return;
	}

	switchInProgress = true;
	try {
		const current = await canonicalPath(ctx.cwd);
		if (current === target) {
			ctx.ui.notify("This worktree is already active", "info");
			return;
		}
		if (!(await ctx.ui.confirm("Continue in worktree?", `${target}\n\nWorktree code, AGENTS.md, CLAUDE.md, and trusted .pi resources may load. Review the target before continuing.`))) {
			ctx.ui.notify(`Worktree retained at ${target}`, "info");
			return;
		}
		const codingAgent = await import("@earendil-works/pi-coding-agent");
		await continueConversationInWorktree(ctx as any, target, {
			exists: async (path) => access(path).then(() => true, () => false),
			usesDefaultSessionDir: () => {
				const manager = ctx.sessionManager as any;
				return typeof manager.usesDefaultSessionDir === "function" && manager.usesDefaultSessionDir();
			},
			revalidate: async (expected) => {
				const listed = await listWorktrees(pi, repoRoot);
				for (const candidate of listed) {
					if (candidate.bare || candidate.prunable) continue;
					if (await canonicalPath(candidate.path) === expected) return true;
				}
				return false;
			},
			forkSession: async (source, targetCwd, sessionDir) => {
				const manager = codingAgent.SessionManager.forkFrom(source, targetCwd, sessionDir);
				const path = manager.getSessionFile();
				if (!path) throw new Error("Pi did not create a persisted target session");
				return { path };
			},
			removeSession: async (path) => unlink(path),
		});
	} finally {
		switchInProgress = false;
	}
}

function parseArgs(raw: string): { cmd: string; rest: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { cmd: "pick", rest: "" };
	const [first, ...restParts] = trimmed.split(/\s+/);
	const rest = restParts.join(" ").trim();
	const aliases: Record<string, string> = { list: "ls", remove: "rm", path: "open", new: "add" };
	const sub = aliases[first.toLowerCase()] ?? first.toLowerCase();
	if (["pick", "ls", "add", "switch", "open", "rm", "pr", "config", "help"].includes(sub)) {
		return { cmd: sub, rest };
	}
	return { cmd: "bare", rest: trimmed };
}

async function listOnly(pi: ExtensionAPI, ctx: ExtensionCommandContext, cwd: string): Promise<void> {
	const worktrees = await listWorktrees(pi, cwd);
	const mainPath = mainWorktreePath(worktrees);
	ctx.ui.notify(worktrees.length ? worktrees.map((wt) => formatWt(wt, mainPath)).join("\n") : "No worktrees found", "info");
}

async function completionItems(pi: ExtensionAPI, cwd: string, prefix: string) {
	const trimmed = prefix.trimStart();
	const [command, ...rest] = trimmed.split(/\s+/);
	const subs = ["switch", "new", "add", "pr", "open", "path", "ls", "rm", "config", "help"];
	if (!trimmed.includes(" ")) {
		return subs.filter((item) => item.startsWith(command)).map((item) => ({ value: item, label: item }));
	}
	const query = rest.join(" ").toLowerCase();
	if (["switch", "open", "path", "rm"].includes(command)) {
		let worktrees: Worktree[];
		try { worktrees = await listWorktrees(pi, cwd); } catch { return null; }
		return worktrees
			.filter((wt) => !wt.bare && !wt.prunable)
			.flatMap((wt) => [wt.branch, wt.path].filter((value): value is string => Boolean(value)))
			.filter((value) => value.toLowerCase().includes(query))
			.map((value) => ({ value: `${command} ${value}`, label: value }));
	}
	if (["new", "add"].includes(command)) {
		const refs = await run(pi, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd);
		return refs.code === 0 ? refs.stdout.split("\n").filter((value) => value.toLowerCase().includes(query)).map((value) => ({ value: `${command} ${value}`, label: value })) : null;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	let activeCwd = process.cwd();
	const config = readConfigSync();
	pi.on?.("session_start", (_event, ctx) => {
		activeCwd = ctx.cwd;
		if (config.diagnostic) ctx.ui.notify(config.diagnostic, "warning");
	});

	const handleCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const parsed = parseArgs(args);
		if (parsed.cmd === "config") {
			const [setting, value] = parsed.rest.split(/\s+/, 2);
			if (!setting) {
				ctx.ui.notify(`Shortcut: ${config.shortcut ?? "off"}\nConfig: ${getConfigPath()}`, "info");
				return;
			}
			if (setting === "shortcut" && !value) {
				ctx.ui.notify(`Shortcut: ${config.shortcut ?? "off"}\nConfig: ${getConfigPath()}`, "info");
				return;
			}
			if (setting !== "shortcut" || !value) {
				ctx.ui.notify("Usage: /wt config shortcut <key|off>", "error");
				return;
			}
			const shortcut = value.toLowerCase() === "off" ? null : value;
			if (shortcut !== null && !validateShortcut(shortcut).valid) {
				ctx.ui.notify(validateShortcut(shortcut).diagnostic ?? "Invalid shortcut", "error");
				return;
			}
			const saved = await saveShortcut(shortcut);
			if (!saved.ok) {
				ctx.ui.notify(saved.diagnostic ?? "Could not save shortcut", "error");
				return;
			}
			ctx.ui.notify(`Shortcut saved as ${shortcut ?? "off"}; reloading Pi resources`, "info");
			await ctx.reload();
			return;
		}

		const cwd = await ensureRepo(pi, ctx);
		if (!cwd) return;
		const { cmd, rest } = parsed;
		if (cmd === "help") {
			ctx.ui.notify([
				"/wt                         pick and switch worktree",
				"/wt switch <branch>         switch exactly",
				"/wt <branch-or-path>        switch, or confirm creation",
				"/wt new|add <branch>        create and switch",
				"/wt pr <number>             create PR worktree; confirm switch",
				"/wt open|path <branch>      show/copy path",
				"/wt ls                      list",
				"/wt rm <branch>             remove clean worktree",
				"/wt config shortcut <key>   configure shortcut (or off)",
				"/worktree                   long alias for /wt",
			].join("\n"), "info");
			return;
		}
		if (cmd === "ls") return listOnly(pi, ctx, cwd);
		if (cmd === "open") {
			if (!rest) return ctx.ui.notify("Usage: /wt open <branch>", "error");
			return openWorktree(pi, ctx, cwd, rest);
		}
		if (cmd === "rm") {
			if (!rest) return ctx.ui.notify("Usage: /wt rm <branch>", "error");
			return removeWorktree(pi, ctx, cwd, rest);
		}
		if (cmd === "pick") {
			if (!(await canStartSwitch(ctx))) return;
			const worktrees = await listWorktrees(pi, cwd);
			const mainPath = worktrees[0] ? await canonicalPath(worktrees[0].path) : null;
			const available: Worktree[] = [];
			for (const wt of worktrees) {
				if (wt.bare || wt.prunable) continue;
				const path = await canonicalPath(wt.path);
				if (path) available.push({ ...wt, path });
			}
			const selected = await showWorktreePicker(ctx as any, available, await canonicalPath(ctx.cwd) ?? ctx.cwd, mainPath ?? undefined);
			if (selected) await switchToWorktree(pi, ctx, cwd, selected as Worktree);
			return;
		}
		if (cmd === "switch") {
			if (!rest) return ctx.ui.notify("Usage: /wt switch <branch-or-path>", "error");
			const wt = findWorktreeExact(await listWorktrees(pi, cwd), rest);
			if (!wt) return ctx.ui.notify(`No exact worktree matching "${rest}"`, "error");
			return switchToWorktree(pi, ctx, cwd, wt);
		}
		if (cmd === "add") {
			if (!rest) return ctx.ui.notify("Usage: /wt new <branch>", "error");
			if (!(await canStartSwitch(ctx))) return;
			const wt = await createWorktree(pi, ctx, cwd, rest);
			if (wt) await switchToWorktree(pi, ctx, cwd, wt);
			return;
		}
		if (cmd === "pr") {
			if (!rest) return ctx.ui.notify("Usage: /wt pr <number>", "error");
			if (!(await canStartSwitch(ctx))) return;
			const wt = await createFromPr(pi, ctx, cwd, rest);
			if (wt) await switchToWorktree(pi, ctx, cwd, wt);
			return;
		}
		if (cmd === "bare") {
			if (!(await canStartSwitch(ctx))) return;
			const existing = findWorktreeExact(await listWorktrees(pi, cwd), rest);
			if (existing) return switchToWorktree(pi, ctx, cwd, existing);
			if (!ctx.hasUI || !(await ctx.ui.confirm("Create worktree?", `Create ${rest} and continue this conversation there?`))) return;
			const wt = await createWorktree(pi, ctx, cwd, rest);
			if (wt) await switchToWorktree(pi, ctx, cwd, wt);
		}
	};

	const command = {
		description: "Pick, create, switch, or manage Git worktrees",
		getArgumentCompletions: (prefix: string) => completionItems(pi, activeCwd, prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				await handleCommand(args, ctx);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		},
	};
	pi.registerCommand("wt", command);
	pi.registerCommand("worktree", command);

	if (config.shortcut) {
		pi.registerShortcut(config.shortcut as any, {
			description: "Open worktree picker",
			handler: (ctx) => {
				if (ctx.mode !== "tui" || !ctx.isIdle() || ctx.hasPendingMessages()) {
					ctx.ui.notify("Wait for Pi to become idle before switching worktrees", "warning");
					return;
				}
				const ownCommands = pi.getCommands().filter((item) =>
					item.source === "extension" && item.sourceInfo.path?.endsWith("git-worktree.ts"));
				const own = ownCommands.find((item) => /^wt(?::\d+)?$/.test(item.name))
					?? ownCommands.find((item) => /^worktree(?::\d+)?$/.test(item.name));
				const invocation = own ? `/${own.name}` : null;
				if (!invocation) {
					ctx.ui.notify("Worktree command name conflicts with another extension", "error");
					return;
				}
				if (typeof pi.sendUserMessage !== "function") {
					ctx.ui.notify("This Pi version cannot dispatch commands from shortcuts; upgrade to Pi 0.84.2 or newer", "error");
					return;
				}
				pi.sendUserMessage(invocation, { expandPromptTemplates: true });
			},
		});
	}
}
