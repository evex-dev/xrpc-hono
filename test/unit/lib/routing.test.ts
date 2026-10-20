import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createXRPCHono } from "../../../src/index.js";
import { expectXrpcError, lexicon } from "../../helpers/xrpc.js";
import { build, okJson, procDoc, queryDoc } from "./util.js";

const Q = "io.example.query";
const P = "io.example.procedure";

const qDoc = () => queryDoc(Q);
const pDoc = () => procDoc(P);

describe("routing", () => {
	it("serves a registered query at GET /xrpc/<nsid>", async () => {
		const app = build([qDoc()], { [Q]: () => ({ encoding: "application/json", body: { hello: "world" } }) });
		const res = await app.request(`/xrpc/${Q}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toStrictEqual({ hello: "world" });
	});

	it("serves a registered procedure at POST /xrpc/<nsid>", async () => {
		const app = build([pDoc()], { [P]: () => ({ encoding: "application/json", body: { ok: true } }) });
		const res = await app.request(`/xrpc/${P}`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toStrictEqual({ ok: true });
	});

	it("rejects a query requested with POST with a 4xx error", async () => {
		const handler = vi.fn(okJson);
		const app = build([qDoc()], { [Q]: handler });
		const res = await app.request(`/xrpc/${Q}`, { method: "POST" });
		await expectXrpcError(res);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		expect(handler).not.toHaveBeenCalled();
	});

	it("rejects a procedure requested with GET with a 4xx error", async () => {
		const handler = vi.fn(okJson);
		const app = build([pDoc()], { [P]: handler });
		const res = await app.request(`/xrpc/${P}`);
		await expectXrpcError(res);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).toBeLessThan(500);
		expect(handler).not.toHaveBeenCalled();
	});

	// user decision: unknown endpoints are answered like known-but-unimplemented ones (501 MethodNotImplemented)
	it("returns 501 MethodNotImplemented for an NSID not present in any lexicon (GET and POST)", async () => {
		const app = build([qDoc()], { [Q]: okJson });
		for (const init of [undefined, { method: "POST" }]) {
			const body = await expectXrpcError(await app.request("/xrpc/io.example.unknown", init), 501);
			expect(body.error).toBe("MethodNotImplemented");
		}
	});

	// user decision: an NSID that is not an endpoint (e.g. a record or defs lexicon) is answered like an unknown one
	it("returns 501 MethodNotImplemented for an NSID whose lexicon is not a query or procedure", async () => {
		const record = lexicon("io.example.record", {
			type: "record",
			key: "tid",
			record: { type: "object", properties: {} },
		});
		const app = build([qDoc(), record], { [Q]: okJson });
		const body = await expectXrpcError(await app.request("/xrpc/io.example.record"), 501);
		expect(body.error).toBe("MethodNotImplemented");
	});

	it("returns 501 for a known query without a handler", async () => {
		const app = build([qDoc()]);
		await expectXrpcError(await app.request(`/xrpc/${Q}`), 501);
	});

	it("returns 501 for a known procedure without a handler", async () => {
		const app = build([pDoc()]);
		await expectXrpcError(await app.request(`/xrpc/${P}`, { method: "POST" }), 501);
	});

	it.each(["/xrpc/not_an_nsid", "/xrpc/", "/xrpc/io.example.query/extra"])(
		"returns a JSON 4xx error for malformed path %s under /xrpc/",
		async (path) => {
			const app = build([qDoc()], { [Q]: okJson });
			const res = await app.request(path);
			await expectXrpcError(res);
			expect(res.status).toBeLessThan(500);
		},
	);

	it("serves /xrpc/<nsid> when mounted at the top level of a parent app", async () => {
		const xrpc = createXRPCHono([qDoc()]);
		xrpc.addMethod(Q, () => ({ encoding: "application/json", body: { n: 1 } }));
		const parent = new Hono().route("/", xrpc.createApp());
		const res = await parent.request(`/xrpc/${Q}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toStrictEqual({ n: 1 });
	});

	it("addMethod accepts both a bare handler function and a { handler } config", async () => {
		const q2 = "io.example.query2";
		const app = build([qDoc(), queryDoc(q2)], {
			[Q]: () => ({ encoding: "application/json", body: { k: "fn" } }),
			[q2]: { handler: () => ({ encoding: "application/json", body: { k: "cfg" } }) },
		});
		expect(await (await app.request(`/xrpc/${Q}`)).json()).toStrictEqual({ k: "fn" });
		expect(await (await app.request(`/xrpc/${q2}`)).json()).toStrictEqual({ k: "cfg" });
	});

	it("serves lexicons added with addLexicon and addLexicons after creation", async () => {
		const xrpc = createXRPCHono([]);
		xrpc.addLexicon(qDoc());
		xrpc.addLexicons([procDoc(P), queryDoc("io.example.third")]);
		const h1 = vi.fn(okJson);
		const h2 = vi.fn(okJson);
		const h3 = vi.fn(okJson);
		xrpc.addMethod(Q, h1);
		xrpc.addMethod(P, h2);
		xrpc.addMethod("io.example.third", h3);
		const app = xrpc.createApp();
		expect((await app.request(`/xrpc/${Q}`)).status).toBe(200);
		expect((await app.request(`/xrpc/${P}`, { method: "POST" })).status).toBe(200);
		expect((await app.request("/xrpc/io.example.third")).status).toBe(200);
		expect(h1).toHaveBeenCalledTimes(1);
		expect(h2).toHaveBeenCalledTimes(1);
		expect(h3).toHaveBeenCalledTimes(1);
	});

	it("dispatches each registered method to its own handler", async () => {
		const a = vi.fn(() => ({ encoding: "application/json", body: { who: "a" } }));
		const b = vi.fn(() => ({ encoding: "application/json", body: { who: "b" } }));
		const app = build([queryDoc("io.example.a"), queryDoc("io.example.b")], { "io.example.a": a, "io.example.b": b });
		expect(await (await app.request("/xrpc/io.example.b")).json()).toStrictEqual({ who: "b" });
		expect(await (await app.request("/xrpc/io.example.a")).json()).toStrictEqual({ who: "a" });
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("passes the Hono context of the current request to the handler", async () => {
		const app = build([lexicon(Q, { type: "query", output: { encoding: "application/json" } })], {
			[Q]: ({ c }: { c: { req: { header(n: string): string | undefined } } }) => ({
				encoding: "application/json",
				body: { v: c.req.header("x-test") ?? null },
			}),
		});
		const res = await app.request(`/xrpc/${Q}`, { headers: { "x-test": "abc" } });
		expect(await res.json()).toStrictEqual({ v: "abc" });
	});
});
