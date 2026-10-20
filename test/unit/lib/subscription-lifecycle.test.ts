import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribe } from "../../helpers/ws.js";
import { collect, deferred, ev, register, SUB, type SubServer, startSubServer } from "./subscription-util.js";

let s: SubServer;
beforeAll(async () => {
	s = await startSubServer();
});
afterAll(async () => {
	await s.server.close();
});
beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("query parameters (atproto.com/specs/event-stream#connection, atproto.com/specs/xrpc)", () => {
	// "Query parameters may be provided in the initial HTTP request to configure the stream ... as specified in the endpoint's Lexicon schema."
	async function paramsFor(query: string) {
		let seen: Record<string, unknown> | undefined;
		register(s, async function* ({ params }: any) {
			seen = params;
			yield ev(1);
		});
		const { frames } = await collect(s, query);
		expect(frames[0].header.op).toBe(1);
		return seen;
	}

	it("decodes integers, booleans, strings and repeated params into arrays", async () => {
		// xrpc: "Multiple query parameters with the same name can be used to represent an array"; booleans are `true`/`false`
		const params = await paramsFor("cursor=42&flag=true&name=bob&tags=a&tags=b");
		expect(params).toMatchObject({ cursor: 42, flag: true, name: "bob", tags: ["a", "b"] });
	});

	it("decodes `false` booleans", async () => {
		expect((await paramsFor("flag=false"))?.flag).toBe(false);
	});

	it("applies Lexicon defaults", async () => {
		// lexicon: `default` values of params; absent optional params stay undefined
		const params = await paramsFor("");
		expect(params?.limit).toBe(5);
		expect(params?.cursor).toBeUndefined();
	});

	it("ignores undeclared params", async () => {
		// implementation choice: the spec does not define unknown query params; they are not passed to the handler
		const params = await paramsFor("unknown=1&cursor=3");
		expect(params).not.toHaveProperty("unknown");
		expect(params?.cursor).toBe(3);
	});
});

describe("sequence numbers and backfill (atproto.com/specs/event-stream#sequence-numbers)", () => {
	it("streams many messages in order with increasing seq starting after the cursor", async () => {
		// "Sequence numbers are always positive integers (non-zero), and increase monotonically"
		register(s, async function* ({ params }: any) {
			const start = (params.cursor ?? 0) + 1;
			for (let seq = start; seq < start + 500; seq++) yield ev(seq);
		});
		const { frames, close } = await collect(s, "cursor=1000");
		expect(frames).toHaveLength(500);
		const seqs = frames.map((f) => (f.body as any).seq as number);
		expect(seqs[0]).toBe(1001);
		expect(seqs).toEqual(Array.from({ length: 500 }, (_, i) => 1001 + i));
		expect(frames.every((f) => f.header.op === 1 && f.header.t === "#event")).toBe(true);
		expect(close.code).toBe(1000);
	});

	it("backfill then live: messages produced later by the handler are delivered after the backfilled ones", async () => {
		// "server sends any persisted messages ... then continues once 'caught up' with current stream"
		const live = deferred();
		register(s, async function* () {
			yield ev(1);
			yield ev(2);
			await live.promise;
			yield ev(3);
		});
		const sub = subscribe(s.server.wsUrl, SUB);
		await sub.waitFor(2);
		expect(sub.received).toHaveLength(2);
		live.resolve();
		await sub.closed;
		expect(sub.frames().map((f) => (f.body as any).seq)).toEqual([1, 2, 3]);
	});
});

describe("client frames and disconnects", () => {
	it("frames sent by the client are ignored: no error, the stream continues and ends normally", async () => {
		// "Servers should ignore any frames received from the client, not treat them as errors."
		const gate = deferred();
		register(s, async function* () {
			yield ev(1);
			await gate.promise;
			yield ev(2);
		});
		const sub = subscribe(s.server.wsUrl, SUB);
		await sub.waitFor(1);
		sub.ws.send("hello");
		sub.ws.send(new Uint8Array([0xa0, 0xa0]));
		sub.ws.send(new Uint8Array([1, 2, 3]));
		gate.resolve();
		const close = await sub.closed;
		expect(sub.frames().map((f) => f.header.op)).toEqual([1, 1]);
		expect(close.code).toBe(1000);
	});

	it("aborts `signal` when the client closes the connection", async () => {
		const aborted = deferred<boolean>();
		register(s, async function* ({ signal }: any) {
			yield ev(1);
			signal.addEventListener("abort", () => aborted.resolve(true), { once: true });
			if (signal.aborted) aborted.resolve(true);
			await aborted.promise;
		});
		const sub = subscribe(s.server.wsUrl, SUB);
		await sub.waitFor(1);
		expect(sub.ws.readyState).toBe(WebSocket.OPEN);
		sub.ws.close(1000);
		expect(await aborted.promise).toBe(true);
	});

	it("`signal` is not aborted while the connection is open", async () => {
		const gate = deferred();
		let abortedWhileOpen: boolean | undefined;
		register(s, async function* ({ signal }: any) {
			yield ev(1);
			await gate.promise;
			abortedWhileOpen = signal.aborted;
		});
		const sub = subscribe(s.server.wsUrl, SUB);
		await sub.waitFor(1);
		gate.resolve();
		await sub.closed;
		expect(abortedWhileOpen).toBe(false);
	});

	it("ends the handler's generator (running its finally) when the client disconnects", async () => {
		const finished = deferred();
		const first = deferred();
		register(s, async function* () {
			try {
				for (let seq = 1; ; seq++) {
					yield ev(seq);
					first.resolve();
					await new Promise((r) => setTimeout(r, 5));
				}
			} finally {
				finished.resolve();
			}
		});
		const sub = subscribe(s.server.wsUrl, SUB);
		await first.promise;
		sub.ws.close(1000);
		await finished.promise;
	});

	it("runs the handler's finally also when it completes normally and when it throws", async () => {
		const cleanups: string[] = [];
		register(s, async function* () {
			try {
				yield ev(1);
			} finally {
				cleanups.push("done");
			}
		});
		await collect(s);
		register(s, async function* () {
			yield* [];
			try {
				throw new Error("x");
			} finally {
				cleanups.push("threw");
			}
		});
		await collect(s);
		expect(cleanups).toEqual(["done", "threw"]);
	});
});

describe("mounted inside a parent Hono app", () => {
	let parent: SubServer;
	beforeAll(async () => {
		parent = await startSubServer((xrpcApp) => {
			const app = new Hono<any>();
			app.use("*", async (c, next) => {
				c.set("tenant", "acme");
				await next();
			});
			app.get("/health", (c) => c.text("ok"));
			app.route("/", xrpcApp);
			return app;
		});
	});
	afterAll(async () => {
		await parent.server.close();
	});

	it("serves the subscription next to other routes, with the parent's context available to the handler", async () => {
		register(parent, async function* ({ c }: any) {
			yield { $type: "#info", name: c.get("tenant") };
		});
		const { frames, close } = await collect(parent);
		expect(frames).toHaveLength(1);
		expect(frames[0].header).toEqual({ op: 1, t: "#info" });
		expect(frames[0].body).toEqual({ name: "acme" });
		expect(close.code).toBe(1000);
		const res = await fetch(`${parent.server.httpUrl}/health`);
		expect(await res.text()).toBe("ok");
	});

	it("still answers non-upgrade requests with the XRPC 426 error", async () => {
		const res = await fetch(`${parent.server.httpUrl}/xrpc/${SUB}`);
		expect(res.status).toBe(426);
	});
});
