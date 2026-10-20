import { BlobRef } from "@atproto/lexicon";
import { encode } from "cborg";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createXRPCHono, MessageFrame } from "../../../src/index.js";
import { expectXrpcError } from "../../helpers/xrpc.js";
import { collect, DEFS, docs, ev, NO_HANDLER, register, SUB, type SubServer, startSubServer } from "./subscription-util.js";

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

const url = (nsid = SUB) => `${s.server.httpUrl}/xrpc/${nsid}`;

async function rawCid(seed: number, codec = 0x71) {
	return CID.create(1, codec, await sha256.digest(new Uint8Array([seed])));
}

describe("HTTP-level errors before the upgrade (atproto.com/specs/event-stream#connection)", () => {
	it.each(["POST", "PUT", "DELETE"])(
		"405 Method Not Allowed for a %s request, as an XRPC JSON error with Allow: GET",
		async (method) => {
			// event-stream "Connection": 405 is "Returned to client for non-GET HTTP requests to a stream endpoint"
			// xrpc "Error Responses": JSON object with `error`
			register(s, async function* () {});
			const res = await fetch(url(), { method });
			await expectXrpcError(res, 405);
			// implementation choice: the Allow header (RFC 9110 15.5.6) advertises GET
			expect(res.headers.get("allow")).toBe("GET");
		},
	);

	it("426 Upgrade Required without an Upgrade header, naming the websocket upgrade", async () => {
		// event-stream "Connection": 426 "Returned to client if `Upgrade` header is not included"
		register(s, async function* () {});
		const res = await fetch(url());
		await expectXrpcError(res, 426);
		// implementation choice: RFC 9110 15.5.22 requires an Upgrade header on a 426
		expect(res.headers.get("upgrade")?.toLowerCase()).toBe("websocket");
	});

	it("501 Not Implemented when no handler is registered for the subscription", async () => {
		// event-stream "Connection": 501 "Service does not implement WebSockets or streams, at least for this endpoint"
		// (fetch cannot send an Upgrade header, so the app is called directly)
		const res = await s.xrpc
			.createApp()
			.request(`/xrpc/${NO_HANDLER}`, { headers: { Upgrade: "websocket", Connection: "Upgrade" } });
		await expectXrpcError(res, 501);
	});

	it("501 Not Implemented for an NSID the server does not know", async () => {
		// xrpc "Summary of HTTP Status Codes": 501 for an endpoint that is not implemented
		const res = await fetch(url("io.example.unknown"));
		await expectXrpcError(res, 501);
	});

	it("501 Not Implemented when the server was created without an upgradeWebSocket option", async () => {
		// xrpc: "501 ... In particular, returned when WebSockets are requested but not implemented by server"
		const xrpc = createXRPCHono(docs);
		xrpc.addStreamMethod(SUB, async function* () {});
		const res = await xrpc.createApp().request(`/xrpc/${SUB}`, { headers: { Upgrade: "websocket", Connection: "Upgrade" } });
		await expectXrpcError(res, 501);
	});

	it("a non-GET request to a subscription without WebSocket support is still 405 (method is checked first)", async () => {
		// implementation choice: the order of the checks (method, handler, WebSocket support, Upgrade header)
		const res = await createXRPCHono(docs).createApp().request(`/xrpc/${SUB}`, { method: "POST" });
		await expectXrpcError(res, 405);
	});
});

