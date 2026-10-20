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

	it("emits index/lexicons/util and one types file per lexicon, subscriptions included", async () => {
		const api = await genServerApi(all);
		expect(api.files.map((f) => f.path).sort()).toEqual(expectedFiles(all));
		for (const f of api.files) expect(f.content).toBeTypeOf("string");
		const index = api.files.find((f) => f.path === "/index.ts");
		expect(index?.content).toContain("@evex-dev/xrpc-hono");
		expect(index?.content).toContain("export function createServer");
	});

	it("generates the subscription method calling addStreamMethod", async () => {
		const api = await genServerApi(all);
		const index = api.files.find((f) => f.path === "/index.ts")?.content ?? "";
		expect(index).toContain("HonoStreamConfigOrHandler");
		expect(index).toMatch(/subscribeRepos<A extends Auth \| ErrorResult = undefined>\(/);
		expect(index).toContain("const nsid = 'com.atproto.sync.subscribeRepos'");
		expect(index).toContain("this._server.xrpc.addStreamMethod(nsid, cfg)");
		expect(index).toContain("ComAtprotoSyncSubscribeRepos.QueryParams");
	});

	it("generates the subscription types with an ErrorFrame HandlerError of the declared errors", async () => {
		const api = await genServerApi(all);
		const types = api.files.find((f) => f.path === "/types/com/atproto/sync/subscribeRepos.ts")?.content ?? "";
		expect(types).toContain("import { type ErrorFrame } from");
		expect(types).toContain("export type HandlerError = ErrorFrame<'FutureCursor' | 'ConsumerTooSlow'>");
		expect(types).toContain("export type HandlerOutput = HandlerError | OutputSchema");
		// only subscription types files import ErrorFrame
		for (const f of api.files) {
			if (f.path !== "/types/com/atproto/sync/subscribeRepos.ts") expect(f.content).not.toContain("ErrorFrame");
		}
	});

	it("uses never for a subscription without declared errors and HandlerError alone without a message schema", async () => {
		const doc = { lexicon: 1, id: "com.example.sub", defs: { main: { type: "subscription" } } };
		const api = await genServerApi([doc as never]);
		const types = api.files.find((f) => f.path === "/types/com/example/sub.ts")?.content ?? "";
		expect(types).toContain("export type HandlerError = ErrorFrame<never>");
		expect(types).toContain("export type HandlerOutput = HandlerError");
		expect(types).not.toContain("OutputSchema");
	});
});

/** The module specifiers of the relative imports of a generated file. */
function relativeImports(content: string): string[] {
	return [...content.matchAll(/from '(\.[^']*)'/g)].map((m) => m[1]);
}

describe("genServerApi importExt", () => {
	it.each([
		[undefined, ".js"],
		[".js", ".js"],
		[".ts", ".ts"],
	])("importExt %s: every relative import in every generated file ends with %s", async (importExt, ext) => {
		const api = await genServerApi(all, importExt === undefined ? {} : { importExt });
		const specifiers = api.files.flatMap((f) => relativeImports(f.content));
		// index -> lexicons/types, lexicons -> util, types -> lexicons/util/other types
		expect(specifiers.length).toBeGreaterThan(api.files.length);
		for (const f of api.files) {
			for (const s of relativeImports(f.content)) expect(path.extname(s), `${s} in ${f.path}`).toBe(ext);
		}
	});

	it('importExt "": relative imports have no extension', async () => {
		const api = await genServerApi(all, { importExt: "" });
		for (const f of api.files) {
			for (const s of relativeImports(f.content)) expect(path.extname(s), `${s} in ${f.path}`).toBe("");
		}
	});
});
