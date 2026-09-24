import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_SHORTCUT,
	configPath,
	isValidShortcut,
	getAgentDir,
	readConfig,
	saveShortcut,
	validateShortcut,
} from "../lib/config.ts";

async function tempAgentDir() {
	return mkdtemp(join(tmpdir(), "pi-worktree-config-test-"));
}

test("configPath resolves the user config location", () => {
	assert.equal(configPath("/tmp/agent"), "/tmp/agent/pi-worktree/config.json");
	assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "" }, "/home/test"), "/home/test/.pi/agent");
});

test("missing config uses the default shortcut", async () => {
	const agentDir = await tempAgentDir();
	assert.deepEqual(await readConfig(agentDir), {
		shortcut: DEFAULT_SHORTCUT,
		diagnostic: null,
	});
});

test("valid config is read", async () => {
	const agentDir = await tempAgentDir();
	await saveShortcut("super+f12", agentDir);
	assert.deepEqual(await readConfig(agentDir), {
		shortcut: "super+f12",
		diagnostic: null,
	});
});

test("malformed and invalid configs disable the shortcut with diagnostics", async () => {
	const agentDir = await tempAgentDir();
	const path = configPath(agentDir);
	await import("node:fs/promises").then(({ mkdir }) => mkdir(join(agentDir, "pi-worktree")));
	await writeFile(path, "not json");
	assert.equal((await readConfig(agentDir)).shortcut, null);
	assert.match((await readConfig(agentDir)).diagnostic, /JSON|parse/i);

	await writeFile(path, JSON.stringify({ version: 2, shortcut: "ctrl+w" }));
	assert.equal((await readConfig(agentDir)).shortcut, null);
	assert.match((await readConfig(agentDir)).diagnostic, /version/i);

	await writeFile(path, JSON.stringify({ version: 1, shortcut: "w" }));
	const result = await readConfig(agentDir);
	assert.equal(result.shortcut, null);
	assert.match(result.diagnostic, /modifier|shortcut/i);
});

test("validates documented Pi shortcut syntax", () => {
	for (const shortcut of [
		"ctrl+alt+w",
		"shift+1",
		"super+pageUp",
		"ctrl+shift+?",
		"alt+f12",
	]) assert.equal(isValidShortcut(shortcut), true, shortcut);
	assert.deepEqual(validateShortcut("w").valid, false);
	for (const shortcut of ["w", "ctrl", "ctrl+", "ctrl++", "ctrl+wat", "ctrl+ctrl+w", "CTRL+w", "ctrl+f13"]) {
		assert.equal(isValidShortcut(shortcut), false, shortcut);
	}
});

test("saveShortcut writes atomically with restrictive permissions", async () => {
	const agentDir = await tempAgentDir();
	const result = await saveShortcut("ctrl+alt+w", agentDir);
	assert.equal(result.ok, true);
	assert.deepEqual(JSON.parse(await readFile(configPath(agentDir), "utf8")), {
		version: 1,
		shortcut: "ctrl+alt+w",
	});
	assert.equal((await stat(configPath(agentDir))).mode & 0o777, 0o600);

	const invalid = await saveShortcut("w", agentDir);
	assert.equal(invalid.ok, false);
	assert.equal(JSON.parse(await readFile(configPath(agentDir), "utf8")).shortcut, "ctrl+alt+w");

	await chmod(configPath(agentDir), 0o644);
	await saveShortcut(null, agentDir);
	assert.equal(JSON.parse(await readFile(configPath(agentDir), "utf8")).shortcut, null);
	assert.equal((await stat(configPath(agentDir))).mode & 0o777, 0o600);
});
