import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	cleanupOutDirs,
	fixtureDir,
	isSubscriptionFixture,
	listFilesRecursive,
	listFixtureFiles,
	makeOutDir,
	runCli,
	runCliWithStdin,
	runTsc,
	typesFileFor,
} from "./cli-helpers.js";

const allFixtures = listFixtureFiles();
const noSub = allFixtures.filter((f) => !isSubscriptionFixture(f));

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

const USAGE = `import { createServer, COM_ATPROTO_MODERATION } from "./index";

const server = createServer();

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

export const app = server.xrpc.createApp();
`;

function writeTypecheckFiles(out: string) {
	fs.writeFileSync(path.join(out, "tsconfig.json"), JSON.stringify(TSCONFIG, null, "\t"));
	fs.writeFileSync(path.join(out, "usage.ts"), USAGE);
}

function expectGenerated(out: string, fixtures: string[]) {
	const files = listFilesRecursive(out).map((f) => f.split(path.sep).join("/"));
	expect(files).toEqual(expect.arrayContaining(["index.ts", "lexicons.ts", "util.ts"]));
	for (const f of fixtures) expect(fs.existsSync(typesFileFor(out, f)), `missing types file for ${f}`).toBe(true);
}

afterAll(cleanupOutDirs);

describe("gen-xrpc-hono CLI", () => {
	const outNoSub = makeOutDir("cli-nosub");
	const outSkipSub = makeOutDir("cli-skipsub");

	it("--yes generates index/lexicons/util and a types file per lexicon (no subscription lexicon)", async () => {
		const r = await runCli(["--yes", outNoSub, ...noSub]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expectGenerated(outNoSub, noSub);
	});

	it("--yes --skip-sub succeeds when a subscription lexicon is among the inputs", async () => {
		const r = await runCli(["--yes", "--skip-sub", outSkipSub, ...allFixtures]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expectGenerated(outSkipSub, allFixtures);
	});

	it("generated code (without subscriptions) type-checks and its types are meaningful", async () => {
		writeTypecheckFiles(outNoSub);
		const r = await runTsc(outNoSub);
		expect(r.code, r.stdout + r.stderr).toBe(0);
	});

	it("generated code (--skip-sub) type-checks and its types are meaningful", async () => {
		writeTypecheckFiles(outSkipSub);
		const r = await runTsc(outSkipSub);
		expect(r.code, r.stdout + r.stderr).toBe(0);
	});

	it("re-running with fewer lexicons removes the dropped lexicons' types files and keeps the rest", async () => {
		const out = makeOutDir("cli-rerun");
		const first = await runCli(["--yes", out, ...noSub]);
		expect(first.code, first.stdout + first.stderr).toBe(0);
		const dropped = noSub.filter((f) => /(admin|lexicon|moderation)\//.test(path.relative(fixtureDir, f)));
		expect(dropped.length).toBeGreaterThan(0);
		const kept = noSub.filter((f) => !dropped.includes(f));
		const second = await runCli(["--yes", out, ...kept]);
		expect(second.code, second.stdout + second.stderr).toBe(0);
		for (const f of dropped) expect(fs.existsSync(typesFileFor(out, f)), `${f} should be removed`).toBe(false);
		expectGenerated(out, kept);
	});

	it("without --yes, answering n writes no files", async () => {
		const out = makeOutDir("cli-no");
		const r = await runCliWithStdin([out, ...noSub], "n\n");
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expect(listFilesRecursive(out)).toEqual([]);
	});

	it("without --yes, answering y writes the files", async () => {
		const out = makeOutDir("cli-yes");
		const r = await runCliWithStdin([out, ...noSub], "y\n");
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expectGenerated(out, noSub);
	});

	it("skips arguments that are not lexicon JSON and still generates the valid ones", async () => {
		const out = makeOutDir("cli-skip");
		const scratch = makeOutDir("cli-skip-inputs");
		fs.mkdirSync(scratch, { recursive: true });
		const txt = path.join(scratch, "notes.txt");
		const notLexicon = path.join(scratch, "other.json");
		fs.writeFileSync(txt, "hello");
		fs.writeFileSync(notLexicon, '{"foo":1}');
		const r = await runCli(["--yes", out, txt, notLexicon, ...noSub]);
		expect(r.code, r.stdout + r.stderr).toBe(0);
		expectGenerated(out, noSub);
		expect(listFilesRecursive(out).some((f) => f.includes("other") || f.includes("notes"))).toBe(false);
	});
});
