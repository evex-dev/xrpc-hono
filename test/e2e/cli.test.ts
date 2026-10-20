import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	cleanupOutDirs,
	fixtureDir,
	listFilesRecursive,
	listFixtureFiles,
	makeOutDir,
	runCli,
	runCliWithStdin,
	runNode,
	runTsc,
	typesFileFor,
} from "./cli-helpers.js";

const allFixtures = listFixtureFiles();

const TSCONFIG = {
	compilerOptions: {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: "es2022",
		module: "esnext",
		moduleResolution: "bundler",
		types: ["node"],
	},
	include: ["**/*.ts"],
};

const USAGE = `import { createNodeWebSocket } from "@hono/node-ws";
import { ErrorFrame, InvalidRequestError } from "@evex-dev/xrpc-hono";
import { Hono } from "hono";
import { createServer, COM_ATPROTO_MODERATION } from "./index";

const { upgradeWebSocket } = createNodeWebSocket({ app: new Hono() });
const server = createServer({ upgradeWebSocket });

server.com.atproto.identity.resolveHandle(async ({ params }) => {
	const h: string = params.handle;
	if (h === "missing") return { status: 400, error: "HandleNotFound", message: "no such handle" };
	return { encoding: "application/json", body: { did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz" } };
});

// @ts-expect-error did must be a string
server.com.atproto.identity.resolveHandle(async () => ({ encoding: "application/json", body: { did: 123 } }));

// @ts-expect-error body is missing the required "did"
server.com.atproto.identity.resolveHandle(async () => ({ encoding: "application/json", body: {} }));

// @ts-expect-error "NotDeclared" is not an error declared by the lexicon
server.com.atproto.identity.resolveHandle(async () => ({ status: 400, error: "NotDeclared" }));

server.com.atproto.repo.listRecords(async ({ params }) => {
	const n: number = params.limit;
	// @ts-expect-error limit is an integer, not a string
	const s: string = params.limit;
	void n;
	void s;
	return { encoding: "application/json", body: { records: [] } };
});

server.com.atproto.repo.createRecord({
	auth: async ({ ctx }) => {
		if (ctx.req.header("authorization") !== "Bearer good-token") return { status: 401, error: "AuthenticationRequired" };
		return { credentials: { did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz" } };
	},
	handler: async ({ auth, input }) => {
		const did: unknown = auth.credentials;
		void did;
		const collection: string = input.body.collection;
		void collection;
		return {
			encoding: "application/json",
			body: {
				uri: "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/com.example.post/3jui7kd54zh2y",
				cid: "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a",
			},
		};
	},
});

server.com.atproto.repo.uploadBlob(async ({ input }) => {
	// user decision: binary input is a web ReadableStream, not a node stream.Readable
	void input.body.getReader();
	// @ts-expect-error not a node stream.Readable
	input.body.on("data", () => {});
	return { status: 400, message: "not implemented in this test" };
});

server.com.atproto.sync.getBlob(async () => ({ encoding: "image/png", body: new Uint8Array([1, 2, 3]) }));

server.com.atproto.label.queryLabels(async ({ params }) => {
	const patterns: string[] = params.uriPatterns;
	void patterns;
	return { encoding: "application/json", body: { labels: [] } };
});

server.com.atproto.server.deleteSession(async () => undefined);

export const spam: string = COM_ATPROTO_MODERATION.DefsReasonSpam;
// @ts-expect-error this token does not exist
export const nope = COM_ATPROTO_MODERATION.DefsReasonDoesNotExist;

server.com.atproto.sync.subscribeRepos(async function* ({ params, signal }) {
	const cursor: number | undefined = params.cursor;
	// @ts-expect-error cursor is an integer, not a string
	const s: string | undefined = params.cursor;
	void s;
	if (signal.aborted) return;
	if (cursor !== undefined && cursor > 100) yield new ErrorFrame({ error: "FutureCursor", message: "Cursor in the future." });
	yield { $type: "com.atproto.sync.subscribeRepos#info", name: "OutdatedCursor" };
	yield {
		$type: "com.atproto.sync.subscribeRepos#identity",
		seq: 1,
		did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
		time: "2024-01-01T00:00:00.000Z",
	};
	throw new InvalidRequestError("Cursor in the future.", "FutureCursor");
});

// @ts-expect-error "NotDeclared" is not an error declared by the lexicon
server.com.atproto.sync.subscribeRepos(async function* () { yield new ErrorFrame({ error: "NotDeclared" }); });

// the message union is open ({ $type: string } is accepted), so only values that are not messages at all are rejected
// @ts-expect-error a number is not a message
server.com.atproto.sync.subscribeRepos(async function* () { yield 123; });

server.com.atproto.sync.subscribeRepos({
	auth: async ({ ctx }) => {
		if (ctx.req.header("authorization") !== "Bearer good-token") return { status: 401, error: "AuthenticationRequired" };
		return { credentials: { did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz" } };
	},
	handler: async function* ({ auth, params }) {
		const did: unknown = auth.credentials;
		void did;
		const cursor: number | undefined = params.cursor;
		void cursor;
		yield { $type: "com.atproto.sync.subscribeRepos#info", name: "OutdatedCursor", message: "hi" };
	},
});

export const app = server.xrpc.createApp();
`;

