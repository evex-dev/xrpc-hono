import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const cliPath = path.join(repoRoot, "dist/cli/index.js");
export const fixtureDir = path.join(repoRoot, "test/fixtures/lexicons");
export const generatedRoot = path.join(repoRoot, "test/e2e/.generated");

export const SUBSCRIPTION_FIXTURE = "com/atproto/sync/subscribeRepos.json";

export function listFixtureFiles(dir = fixtureDir): string[] {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((e) => {
			const p = path.join(dir, e.name);
			return e.isDirectory() ? listFixtureFiles(p) : p.endsWith(".json") ? [p] : [];
		})
		.sort();
}

export function isSubscriptionFixture(file: string) {
	return path.relative(fixtureDir, file).split(path.sep).join("/") === SUBSCRIPTION_FIXTURE;
}

/** Path of the generated `types/...ts` file for a fixture lexicon file. */
export function typesFileFor(outDir: string, file: string) {
	return path.join(outDir, "types", path.relative(fixtureDir, file).replace(/\.json$/, ".ts"));
}

const created: string[] = [];

export function makeOutDir(name: string): string {
	const dir = path.join(generatedRoot, `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	created.push(dir);
	return dir;
}

export function cleanupOutDirs() {
	for (const d of created.splice(0)) fs.rmSync(d, { recursive: true, force: true });
	try {
		fs.rmdirSync(generatedRoot); // only succeeds if empty
	} catch {}
}

export type RunResult = { code: number | null; stdout: string; stderr: string };

export function runCli(args: string[]): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(process.execPath, [cliPath, ...args], { cwd: repoRoot }, (err, stdout, stderr) => {
			const code = err ? ((err as { code?: number }).code ?? 1) : 0;
			resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
		});
	});
}

export function runCliWithStdin(args: string[], stdin: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cliPath, ...args], { cwd: repoRoot });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(stdin);
	});
}

export function runTsc(project: string): Promise<RunResult> {
	const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
	return new Promise((resolve) => {
		execFile(process.execPath, [tsc, "-p", project], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? ((err as { code?: number }).code ?? 1) : 0;
			resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
		});
	});
}

export function listFilesRecursive(dir: string, prefix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const rel = path.join(prefix, e.name);
		return e.isDirectory() ? listFilesRecursive(path.join(dir, e.name), rel) : [rel];
	});
}
