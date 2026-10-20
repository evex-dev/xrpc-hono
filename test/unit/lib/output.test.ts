import { Readable } from "node:stream";
import { BlobRef } from "@atproto/lexicon";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";
import { expectXrpcError, fromBase64, lexicon, mediaType, toBytes } from "../../helpers/xrpc.js";
import { build, queryDoc } from "./util.js";

const Q = "io.example.out";
const CID_STR = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";

const run = (doc: ReturnType<typeof lexicon>, handler: unknown) => build([doc], { [Q]: handler }).request(`/xrpc/${Q}`);
const json = (schema: Record<string, unknown>, body: unknown, extra: Record<string, unknown> = {}) =>
	run(lexicon(Q, { type: "query", output: { encoding: "application/json", schema } }), () => ({
		encoding: "application/json",
		body,
		...extra,
	}));
const objSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });

describe("output", () => {
	it("serves JSON output with the application/json media type", async () => {
		const res = await run(queryDoc(Q), () => ({ encoding: "application/json", body: { a: 1, b: ["x"] } }));
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("application/json");
		expect(await res.json()).toStrictEqual({ a: 1, b: ["x"] });
	});

	it("serialises Uint8Array in a bytes field as {$bytes}", async () => {
		const res = await json(objSchema({ data: { type: "bytes" } }), { data: new Uint8Array([1, 2, 3]) });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: Record<string, string> };
		expect(Object.keys(body.data)).toStrictEqual(["$bytes"]);
		expect(Array.from(fromBase64(body.data.$bytes))).toStrictEqual([1, 2, 3]);
	});

	it("serialises a CID in a cid-link field as {$link}", async () => {
		const res = await json(objSchema({ ref: { type: "cid-link" } }), { ref: CID.parse(CID_STR) });
		expect(res.status).toBe(200);
		expect(await res.json()).toStrictEqual({ ref: { $link: CID_STR } });
	});

	it("serialises a BlobRef in a blob field", async () => {
		const cid = CID.create(1, 0x55, await sha256.digest(new Uint8Array([1, 2, 3])));
		const res = await json(objSchema({ file: { type: "blob" } }), { file: new BlobRef(cid, "image/png", 100) });
		expect(res.status).toBe(200);
		expect(await res.json()).toStrictEqual({
			file: { $type: "blob", ref: { $link: cid.toString() }, mimeType: "image/png", size: 100 },
		});
	});

	it("serialises nested bytes inside arrays and objects", async () => {
		const res = await json(objSchema({ list: { type: "array", items: { type: "unknown" } }, obj: { type: "unknown" } }), {
			list: [{ d: new Uint8Array([4]) }],
			obj: { deep: { d: new Uint8Array([5, 6]) } },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as any;
		expect(Object.keys(body.list[0].d)).toStrictEqual(["$bytes"]);
		expect(Array.from(fromBase64(body.list[0].d.$bytes))).toStrictEqual([4]);
		expect(Object.keys(body.obj.deep.d)).toStrictEqual(["$bytes"]);
		expect(Array.from(fromBase64(body.obj.deep.d.$bytes))).toStrictEqual([5, 6]);
	});

	it("returns 200 for a lexicon without output when the handler returns undefined, with a Content-Type if there is a body", async () => {
		const res = await run(lexicon(Q, { type: "query" }), () => undefined);
		expect(res.status).toBe(200);
		const text = await res.text();
		if (text.length > 0) expect(res.headers.get("content-type")).toBeTruthy();
	});

	const bytes = new Uint8Array([0, 1, 2, 255]);
	const binDoc = () => lexicon(Q, { type: "query", output: { encoding: "*/*" } });

	it("serves binary output from a Uint8Array body", async () => {
		const res = await run(binDoc(), () => ({ encoding: "image/png", body: bytes }));
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("image/png");
		expect(Array.from(await toBytes(await res.arrayBuffer()))).toStrictEqual(Array.from(bytes));
	});

	it("serves binary output from a node Readable body", async () => {
		const res = await run(binDoc(), () => ({ encoding: "image/png", body: Readable.from([Buffer.from(bytes)]) }));
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("image/png");
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toStrictEqual(Array.from(bytes));
	});

	it("serves binary output from a web ReadableStream body", async () => {
		const res = await run(binDoc(), () => ({ encoding: "image/png", body: new Blob([bytes]).stream() }));
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("image/png");
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toStrictEqual(Array.from(bytes));
	});

	it("serves a pipe-through buffer", async () => {
		const res = await run(binDoc(), () => ({ encoding: "application/octet-stream", buffer: Buffer.from(bytes) }));
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("application/octet-stream");
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toStrictEqual(Array.from(bytes));
	});

	it("serves a pipe-through stream", async () => {
		const res = await run(binDoc(), () => ({
			encoding: "application/octet-stream",
			stream: Readable.from([Buffer.from(bytes)]),
		}));
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("application/octet-stream");
		expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toStrictEqual(Array.from(bytes));
	});

	it("applies handler headers to JSON output", async () => {
		const res = await run(queryDoc(Q), () => ({ encoding: "application/json", body: {}, headers: { "x-custom": "v1" } }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-custom")).toBe("v1");
	});

	it("applies handler headers to binary output", async () => {
		const res = await run(binDoc(), () => ({ encoding: "image/png", body: bytes, headers: { "x-custom": "v2" } }));
		expect(res.status).toBe(200);
		expect(res.headers.get("x-custom")).toBe("v2");
	});
});

// Output validation: the reference implementation (@atproto/xrpc-server, validateResponse enabled by default)
// rejects handler output that does not conform to the Lexicon with a 500 InternalServerError.
describe("output validation", () => {
	const schemaDoc = (schema: Record<string, unknown>) =>
		lexicon(Q, { type: "query", output: { encoding: "application/json", schema } });
	const recordSchema = {
		type: "object",
		required: ["did"],
		properties: { did: { type: "string", format: "did" }, count: { type: "integer" } },
	};

	it("returns 500 when the body misses a required property", async () => {
		const res = await run(schemaDoc(recordSchema), () => ({ encoding: "application/json", body: { count: 1 } }));
		await expectXrpcError(res, 500);
	});

	it("returns 500 when a property has the wrong type", async () => {
		const res = await run(schemaDoc(recordSchema), () => ({ encoding: "application/json", body: { did: 123 } }));
		await expectXrpcError(res, 500);
	});

	it("returns 500 when a string violates its format", async () => {
		const res = await run(schemaDoc(recordSchema), () => ({ encoding: "application/json", body: { did: "not-a-did" } }));
		await expectXrpcError(res, 500);
	});

	it("returns 500 for a float inside an unknown field (data model has no floats)", async () => {
		const res = await run(schemaDoc(objSchema({ meta: { type: "unknown" } })), () => ({
			encoding: "application/json",
			body: { meta: { a: 1.5 } },
		}));
		await expectXrpcError(res, 500);
	});

	it("returns 500 for a datetime without timezone (lexicon datetime format)", async () => {
		const res = await run(schemaDoc(objSchema({ at: { type: "string", format: "datetime" } })), () => ({
			encoding: "application/json",
			body: { at: "1985-04-12T23:20:50.123" },
		}));
		await expectXrpcError(res, 500);
	});

	it("returns 500 when the handler returns nothing but the Lexicon declares an output", async () => {
		const res = await run(schemaDoc(recordSchema), () => undefined);
		await expectXrpcError(res, 500);
	});

	it("returns 500 when the handler returns a body but the Lexicon declares no output", async () => {
		const res = await run(lexicon(Q, { type: "query" }), () => ({ encoding: "application/json", body: {} }));
		await expectXrpcError(res, 500);
	});

	it("returns 500 when the output encoding does not match the Lexicon", async () => {
		const res = await run(queryDoc(Q), () => ({ encoding: "text/plain", body: "hello" }));
		await expectXrpcError(res, 500);
	});

	it("accepts an output encoding matching a glob pattern (image/*)", async () => {
		const res = await run(lexicon(Q, { type: "query", output: { encoding: "image/*" } }), () => ({
			encoding: "image/png",
			body: new Uint8Array([0, 1, 2, 255]),
		}));
		expect(res.status).toBe(200);
		expect(mediaType(res)).toBe("image/png");
	});

	it("returns 500 for an output encoding outside a glob pattern (image/*)", async () => {
		const res = await run(lexicon(Q, { type: "query", output: { encoding: "image/*" } }), () => ({
			encoding: "text/plain",
			body: "hello",
		}));
		await expectXrpcError(res, 500);
	});

	it("passes a valid body through unchanged", async () => {
		const res = await run(schemaDoc(recordSchema), () => ({
			encoding: "application/json",
			body: { did: "did:web:example.com" },
		}));
		expect(res.status).toBe(200);
		expect(await res.json()).toStrictEqual({ did: "did:web:example.com" });
	});
});