function writeTypecheckFiles(out: string) {
	fs.writeFileSync(path.join(out, "tsconfig.json"), JSON.stringify(TSCONFIG, null, "\t"));
	fs.writeFileSync(path.join(out, "usage.ts"), USAGE);
}

/** Writes a tsconfig that checks only the generated files, with the given module settings; returns its path. */
function writeGeneratedTsconfig(out: string, name: string, compilerOptions: Record<string, unknown>): string {
	const file = path.join(out, name);
	const config = {
		compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "es2022", types: ["node"], ...compilerOptions },
		include: ["index.ts", "lexicons.ts", "util.ts", "types/**/*.ts"],
	};
	fs.writeFileSync(file, JSON.stringify(config, null, "\t"));
	return file;
}

const RUN_TS = `import { createServer } from "./index.ts";

const server = createServer();
server.com.atproto.identity.resolveHandle(async () => ({
	encoding: "application/json",
	body: { did: "did:plc:ewvi7nxzyoun6zhxrhs64oiz" },
}));
const res = await server.xrpc.createApp().request("/xrpc/com.atproto.identity.resolveHandle?handle=alice.example.com");
console.log(res.status, await res.text());
`;

function expectGenerated(out: string, fixtures: string[]) {
	const files = listFilesRecursive(out).map((f) => f.split(path.sep).join("/"));
	expect(files).toEqual(expect.arrayContaining(["index.ts", "lexicons.ts", "util.ts"]));
	for (const f of fixtures) expect(fs.existsSync(typesFileFor(out, f)), `missing types file for ${f}`).toBe(true);
}

afterAll(cleanupOutDirs);

