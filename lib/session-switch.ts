export type SwitchStatus = "switched" | "cancelled" | "refused";

type Entry = { id?: string };

type SwitchContext = {
	mode: string;
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	sessionManager: {
		getSessionFile(): string | undefined;
		getSessionDir(): string;
		getLeafId(): string | null;
		getEntries(): readonly Entry[];
	};
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
	switchSession(path: string, options: {
		withSession: (ctx: { ui: SwitchContext["ui"] }) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
};

type SwitchDependencies = {
	exists(path: string): Promise<boolean>;
	usesDefaultSessionDir(): boolean;
	revalidate(targetCwd: string): Promise<boolean>;
	forkSession(sourcePath: string, targetCwd: string, sessionDir?: string): Promise<{ path: string }>;
	removeSession(path: string): Promise<void>;
};

function refuse(ctx: SwitchContext, message: string): SwitchStatus {
	ctx.ui.notify(message, "error");
	return "refused";
}

export async function preflightConversationSwitch(
	ctx: SwitchContext,
	exists: (path: string) => Promise<boolean>,
): Promise<boolean> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		refuse(ctx, "Switching worktrees requires interactive Pi mode");
		return false;
	}
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		refuse(ctx, "Wait for Pi to become idle and clear queued messages before switching worktrees");
		return false;
	}
	const sourcePath = ctx.sessionManager.getSessionFile();
	if (!sourcePath || !(await exists(sourcePath))) {
		refuse(ctx, "Switching requires a persisted session. Start a conversation before switching worktrees");
		return false;
	}
	const entries = ctx.sessionManager.getEntries();
	const leafId = ctx.sessionManager.getLeafId();
	const lastEntryId = entries.at(-1)?.id ?? null;
	if (leafId !== lastEntryId) {
		refuse(ctx, "The active conversation is not the latest session branch. Run /fork before switching worktrees");
		return false;
	}
	return true;
}

export async function continueConversationInWorktree(
	ctx: SwitchContext,
	targetCwd: string,
	dependencies: SwitchDependencies,
): Promise<SwitchStatus> {
	if (!(await preflightConversationSwitch(ctx, dependencies.exists))) return "refused";
	if (targetCwd === ctx.cwd) {
		ctx.ui.notify("This worktree is already active", "info");
		return "refused";
	}
	const sourcePath = ctx.sessionManager.getSessionFile()!;
	if (!(await dependencies.revalidate(targetCwd))) {
		return refuse(ctx, "The selected worktree is no longer registered or available");
	}

	const sourceSessionDir = ctx.sessionManager.getSessionDir();
	const sessionDir = dependencies.usesDefaultSessionDir() ? undefined : sourceSessionDir;
	let forkPath: string;
	try {
		forkPath = (await dependencies.forkSession(sourcePath, targetCwd, sessionDir)).path;
	} catch (error) {
		return refuse(ctx, `Could not prepare the worktree session: ${(error as Error).message}`);
	}

	if (!(await dependencies.revalidate(targetCwd))) {
		await dependencies.removeSession(forkPath).catch(() => undefined);
		return refuse(ctx, "The selected worktree changed before the session switch");
	}

	let result: { cancelled: boolean };
	try {
		result = await ctx.switchSession(forkPath, {
			withSession: async (replacementCtx) => {
				replacementCtx.ui.notify(`Continued this conversation in ${targetCwd}`, "info");
			},
		});
	} catch (error) {
		await dependencies.removeSession(forkPath).catch(() => undefined);
		throw error;
	}
	if (result.cancelled) {
		await dependencies.removeSession(forkPath).catch(() => undefined);
		ctx.ui.notify("Worktree switch cancelled", "warning");
		return "cancelled";
	}
	return "switched";
}
