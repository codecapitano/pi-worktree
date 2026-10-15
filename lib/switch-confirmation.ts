type ConfirmationUI = {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
};
type Preference = {
	enabled: boolean;
	save(enabled: boolean): Promise<{ ok: boolean; diagnostic: string | null }>;
};

export async function confirmWorktreeSwitch(
	ui: ConfirmationUI,
	title: string,
	message: string,
	preference: Preference,
): Promise<boolean> {
	let enabled = preference.enabled;
	while (true) {
		const toggle = `New terminal panes: ${enabled ? "Follow Pi's worktree" : "Keep original directory"}`;
		const result = await ui.select(
			`${title}\n\n${message}\n\nTerminal pane choice is remembered globally. Select it to toggle.\nFollowing Pi requires iTerm2 to reuse the previous pane's directory.\nNot supported in tmux or screen.\nExisting panes and the launching shell stay unchanged.`,
			["Continue", toggle, "Cancel"],
		);
		if (result === "Continue") return true;
		if (result !== toggle) return false;
		const saved = await preference.save(!enabled);
		if (saved.ok) enabled = !enabled;
		else ui.notify(saved.diagnostic ?? "Could not save terminal pane preference", "error");
	}
}
