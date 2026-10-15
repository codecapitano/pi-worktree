type TerminalOutput = { isTTY?: boolean; write(data: string): unknown };

export function createTerminalCwdReporter(
	originalCwd: string,
	output: TerminalOutput = process.stdout,
	env: Record<string, string | undefined> = process.env,
	state: { reported?: string } = {},
) {
	const supported = output.isTTY === true && env.TERM_PROGRAM === "iTerm.app" && !env.TMUX && !env.STY;
	const safePath = (cwd: string) => cwd.startsWith("/") && !/[\u0000-\u001f\u007f-\u009f]/.test(cwd);
	function emit(cwd: string): boolean {
		if (!supported || !safePath(cwd)) return false;
		try {
			output.write(`\x1b]1337;CurrentDir=${cwd}\x07`);
			return true;
		} catch { return false; }
	}
	function restore() {
		if (state.reported === undefined) return;
		if (emit(originalCwd)) state.reported = undefined;
	}
	return {
		supported,
		update(cwd: string, enabled: boolean) {
			if (!enabled) return restore();
			if (cwd !== state.reported && emit(cwd)) state.reported = cwd;
		},
		restore,
	};
}
