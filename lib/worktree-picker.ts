import { basename } from "node:path";

export type WorktreePickerWorktree = {
	path: string;
	head: string;
	branch: string | null;
	bare?: boolean;
	locked?: boolean;
	prunable?: boolean;
	missing?: boolean;
	/** Optional display name supplied by a caller that has one. */
	displayName?: string;
};

export type WorktreePickerItem = {
	/** The exact object supplied to createWorktreePickerItems. */
	worktree: WorktreePickerWorktree;
	path: string;
	displayName: string;
	shortHead: string;
	labels: string[];
	label: string;
	unavailable: boolean;
};

const SHORT_HEAD_LENGTH = 8;

export function shortWorktreeHead(head: string): string {
	return head.slice(0, SHORT_HEAD_LENGTH);
}

export function isSubsequence(needle: string, haystack: string): boolean {
	const wanted = needle.toLocaleLowerCase();
	const value = haystack.toLocaleLowerCase();
	let position = 0;
	for (const character of value) {
		if (character === wanted[position]) position++;
	}
	return position === wanted.length;
}

function isUnavailable(worktree: WorktreePickerWorktree): boolean {
	return Boolean(worktree.bare || worktree.prunable || worktree.missing);
}

export function worktreePickerLabels(
	worktree: WorktreePickerWorktree,
	index: number,
	currentCwd?: string,
	mainPath?: string,
): string[] {
	const labels: string[] = [];
	if (worktree.path === currentCwd) labels.push("current");
	if (mainPath ? worktree.path === mainPath : index === 0) labels.push("main");
	if (worktree.branch === null) labels.push("detached");
	if (worktree.locked) labels.push("locked");
	if (isUnavailable(worktree)) labels.push("unavailable");
	return labels;
}

export function createWorktreePickerItems(
	worktrees: readonly WorktreePickerWorktree[],
	currentCwd?: string,
	mainPath?: string,
): WorktreePickerItem[] {
	return worktrees.map((worktree, index) => {
		const displayName = worktree.branch ?? worktree.displayName ?? `(detached ${shortWorktreeHead(worktree.head)})`;
		const labels = worktreePickerLabels(worktree, index, currentCwd, mainPath);
		return {
			worktree,
			path: worktree.path,
			displayName,
			shortHead: shortWorktreeHead(worktree.head),
			labels,
			label: labels.length > 0 ? `${displayName} (${labels.join(", ")})` : displayName,
			unavailable: isUnavailable(worktree),
		};
	});
}

export function filterWorktreePickerItems(
	items: readonly WorktreePickerItem[],
	query: string,
): WorktreePickerItem[] {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [...items];
	return items.filter((item) => {
		const fields = [item.displayName, basename(item.path), item.shortHead];
		return tokens.every((token) => fields.some((field) => isSubsequence(token, field)));
	});
}

type PickerContext = {
	ui: {
		custom<T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any): Promise<T>;
	};
};

export async function showWorktreePicker(
	ctx: PickerContext,
	worktrees: readonly WorktreePickerWorktree[],
	currentCwd?: string,
	mainPath?: string,
): Promise<WorktreePickerWorktree | undefined> {
	const { Container, Input, SelectList, Spacer, Text } = await import("@earendil-works/pi-tui");
	const allItems = createWorktreePickerItems(worktrees, currentCwd, mainPath).filter((item) => !item.unavailable);
	return ctx.ui.custom<WorktreePickerWorktree | undefined>((tui, theme, keybindings, done) => {
		class WorktreePicker extends Container {
			private input = new Input();
			private listContainer = new Container();
			private list: any;
			private _focused = false;

			constructor() {
				super();
				this.addChild(new Text(theme.fg("accent", theme.bold("Switch worktree")), 1, 0));
				this.addChild(new Text(theme.fg("dim", "Type to filter by branch, path, or commit"), 1, 0));
				this.addChild(new Spacer(1));
				this.input.onSubmit = () => this.list?.handleInput("\r");
				this.addChild(this.input);
				this.addChild(new Spacer(1));
				this.addChild(this.listContainer);
				this.rebuild("");
			}

			get focused() { return this._focused; }
			set focused(value: boolean) {
				this._focused = value;
				this.input.focused = value;
			}

			private rebuild(query: string) {
				const visible = filterWorktreePickerItems(allItems, query);
				const choices = visible.map((item) => ({
					value: item,
					label: item.label,
					description: item.path,
				}));
				this.listContainer.clear();
				this.list = new SelectList(choices, Math.max(1, Math.min(choices.length, 12)), {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				});
				this.list.onSelect = (choice: { value: WorktreePickerItem }) => done(choice.value.worktree);
				this.list.onCancel = () => done(undefined);
				this.listContainer.addChild(this.list);
				tui.requestRender();
			}

			handleInput(data: string) {
				if (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"]
					.some((action) => keybindings.matches(data, action))) {
					this.list.handleInput(data);
					return;
				}
				this.input.handleInput(data);
				this.rebuild(this.input.getValue());
			}
		}
		return new WorktreePicker();
	});
}

// Concise aliases for callers that prefer model/filter terminology.
export const buildWorktreePickerItems = createWorktreePickerItems;
export const filterWorktrees = filterWorktreePickerItems;
