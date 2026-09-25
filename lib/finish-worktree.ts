import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { continueConversationInWorktree, preflightConversationSwitch } from "./session-switch.ts";

export async function sessionFileOutsideWorktree(sourcePath: string, file: string): Promise<boolean> {
	try {
		const [source, target] = await Promise.all([realpath(sourcePath), realpath(file)]);
		const rest = relative(source, target);
		return rest === ".." || rest.startsWith(`..${sep}`);
	} catch {
		return false;
	}
}

type SwitchContext = Parameters<typeof continueConversationInWorktree>[0] & {
	ui: Parameters<typeof continueConversationInWorktree>[0]["ui"] & {
		confirm(title: string, message: string): Promise<boolean>;
	};
};

type FinishDependencies = Parameters<typeof continueConversationInWorktree>[2] & {
	isClean(path: string): Promise<boolean>;
	isCurrentWorktree(path: string): Promise<boolean>;
	removeWorktree(path: string): Promise<{ code: number; stderr: string }>;
	isSessionSafe(sourcePath: string): Promise<boolean>;
};

export async function finishWorktree(
	ctx: SwitchContext,
	mainPath: string,
	dependencies: FinishDependencies,
): Promise<"removed" | "retained" | "cancelled" | "refused"> {
	const sourcePath = ctx.cwd;
	if (!(await preflightConversationSwitch(ctx, dependencies.exists))) return "refused";
	if (sourcePath === mainPath) {
		ctx.ui.notify("Refusing to remove the main worktree", "error");
		return "refused";
	}
	if (!(await dependencies.isSessionSafe(sourcePath))) {
		ctx.ui.notify("Session files are inside this worktree; left intact", "error");
		return "refused";
	}
	if (!(await dependencies.isCurrentWorktree(sourcePath))) {
		ctx.ui.notify("The current worktree is no longer registered or is locked", "error");
		return "refused";
	}
	if (!(await dependencies.isClean(sourcePath))) {
		ctx.ui.notify(`Worktree has uncommitted, untracked, or ignored files; left intact at ${sourcePath}`, "warning");
		return "refused";
	}
	if (!(await ctx.ui.confirm(
		"Finish and remove worktree?",
		`Leave ${sourcePath} and continue this conversation in ${mainPath}?\n\nOnly a clean worktree will be removed. The branch and session history are kept. Code and project resources in the main worktree may load.`,
	))) return "cancelled";

	let outcome: "removed" | "retained" = "retained";
	const status = await continueConversationInWorktree(ctx, mainPath, {
		...dependencies,
		afterSwitch: async (freshCtx) => {
			try {
				if (!(await dependencies.isCurrentWorktree(sourcePath)) || !(await dependencies.isClean(sourcePath))) {
					freshCtx.ui.notify(`Worktree changed before removal; left intact at ${sourcePath}`, "warning");
					return;
				}
				const result = await dependencies.removeWorktree(sourcePath);
				if (result.code !== 0) {
					freshCtx.ui.notify(`Worktree left intact at ${sourcePath}:\n${result.stderr}`, "error");
					return;
				}
				outcome = "removed";
				freshCtx.ui.notify(`Removed worktree ${sourcePath} (branch and session history kept)`, "info");
			} catch (error) {
				freshCtx.ui.notify(`Worktree left intact at ${sourcePath}: ${(error as Error).message}`, "error");
			}
		},
	});
	return status === "switched" ? outcome : status;
}
