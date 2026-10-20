import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BlobRef, type LexiconDoc } from "@atproto/lexicon";
import { XRPCError, XrpcClient } from "@atproto/xrpc";
import { Frame, Subscription } from "@atproto/xrpc-server";
import { Hono } from "hono";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFrame, startServer, subscribe, type TestServer } from "../helpers/ws.js";
import { expectXrpcError, fromBase64, mediaType, toBytes } from "../helpers/xrpc.js";
import { cleanupOutDirs, listFixtureFiles, makeOutDir, runCli } from "./cli-helpers.js";

const DID = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
const RECORD_URI = `at://${DID}/com.example.post/3jui7kd54zh2y`;
const RECORD_CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);

async function rawCidOf(bytes: Uint8Array) {
	return CID.createV1(0x55, await sha256.digest(bytes));
}

const fixtureFiles = listFixtureFiles();
const fixtureLexicons = fixtureFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as LexiconDoc);

// state captured by the handlers
const seen = {
	listRecordsParams: undefined as Record<string, unknown> | undefined,
	queryLabelsParams: undefined as Record<string, unknown> | undefined,
	createRecordInput: undefined as { encoding: string; body: Record<string, unknown> } | undefined,
	createRecordAuth: undefined as unknown,
	createRecordCalls: 0,
};
const blobs = new Map<string, { mime: string; bytes: Uint8Array }>();

let app: Hono;
let createServer: (options?: Record<string, unknown>) => any;
// imported at runtime like the generated code does (dist/), so that the errors thrown are the classes it checks for
let InvalidRequestError: typeof import("../../src/index.js").InvalidRequestError;
const PACKAGE = "@evex-dev/xrpc-hono";

beforeAll(async () => {
	const out = makeOutDir("server");
	const r = await runCli(["--yes", out, ...fixtureFiles]);
	expect(r.code, r.stdout + r.stderr).toBe(0);
	({ createServer } = await import(/* @vite-ignore */ pathToFileURL(path.join(out, "index.ts")).href));
	({ InvalidRequestError } = await import(/* @vite-ignore */ PACKAGE));
	const server = createServer();

	server.com.atproto.identity.resolveHandle(async ({ params }: any) => {
		if (params.handle === "alice.example.com") return { encoding: "application/json", body: { did: DID } };
		return { status: 400, error: "HandleNotFound", message: "Unable to resolve handle" };
	});
	server.com.atproto.repo.listRecords(async ({ params }: any) => {
		seen.listRecordsParams = params;
		return { encoding: "application/json", body: { records: [], cursor: "next" } };
	});
	server.com.atproto.repo.createRecord({
		auth: async ({ ctx }: any) => {
			if (ctx.req.header("authorization") !== "Bearer good-token") return { status: 401, error: "AuthenticationRequired" };
			return { credentials: { did: DID } };
		},
		handler: async ({ auth, input }: any) => {
			seen.createRecordCalls++;
			seen.createRecordAuth = auth;
			seen.createRecordInput = input;
			return { encoding: "application/json", body: { uri: RECORD_URI, cid: RECORD_CID } };
		},
	});
	server.com.atproto.repo.uploadBlob(async ({ input }: any) => {
		const bytes = await toBytes(input.body);
		const cid = await rawCidOf(bytes);
		blobs.set(cid.toString(), { mime: input.encoding, bytes });
		return { encoding: "application/json", body: { blob: new BlobRef(cid, input.encoding, bytes.length) } };
	});
	server.com.atproto.sync.getBlob(async ({ params }: any) => {
		const blob = blobs.get(params.cid);
		if (!blob) return { status: 400, error: "BlobNotFound", message: "no such blob" };
		return { encoding: blob.mime, body: blob.bytes };
	});
	server.com.atproto.label.queryLabels(async ({ params }: any) => {
		seen.queryLabelsParams = params;
		return {
			encoding: "application/json",
			body: {
				labels: [{ src: DID, uri: `at://${DID}`, val: "spam", cts: "2024-01-01T00:00:00.000Z", sig: new Uint8Array([1, 2, 3]) }],
			},
		};
	});
	server.com.atproto.server.deleteSession(async () => undefined);
	// com.atproto.moderation.createReport: intentionally not registered

	app = server.xrpc.createApp();
});