describe("framing (atproto.com/specs/event-stream#framing)", () => {
	it("sends only binary WebSocket frames", async () => {
		// "messages are encoded as DRISL-CBOR and sent over a binary WebSocket"
		register(s, async function* () {
			yield ev(1);
			yield ev(2);
		});
		const { sub } = await collect(s);
		expect(sub.received).toHaveLength(2);
		expect(sub.received.every((m) => m.binary)).toBe(true);
	});

	it("each frame is exactly two concatenated CBOR objects (header, payload)", async () => {
		// "Each binary WebSocket frame contains two DRISL-CBOR objects, concatenated" (decodeFrame throws otherwise)
		register(s, async function* () {
			yield ev(1, { text: "hi" });
			yield { $type: "#info", name: "x" };
		});
		const { frames } = await collect(s);
		expect(frames).toHaveLength(2);
	});

	it("a message header is { op: 1, t } with a short-form fragment for the subscription's own Lexicon", async () => {
		// "`op` ... `1`: a regular message", "`t` ... in short form ... Eg: `#commit`"
		register(s, async function* () {
			yield { $type: `${SUB}#event`, seq: 1 };
			yield { $type: "#info", name: "n" };
		});
		const { frames } = await collect(s);
		expect(frames[0].header).toEqual({ op: 1, t: "#event" });
		expect(frames[1].header).toEqual({ op: 1, t: "#info" });
	});

	it("a full $type of the subscription's NSID and the short $type produce the same header", async () => {
		// "`t` ... Does not include the full Lexicon identifier, just a fragment"
		register(s, async function* () {
			yield { $type: `${SUB}#event`, seq: 1 };
			yield { $type: "#event", seq: 2 };
		});
		const { frames } = await collect(s);
		expect(frames.map((f) => f.header.t)).toEqual(["#event", "#event"]);
	});

	it("a message of another NSID's type keeps its full $type in `t`", async () => {
		// the spec only defines the short form; a union variant of another Lexicon has no short form
		// implementation choice: the full `nsid#fragment` is sent
		register(s, async function* () {
			yield { $type: `${DEFS}#thing`, v: "a" };
		});
		const { frames } = await collect(s);
		expect(frames[0].header).toEqual({ op: 1, t: `${DEFS}#thing` });
		expect(frames[0].body).toEqual({ v: "a" });
	});

	it("the payload omits $type and is a plain object with the remaining fields", async () => {
		// "Message payloads must always be objects. They should omit the `$type` field"
		register(s, async function* () {
			yield ev(7, { text: "hello" });
		});
		const { frames } = await collect(s);
		const body = frames[0].body as Record<string, unknown>;
		expect(body).toBeTypeOf("object");
		expect(body).not.toBeNull();
		expect(Array.isArray(body)).toBe(false);
		expect("$type" in body).toBe(false);
		expect(body).toEqual({ seq: 7, text: "hello" });
	});

	it("header and payload are canonically (DRISL) encoded: re-encoding with length-first key order gives identical bytes", async () => {
		// data-model: "DRISL-CBOR" is the normalized, byte-reproducible CBOR (sorted map keys, shortest integers)
		register(s, async function* () {
			yield ev(300, { text: "t", a: "a", long_key_name_here: "z", extra: { zz: 1, b: [1, 2, { k: true, aaa: null }], y: "s" } });
		});
		const { frames } = await collect(s);
		const f = frames[0];
		const reencoded = new Uint8Array([...encode(f.header), ...encode(f.body)]);
		expect(Buffer.from(f.bytes).equals(Buffer.from(reencoded))).toBe(true);
	});

	it("the Frame class API: a yielded MessageFrame is sent as given", async () => {
		// implementation choice: handlers may yield Frame instances, which bypass $type handling
		register(s, async function* () {
			yield new MessageFrame({ seq: 9 }, { type: "#event" });
		});
		const { frames } = await collect(s);
		expect(frames[0].header).toEqual({ op: 1, t: "#event" });
		expect(frames[0].body).toEqual({ seq: 9 });
	});

	it("closes normally after the handler completes", async () => {
		register(s, async function* () {
			yield ev(1);
		});
		const { close, frames } = await collect(s);
		expect(frames).toHaveLength(1);
		// implementation choice: 1000 (normal closure, RFC 6455 7.4.1); the spec leaves the close code open
		expect(close.code).toBe(1000);
	});
});

describe("data model encoding (atproto.com/specs/data-model)", () => {
	it("encodes a cid-link as CBOR tag 42 with a 0x00 prefix", async () => {
		// "In DRISL-CBOR, CIDs are encoded by prefixing their binary representation with 0x00. The CBOR tag used is 42"
		const cid = await rawCid(1);
		register(s, async function* () {
			yield ev(1, { link: cid });
		});
		const { frames } = await collect(s);
		const link = (frames[0].body as any).link;
		expect(CID.asCID(link)?.toString()).toBe(cid.toString());
		// d8 2a = tag 42, 58 25 = byte string of 37 bytes, 00 = identity multibase prefix
		const bytes = Array.from(frames[0].bytes);
		const at = bytes.findIndex(
			(_, i) => bytes[i] === 0xd8 && bytes[i + 1] === 0x2a && bytes[i + 2] === 0x58 && bytes[i + 3] === 0x25,
		);
		expect(at).toBeGreaterThan(0);
		expect(bytes[at + 4]).toBe(0x00);
		expect(bytes[at + 5]).toBe(0x01); // CIDv1
	});

	it("encodes bytes as a CBOR byte string (not a $bytes object)", async () => {
		// data-model table: `bytes` is a "Byte String (major 2)" in CBOR; `$bytes` is the JSON form only
		register(s, async function* () {
			yield ev(1, { data: new Uint8Array([1, 2, 3, 255]) });
		});
		const { frames } = await collect(s);
		const data = (frames[0].body as any).data;
		expect(data).toBeInstanceOf(Uint8Array);
		expect(Array.from(data)).toEqual([1, 2, 3, 255]);
	});

	it("encodes a BlobRef as a `$type: blob` map whose ref is a CID tag 42", async () => {
		// data-model table: `blob` is a "`$type: blob` Map"; the blob ref is a cid-link (raw codec)
		const cid = await rawCid(2, 0x55);
		register(s, async function* () {
			yield ev(1, { thumb: new BlobRef(cid as any, "image/png", 10) });
		});
		const { frames } = await collect(s);
		const thumb = (frames[0].body as any).thumb;
		expect(thumb.$type).toBe("blob");
		expect(thumb.mimeType).toBe("image/png");
		expect(thumb.size).toBe(10);
		expect(CID.asCID(thumb.ref)?.toString()).toBe(cid.toString());
	});

	it("encodes integers as CBOR integers and keeps nested values", async () => {
		register(s, async function* () {
			yield ev(2 ** 40, { extra: { n: -3, list: [1, "a", null, true] } });
		});
		const { frames } = await collect(s);
		expect(frames[0].body).toEqual({ seq: 2 ** 40, extra: { n: -3, list: [1, "a", null, true] } });
	});
});
