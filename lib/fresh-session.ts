import { writeFile } from "node:fs/promises";

type SessionFactory = (cwd: string, sessionDir?: string) => {
	getSessionFile(): string | undefined;
	getHeader(): object | null;
};

export async function createFreshSession(
	factory: SessionFactory,
	targetCwd: string,
	sessionDir: string | undefined,
	entries: readonly object[],
): Promise<{ path: string }> {
	const manager = factory(targetCwd, sessionDir);
	const path = manager.getSessionFile();
	const header = manager.getHeader();
	if (!path || !header) throw new Error("Pi did not create a target session path and header");
	// Pi delays writing fresh sessions until a conversation starts. Write the
	// public header and setup entries so switchSession can load the target cwd.
	const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	await writeFile(path, content, { flag: "wx" });
	return { path };
}