afterAll(cleanupOutDirs);

const q = (o: Record<string, string | string[]>) => {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) sp.append(k, x);
	return sp.toString();
};

describe("generated server (raw requests)", () => {
	it("resolveHandle returns 200 application/json with { did }", async () => {
		const res = await app.request(`/xrpc/com.atproto.identity.resolveHandle?${q({ handle: "alice.example.com" })}`);
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("application/json");
		expect(await res.json()).toEqual({ did: DID });
	});

	it("resolveHandle with an unknown handle returns 400 HandleNotFound in the XRPC error format", async () => {
		const res = await app.request(`/xrpc/com.atproto.identity.resolveHandle?${q({ handle: "nobody.example.com" })}`);
		const body = await expectXrpcError(res, 400);
		expect(body.error).toBe("HandleNotFound");
	});

	it("resolveHandle without the required handle param returns 400 in the XRPC error format", async () => {
		const res = await app.request("/xrpc/com.atproto.identity.resolveHandle");
		await expectXrpcError(res, 400);
	});

	it("listRecords decodes query params to Lexicon types (integer, boolean)", async () => {
		const res = await app.request(
			`/xrpc/com.atproto.repo.listRecords?${q({ repo: "alice.example.com", collection: "com.example.post", limit: "10", reverse: "true" })}`,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ records: [], cursor: "next" });
		expect(seen.listRecordsParams?.limit).toBe(10);
		expect(seen.listRecordsParams?.reverse).toBe(true);
		expect(seen.listRecordsParams?.repo).toBe("alice.example.com");
	});

	it.each(["0", "101"])("listRecords rejects limit=%s outside minimum 1 / maximum 100 with 400", async (limit) => {
		const res = await app.request(
			`/xrpc/com.atproto.repo.listRecords?${q({ repo: "alice.example.com", collection: "com.example.post", limit })}`,
		);
		await expectXrpcError(res, 400);
	});

	it("queryLabels passes repeated array params and encodes bytes as { $bytes } JSON", async () => {
		const res = await app.request(`/xrpc/com.atproto.label.queryLabels?${q({ uriPatterns: ["at://a/*", "at://b/*"] })}`);
		expect(res.status).toBe(200);
		expect(seen.queryLabelsParams?.uriPatterns).toEqual(["at://a/*", "at://b/*"]);
		const body = (await res.json()) as { labels: { sig: { $bytes: string } }[] };
		expect(body.labels[0].sig).toEqual({ $bytes: Buffer.from([1, 2, 3]).toString("base64") });
		expect(Array.from(fromBase64(body.labels[0].sig.$bytes))).toEqual([1, 2, 3]);
	});

	it("createRecord without Authorization returns 401 in the XRPC error format and does not run the handler", async () => {
		const before = seen.createRecordCalls;
		const res = await app.request("/xrpc/com.atproto.repo.createRecord", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ repo: DID, collection: "com.example.post", record: { $type: "com.example.post" } }),
		});
		const body = await expectXrpcError(res, 401);
		expect(body.error).toBe("AuthenticationRequired");
		expect(seen.createRecordCalls).toBe(before);
	});

	it("createRecord with a valid token and JSON input returns { uri, cid } and the handler receives the input and auth", async () => {
		const record = { $type: "com.example.post", text: "hello" };
		const res = await app.request("/xrpc/com.atproto.repo.createRecord", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer good-token" },
			body: JSON.stringify({ repo: DID, collection: "com.example.post", record }),
		});
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("application/json");
		expect(await res.json()).toEqual({ uri: RECORD_URI, cid: RECORD_CID });
		expect(seen.createRecordInput?.body.record).toEqual(record);
		expect(seen.createRecordInput?.body.collection).toBe("com.example.post");
		expect(seen.createRecordAuth).toEqual({ credentials: { did: DID } });
	});

	it("createRecord with an input missing the required collection returns 400", async () => {
		const res = await app.request("/xrpc/com.atproto.repo.createRecord", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer good-token" },
			body: JSON.stringify({ repo: DID, record: { $type: "com.example.post" } }),
		});
		await expectXrpcError(res, 400);
	});

	it("uploadBlob stores raw bytes and returns a blob ref; getBlob serves the same bytes with the stored Content-Type", async () => {
		const up = await app.request("/xrpc/com.atproto.repo.uploadBlob", {
			method: "POST",
			headers: { "content-type": "image/png" },
			body: PNG,
		});
		expect(up.status).toBe(200);
		expect(mediaType(up)).toBe("application/json");
		const { blob } = (await up.json()) as { blob: Record<string, any> };
		expect(blob.$type).toBe("blob");
		expect(blob.mimeType).toBe("image/png");
		expect(blob.size).toBe(PNG.length);
		expect(blob.ref.$link).toBe((await rawCidOf(PNG)).toString());

		const got = await app.request(`/xrpc/com.atproto.sync.getBlob?${q({ did: DID, cid: blob.ref.$link })}`);
		expect(got.status).toBe(200);
		expect(mediaType(got)).toBe("image/png");
		expect(Array.from(new Uint8Array(await got.arrayBuffer()))).toEqual(Array.from(PNG));
	});

	it("deleteSession (POST, no input, no output) returns 200", async () => {
		const res = await app.request("/xrpc/com.atproto.server.deleteSession", { method: "POST" });
		expect(res.status).toBe(200);
	});

	it("a method present in the lexicons but without a handler returns 501 in the XRPC error format", async () => {
		const res = await app.request("/xrpc/com.atproto.moderation.createReport", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				reasonType: "com.atproto.moderation.defs#reasonSpam",
				subject: { $type: "com.atproto.admin.defs#repoRef", did: DID },
			}),
		});
		await expectXrpcError(res, 501);
	});

	it("an unknown method returns 501 in the XRPC error format", async () => {
		const res = await app.request("/xrpc/com.example.doesNotExist");
		expect((await expectXrpcError(res, 501)).error).toBe("MethodNotImplemented");
	});

	it("the app mounted into a parent Hono app via route('/') still serves /xrpc/ next to other routes", async () => {
		const parent = new Hono();
		parent.get("/health", (c) => c.text("ok"));
		parent.route("/", app);
		const health = await parent.request("/health");
		expect(await health.text()).toBe("ok");
		const res = await parent.request(`/xrpc/com.atproto.identity.resolveHandle?${q({ handle: "alice.example.com" })}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ did: DID });
	});
});

describe("generated server (XrpcClient)", () => {
	let client: XrpcClient;
	beforeAll(() => {
		client = new XrpcClient(async (url, init) => app.request(url, init), fixtureLexicons);
	});

	it("resolveHandle returns data.did", async () => {
		const res = await client.call("com.atproto.identity.resolveHandle", { handle: "alice.example.com" });
		expect(res.data.did).toBe(DID);
	});

	it("an unknown handle rejects with XRPCError HandleNotFound / 400", async () => {
		const err = await client.call("com.atproto.identity.resolveHandle", { handle: "nobody.example.com" }).catch((e) => e);
		expect(err).toBeInstanceOf(XRPCError);
		expect(err.error).toBe("HandleNotFound");
		expect(err.status).toBe(400);
	});

	it("listRecords with numeric and boolean params reaches the handler as number and boolean", async () => {
		const res = await client.call("com.atproto.repo.listRecords", {
			repo: "alice.example.com",
			collection: "com.example.post",
			limit: 10,
			reverse: true,
		});
		expect(res.success).toBe(true);
		expect(seen.listRecordsParams?.limit).toBe(10);
		expect(seen.listRecordsParams?.reverse).toBe(true);
	});

	it("uploadBlob then getBlob round-trips the bytes", async () => {
		const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 200, 201]);
		const up = await client.call("com.atproto.repo.uploadBlob", {}, bytes, { encoding: "image/png" });
		expect(up.data.blob).toBeDefined();
		const cid = up.data.blob.ref.$link ?? up.data.blob.ref.toString();
		const got = await client.call("com.atproto.sync.getBlob", { did: DID, cid });
		expect(Array.from(new Uint8Array(got.data))).toEqual(Array.from(bytes));
	});

	it("createRecord succeeds with a bearer token and rejects with status 401 without", async () => {
		const input = { repo: DID, collection: "com.example.post", record: { $type: "com.example.post", text: "hi" } };
		const ok = await client.call("com.atproto.repo.createRecord", {}, input, {
			encoding: "application/json",
			headers: { authorization: "Bearer good-token" },
		});
		expect(ok.data.uri).toBe(RECORD_URI);
		expect(ok.data.cid).toBe(RECORD_CID);
		const err = await client.call("com.atproto.repo.createRecord", {}, input, { encoding: "application/json" }).catch((e) => e);
		expect(err).toBeInstanceOf(XRPCError);
		expect(err.status).toBe(401);
	});

	it("createReport without a handler rejects with status 501", async () => {
		const err = await client
			.call(
				"com.atproto.moderation.createReport",
				{},
				{ reasonType: "com.atproto.moderation.defs#reasonSpam", subject: { $type: "com.atproto.admin.defs#repoRef", did: DID } },
				{ encoding: "application/json" },
			)
			.catch((e) => e);
		expect(err).toBeInstanceOf(XRPCError);
		expect(err.status).toBe(501);
	});
});

describe("generated server (subscription)", () => {
	const NSID = "com.atproto.sync.subscribeRepos";
	const LATEST_SEQ = 3;
	const TIME = "2024-01-01T00:00:00.000Z";
	let srv: TestServer;
	let lastParams: Record<string, unknown> | undefined;
	let lastSignal: AbortSignal | undefined;

	beforeAll(async () => {
		srv = await startServer((upgradeWebSocket) => {
			const server = createServer({ upgradeWebSocket });
			server.com.atproto.sync.subscribeRepos(async function* ({ params, signal }: any) {
				lastParams = params;
				lastSignal = signal;
				if (params.cursor !== undefined && params.cursor > LATEST_SEQ) {
					throw new InvalidRequestError("Cursor in the future.", "FutureCursor");
				}
				yield { $type: `${NSID}#identity`, seq: 1, did: DID, time: TIME, handle: "alice.example.com" };
				yield { $type: `${NSID}#account`, seq: 2, did: DID, time: TIME, active: false, status: "suspended" };
				yield { $type: `${NSID}#info`, name: "OutdatedCursor", message: "old cursor" };
			});
			return server.xrpc.createApp();
		});
	});
	afterAll(async () => {
		await srv.close();
	});

	it("sends one message frame per yielded message with the $type in the header, then closes", async () => {
		const sub = subscribe(srv.wsUrl, NSID, "cursor=1");
		await sub.closed;
		const frames = sub.frames();
		expect(frames.map((f) => f.header)).toEqual([
			{ op: 1, t: "#identity" },
			{ op: 1, t: "#account" },
			{ op: 1, t: "#info" },
		]);
		expect(frames[0].body).toEqual({ seq: 1, did: DID, time: TIME, handle: "alice.example.com" });
		expect(frames[1].body).toEqual({ seq: 2, did: DID, time: TIME, active: false, status: "suspended" });
		expect(frames[2].body).toEqual({ name: "OutdatedCursor", message: "old cursor" });
		for (const f of frames) expect(f.body).not.toHaveProperty("$type");
		expect(sub.received.every((m) => m.binary)).toBe(true);
	});

	it("decodes query params to Lexicon types for the handler", async () => {
		const sub = subscribe(srv.wsUrl, NSID, "cursor=2");
		await sub.closed;
		expect(lastParams).toEqual({ cursor: 2 });
		expect(lastSignal).toBeInstanceOf(AbortSignal);
	});

	it("a cursor in the future yields exactly one FutureCursor error frame and then closes", async () => {
		const sub = subscribe(srv.wsUrl, NSID, `cursor=${LATEST_SEQ + 10}`);
		await sub.closed;
		const frames = sub.frames();
		expect(frames).toHaveLength(1);
		expect(frames[0].header).toEqual({ op: -1 });
		expect(frames[0].body).toEqual({ error: "FutureCursor", message: "Cursor in the future." });
	});

	it("a plain HTTP request (no WebSocket upgrade) is rejected with an XRPC error", async () => {
		const res = await fetch(`${srv.httpUrl}/xrpc/${NSID}`);
		expect(res.status).toBe(426);
	});

	describe("interop with @atproto/xrpc-server", () => {
		it("Frame.fromBytes parses our message frames", async () => {
			const sub = subscribe(srv.wsUrl, NSID, "cursor=1");
			await sub.closed;
			const parsed = sub.frames().map((f) => Frame.fromBytes(f.bytes));
			expect(parsed).toHaveLength(3);
			for (const f of parsed) expect(f.isMessage()).toBe(true);
			expect(parsed.map((f) => (f.isMessage() ? f.type : undefined))).toEqual(["#identity", "#account", "#info"]);
			expect(parsed[0].body).toEqual({ seq: 1, did: DID, time: TIME, handle: "alice.example.com" });
		});

		it("Frame.fromBytes parses our error frame", async () => {
			const sub = subscribe(srv.wsUrl, NSID, "cursor=99");
			await sub.closed;
			const [frame] = sub.received.map((m) => (m.binary ? Frame.fromBytes(m.bytes) : undefined));
			expect(frame?.isError()).toBe(true);
			if (!frame?.isError()) throw new Error("expected an error frame");
			expect(frame.code).toBe("FutureCursor");
			expect(frame.message).toBe("Cursor in the future.");
			// and the same bytes decode with our own helper
			expect(decodeFrame(sub.received[0].binary ? sub.received[0].bytes : new Uint8Array()).header).toEqual({ op: -1 });
		});

		it("the Subscription client receives the messages with $type restored", async () => {
			const ac = new AbortController();
			const got: Record<string, unknown>[] = [];
			const client = new Subscription<Record<string, unknown>>({
				service: srv.wsUrl,
				method: NSID,
				getParams: () => ({ cursor: 1 }),
				validate: (obj) => obj as Record<string, unknown>,
				signal: ac.signal,
			});
			try {
				for await (const msg of client) {
					got.push(msg);
					if (got.length === 3) break;
				}
			} finally {
				ac.abort();
			}
			expect(got).toEqual([
				{ $type: `${NSID}#identity`, seq: 1, did: DID, time: TIME, handle: "alice.example.com" },
				{ $type: `${NSID}#account`, seq: 2, did: DID, time: TIME, active: false, status: "suspended" },
				{ $type: `${NSID}#info`, name: "OutdatedCursor", message: "old cursor" },
			]);
		});

		it("the Subscription client throws on our error frame", async () => {
			const ac = new AbortController();
			const client = new Subscription({
				service: srv.wsUrl,
				method: NSID,
				getParams: () => ({ cursor: 99 }),
				validate: (obj) => obj,
				signal: ac.signal,
			});
			const err = await (async () => {
				try {
					for await (const _ of client) {
						// no messages expected
					}
				} catch (e) {
					return e;
				} finally {
					ac.abort();
				}
			})();
			expect(err).toBeInstanceOf(Error);
			expect((err as { error?: string }).error ?? (err as Error).message).toContain("FutureCursor");
		});
	});
});