describe("gen-xrpc-hono CLI", () => {
	const out = makeOutDir("cli-all");

	it("--yes generates index/lexicons/util and a types file per lexicon (subscription included)", async () => {
		const r = await runCli(["--yes", out, ...allFixtures]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expectGenerated(out, allFixtures);
	});

	it("rejects the removed --skip-sub option", async () => {
		const r = await runCli(["--yes", "--skip-sub", makeOutDir("cli-skipsub"), ...allFixtures]);
		expect(r.code).not.toBe(0);
	});

	it("generated code type-checks and its types are meaningful", async () => {
		writeTypecheckFiles(out);
		const r = await runTsc(out);
		expect(r.code, r.stdout + r.stderr).toBe(0);
	});

	it("the default (.js) relative imports type-check with moduleResolution nodenext", async () => {
		const tsconfig = writeGeneratedTsconfig(out, "tsconfig.nodenext.json", { module: "nodenext", moduleResolution: "nodenext" });
		const r = await runTsc(tsconfig);
		expect(r.code, r.stdout + r.stderr).toBe(0);
	});

	it("re-running with fewer lexicons removes the dropped lexicons' types files and keeps the rest", async () => {
		const out = makeOutDir("cli-rerun");
		const first = await runCli(["--yes", out, ...allFixtures]);
		expect(first.code, first.stdout + first.stderr).toBe(0);
		const dropped = allFixtures.filter((f) => /(admin|lexicon|moderation)\//.test(path.relative(fixtureDir, f)));
		expect(dropped.length).toBeGreaterThan(0);
		const kept = allFixtures.filter((f) => !dropped.includes(f));
		const second = await runCli(["--yes", out, ...kept]);
		expect(second.code, second.stdout + second.stderr).toBe(0);
		for (const f of dropped) expect(fs.existsSync(typesFileFor(out, f)), `${f} should be removed`).toBe(false);
		expectGenerated(out, kept);
	});

	it("without --yes, answering n writes no files", async () => {
		const out = makeOutDir("cli-no");
		const r = await runCliWithStdin([out, ...allFixtures], "n\n");
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expect(listFilesRecursive(out)).toEqual([]);
	});

	it("without --yes, answering y writes the files", async () => {
		const out = makeOutDir("cli-yes");
		const r = await runCliWithStdin([out, ...allFixtures], "y\n");
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expectGenerated(out, allFixtures);
	});

	it("skips arguments that are not lexicon JSON and still generates the valid ones", async () => {
		const out = makeOutDir("cli-skip");
		const scratch = makeOutDir("cli-skip-inputs");
		fs.mkdirSync(scratch, { recursive: true });
		const txt = path.join(scratch, "notes.txt");
		const notLexicon = path.join(scratch, "other.json");
		fs.writeFileSync(txt, "hello");
		fs.writeFileSync(notLexicon, '{"foo":1}');
		const r = await runCli(["--yes", out, txt, notLexicon, ...allFixtures]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expectGenerated(out, allFixtures);
		expect(listFilesRecursive(out).some((f) => f.includes("other") || f.includes("notes"))).toBe(false);
	});
});

describe("gen-xrpc-hono --import-ext", () => {
	const outTs = makeOutDir("cli-import-ext-ts");

	it(".ts generates .ts imports that type-check with allowImportingTsExtensions and only erasable syntax", async () => {
		const r = await runCli(["--yes", "--import-ext", ".ts", outTs, ...allFixtures]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expect(fs.readFileSync(path.join(outTs, "index.ts"), "utf8")).toContain("from './lexicons.ts'");
		// verbatimModuleSyntax and erasableSyntaxOnly reject what Node.js type stripping can not run
		const tsconfig = writeGeneratedTsconfig(outTs, "tsconfig.json", {
			module: "nodenext",
			moduleResolution: "nodenext",
			allowImportingTsExtensions: true,
			verbatimModuleSyntax: true,
			erasableSyntaxOnly: true,
		});
		const tsc = await runTsc(tsconfig);
		expect(tsc.code, tsc.stdout + tsc.stderr).toBe(0);
	});

	it.runIf(process.features.typescript)(".ts generated code runs on Node.js directly (type stripping)", async () => {
		const runTs = path.join(outTs, "run.ts");
		fs.writeFileSync(runTs, RUN_TS);
		const r = await runNode([runTs]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expect(r.stdout.trim()).toBe('200 {"did":"did:plc:ewvi7nxzyoun6zhxrhs64oiz"}');
	});

	it('"" generates extension-less imports that type-check with moduleResolution bundler', async () => {
		const out = makeOutDir("cli-import-ext-none");
		const r = await runCli(["--yes", "--import-ext", "", out, ...allFixtures]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expect(fs.readFileSync(path.join(out, "index.ts"), "utf8")).toContain("from './lexicons'");
		const tsc = await runTsc(writeGeneratedTsconfig(out, "tsconfig.json", { module: "esnext", moduleResolution: "bundler" }));
		expect(tsc.code, tsc.stdout + tsc.stderr).toBe(0);
	});

	it("rejects an extension without the leading dot and writes nothing", async () => {
		const out = makeOutDir("cli-import-ext-bad");
		const r = await runCli(["--yes", "--import-ext", "ts", out, ...allFixtures]);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toContain("--import-ext");
		expect(listFilesRecursive(out)).toEqual([]);
	});
});
