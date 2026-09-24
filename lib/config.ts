import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_SHORTCUT = "ctrl+alt+w";
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete",
	"insert", "clear", "home", "end", "pageUp", "pageDown", "up", "down", "left", "right",
]);
const SYMBOL_KEYS = new Set(["`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?"]);

type Config = { version: 1; shortcut: string | null };
export type ConfigResult = { shortcut: string | null; diagnostic: string | null };
export type SaveResult = { ok: boolean; diagnostic: string | null };
export type ValidationResult = { valid: boolean; diagnostic: string | null };

/** Purely resolve the config location under an agent directory. */
export function configPath(agentDir: string): string {
	return join(agentDir, "pi-worktree", "config.json");
}

export function getAgentDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
	const configured = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	return configured === "~" ? home : configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
}

export function getConfigPath(agentDir = getAgentDir()): string {
	return configPath(agentDir);
}

function keyIsValid(key: string): boolean {
	return /^[a-z]$/.test(key) || /^[0-9]$/.test(key) || SPECIAL_KEYS.has(key) || /^f(?:[1-9]|1[0-2])$/.test(key) || SYMBOL_KEYS.has(key);
}

export function validateShortcut(value: unknown): ValidationResult {
	if (typeof value !== "string" || value.length === 0) {
		return { valid: false, diagnostic: "Shortcut must be a non-empty key combination" };
	}
	let rest = value;
	const modifiers = new Set<string>();
	while (true) {
		const separator = rest.indexOf("+");
		if (separator < 0) break;
		const candidate = rest.slice(0, separator);
		if (!MODIFIERS.has(candidate)) break;
		if (modifiers.has(candidate)) return { valid: false, diagnostic: `Duplicate shortcut modifier: ${candidate}` };
		modifiers.add(candidate);
		rest = rest.slice(separator + 1);
	}
	if (modifiers.size === 0) return { valid: false, diagnostic: "Shortcut must include at least one modifier" };
	if (!keyIsValid(rest) || rest === "+") return { valid: false, diagnostic: `Invalid shortcut key: ${rest || "(missing)"}` };
	return { valid: true, diagnostic: null };
}

export function isValidShortcut(value: unknown): boolean {
	return validateShortcut(value).valid;
}

function invalidConfig(diagnostic: string): ConfigResult {
	return { shortcut: null, diagnostic };
}

function parseConfig(raw: string): ConfigResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return invalidConfig(`Could not parse shortcut config JSON: ${(error as Error).message}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1) {
		return invalidConfig("Shortcut config must have version 1");
	}
	const shortcut = (parsed as { shortcut?: unknown }).shortcut;
	if (shortcut !== null && typeof shortcut !== "string") return invalidConfig("Shortcut config shortcut must be a string or null");
	const validation = shortcut === null ? { valid: true, diagnostic: null } : validateShortcut(shortcut);
	if (!validation.valid) return invalidConfig(validation.diagnostic!);
	return { shortcut, diagnostic: null };
}

export function readConfigSync(agentDir = getAgentDir()): ConfigResult {
	try {
		return parseConfig(readFileSync(configPath(agentDir), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { shortcut: DEFAULT_SHORTCUT, diagnostic: null };
		return invalidConfig(`Could not read shortcut config: ${(error as Error).message}`);
	}
}

export async function readConfig(agentDir = getAgentDir()): Promise<ConfigResult> {
	let raw: string;
	try {
		raw = await readFile(configPath(agentDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { shortcut: DEFAULT_SHORTCUT, diagnostic: null };
		return invalidConfig(`Could not read shortcut config: ${(error as Error).message}`);
	}
	return parseConfig(raw);
}

export async function saveShortcut(shortcut: string | null, agentDir = getAgentDir()): Promise<SaveResult> {
	if (shortcut !== null) {
		const validation = validateShortcut(shortcut);
		if (!validation.valid) return { ok: false, diagnostic: validation.diagnostic };
	}
	const path = configPath(agentDir);
	const directory = dirname(path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(temporary, `${JSON.stringify({ version: 1, shortcut }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
		try { await chmod(path, 0o600); } catch { /* best effort */ }
		return { ok: true, diagnostic: null };
	} catch (error) {
		try { await unlink(temporary); } catch { /* best effort */ }
		return { ok: false, diagnostic: `Could not save shortcut config: ${(error as Error).message}` };
	}
}

export type { Config };
