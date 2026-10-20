import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { genServerApi } from "../../../src/cli/codegen/server.js";
import { readAllLexicons } from "../../../src/cli/util.js";

const fixtureDir = path.resolve(import.meta.dirname, "../../fixtures/lexicons");

function listJson(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? listJson(p) : p.endsWith(".json") ? [p] : [];
	});
}

const all = readAllLexicons(listJson(fixtureDir));
const withoutSub = all.filter((d) => d.id !== "com.atproto.sync.subscribeRepos");

function expectedFiles(docs: { id: string }[]) {
	return ["/index.ts", "/lexicons.ts", "/util.ts", ...docs.map((d) => `/types/${d.id.split(".").join("/")}.ts`)].sort();
}

beforeAll(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("genServerApi", () => {
	it("loads every fixture lexicon", () => {
		expect(all.length).toBe(listJson(fixtureDir).length);
		expect(all.some((d) => d.id === "com.atproto.sync.subscribeRepos")).toBe(true);
	});

	it("with skipSub=true resolves even when a subscription lexicon is included and emits one types file per lexicon", async () => {
		const api = await genServerApi(all, true);
		expect(api.files.map((f) => f.path).sort()).toEqual(expectedFiles(all));
		for (const f of api.files) expect(f.content).toBeTypeOf("string");
	});

	it("with skipSub=false and no subscription lexicons emits the same kind of file set", async () => {
		const api = await genServerApi(withoutSub, false);
		expect(api.files.map((f) => f.path).sort()).toEqual(expectedFiles(withoutSub));
		const index = api.files.find((f) => f.path === "/index.ts");
		expect(index?.content).toContain("@evex-dev/xrpc-hono");
		expect(index?.content).toContain("export function createServer");
	});
});
