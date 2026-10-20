import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ErrorFrame, ForbiddenError, InvalidRequestError } from "../../../src/index.js";
import { collect, ev, register, STRICT, SUB, type SubServer, startSubServer } from "./subscription-util.js";

let s: SubServer;
let errorLog: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
	s = await startSubServer();
});
afterAll(async () => {
	await s.server.close();
});
beforeEach(() => {
	errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
});

/** Asserts a lone error frame (event-stream "Framing"): `op: -1`, no `t`, `error` without namespace or `#`. */
async function expectOnlyError(query: string, nsid = SUB) {
	const { frames, close, sub } = await collect(s, query, nsid);
	expect(sub.received.every((m) => m.binary)).toBe(true);
	expect(frames).toHaveLength(1);
	const [f] = frames;
	expect(f.header).toEqual({ op: -1 });
	expect("t" in f.header).toBe(false);
	const body = f.body as { error: string; message?: string };
	expect(body.error).toBeTypeOf("string");
	expect(body.error).not.toMatch(/[#.]/);
	if (body.message !== undefined) expect(body.message).toBeTypeOf("string");
	return { body, close };
}

describe("error frames (atproto.com/specs/event-stream#framing)", () => {
	it("an error frame has header { op: -1 } without `t` and a payload with `error` (no namespace or #) and optional `message`", async () => {
		// "`-1`: an error message", "`t` ... Should not be included in header if `op` is `-1`", "`error` (string, required) ... no namespace or `#` prefix"
		register(s, async function* () {
			yield* [];
			throw new InvalidRequestError("cursor is in the future", "FutureCursor");
		});
		const { body } = await expectOnlyError("");
		expect(body).toEqual({ error: "FutureCursor", message: "cursor is in the future" });
	});

	it("an error created without a message still yields a valid payload (`message` is optional)", async () => {
		// "`message` (string, optional)"
		register(s, async function* () {
			yield* [];
			throw new InvalidRequestError(undefined, "ConsumerTooSlow");
		});
		const { body } = await expectOnlyError("");
		expect(body.error).toBe("ConsumerTooSlow");
	});

	it("closes the stream right after the error frame and sends nothing else", async () => {
		// "Streams should be closed immediately following transmitting or receiving an error frame."
		register(s, async function* () {
			yield* [];
			throw new InvalidRequestError("boom", "FutureCursor");
		});
		const { close } = await expectOnlyError("");
		// implementation choice: close code 1008 (policy violation) with the error name as the close reason
		expect(close.code).toBe(1008);
		expect(close.reason).toBe("FutureCursor");
	});

	it("a handler yielding an ErrorFrame ends the stream with that error frame", async () => {
		// implementation choice: Frame instances can be yielded; an ErrorFrame is terminal
		register(s, async function* () {
			yield ev(1);
			yield new ErrorFrame({ error: "ConsumerTooSlow", message: "too slow" });
			yield ev(2);
		});
		const { frames } = await collect(s);
		expect(frames).toHaveLength(2);
		expect(frames[0].header).toEqual({ op: 1, t: "#event" });
		expect(frames[1].header).toEqual({ op: -1 });
		expect(frames[1].body).toEqual({ error: "ConsumerTooSlow", message: "too slow" });
	});

	it("an error after some messages is sent as the last frame, after the earlier messages in order", async () => {
		// "If a client can not keep up ... the server may send a 'too slow' error and close the connection."
		register(s, async function* () {
			yield ev(1);
			yield ev(2);
			throw new InvalidRequestError("slow", "ConsumerTooSlow");
		});
		const { frames, close } = await collect(s);
		expect(frames.map((f) => f.header.op)).toEqual([1, 1, -1]);
		expect((frames[0].body as any).seq).toBe(1);
		expect((frames[1].body as any).seq).toBe(2);
		expect(frames[2].body).toEqual({ error: "ConsumerTooSlow", message: "slow" });
		expect(close.code).toBe(1008);
	});

	it("an unexpected exception becomes an InternalServerError frame without leaking details, and is logged", async () => {
		// xrpc: 500 "Generic internal service error"; implementation choice: the message is hidden from the client
		register(s, async function* () {
			yield* [];
			throw new Error("secret database password");
		});
		const { body } = await expectOnlyError("");
		expect(body.error).toBe("InternalServerError");
		expect(JSON.stringify(body)).not.toContain("secret");
		expect(errorLog).toHaveBeenCalled();
	});
});

describe("connection-time errors are the first message (atproto.com/specs/event-stream#connection)", () => {
	// "Connection-time errors are sent as the first message on the stream, and then the server drops the connection."

	it("a handler that throws before its first yield sends the error as the first (only) message", async () => {
		register(s, async function* () {
			yield* [];
			throw new InvalidRequestError("nope", "FutureCursor");
		});
		const { body } = await expectOnlyError("cursor=999");
		expect(body.error).toBe("FutureCursor");
	});

	it("a handler that rejects a cursor from the future with the Lexicon's FutureCursor error (event-stream 'Sequence Numbers')", async () => {
		// "`cursor` is higher than current `seq`: server sends an error message and closes connection"
		const current = 100;
		register(s, async function* ({ params }: any) {
			if (params.cursor !== undefined && params.cursor > current) {
				throw new InvalidRequestError("Cursor is in the future", "FutureCursor");
			}
			yield ev(current);
		});
		const { body } = await expectOnlyError("cursor=101");
		expect(body.error).toBe("FutureCursor");
		const ok = await collect(s, "cursor=100");
		expect(ok.frames.map((f) => f.header.op)).toEqual([1]);
	});

	it("invalid params (wrong type) are sent as an InvalidRequest error frame; the handler is not called", async () => {
		const handler = vi.fn(async function* () {
			yield ev(1);
		});
		register(s, handler);
		const { body } = await expectOnlyError("limit=abc");
		expect(body.error).toBe("InvalidRequest");
		expect(handler).not.toHaveBeenCalled();
	});

	it("a param violating a Lexicon constraint (maximum) is an InvalidRequest error frame", async () => {
		// lexicon `integer` `maximum`; xrpc: 400 "Request was invalid" maps to InvalidRequest
		register(s, async function* () {
			yield ev(1);
		});
		const { body } = await expectOnlyError("limit=11");
		expect(body.error).toBe("InvalidRequest");
	});

	it("a missing required param is an InvalidRequest error frame", async () => {
		// lexicon `params` `required`
		register(
			s,
			async function* () {
				yield { $type: `${SUB}#info`, name: "x" };
			},
			STRICT,
		);
		const { body } = await expectOnlyError("", STRICT);
		expect(body.error).toBe("InvalidRequest");
		const ok = await collect(s, "topic=a", STRICT);
		expect(ok.frames).toHaveLength(1);
	});

	it("auth failure via an ErrorResult returned by the verifier is sent as an error frame; the handler is not called", async () => {
		// event-stream: "subscription endpoints may require authentication at connection time"
		// xrpc: 401 -> AuthenticationRequired
		const handler = vi.fn(async function* () {
			yield ev(1);
		});
		register(s, { auth: () => ({ status: 401, error: "AuthenticationRequired", message: "login please" }), handler });
		const { body } = await expectOnlyError("");
		expect(body).toEqual({ error: "AuthenticationRequired", message: "login please" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("auth failure via a thrown AuthRequiredError is sent as an error frame", async () => {
		const handler = vi.fn(async function* () {
			yield ev(1);
		});
		register(s, {
			auth: async () => {
				throw new AuthRequiredError("bad token");
			},
			handler,
		});
		const { body } = await expectOnlyError("");
		expect(body).toEqual({ error: "AuthenticationRequired", message: "bad token" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("a thrown ForbiddenError keeps its name", async () => {
		register(s, {
			auth: async () => {
				throw new ForbiddenError("not for you");
			},
			handler: async function* () {},
		});
		const { body } = await expectOnlyError("");
		expect(body.error).toBe("Forbidden");
	});

	it("a successful auth result is passed to the handler", async () => {
		let seen: unknown;
		register(s, {
			auth: () => ({ credentials: { did: "did:example:alice" } }),
			handler: async function* ({ auth }: any) {
				seen = auth;
				yield ev(1);
			},
		});
		const { frames } = await collect(s);
		expect(frames).toHaveLength(1);
		expect(seen).toEqual({ credentials: { did: "did:example:alice" } });
	});

	it("auth runs before params are validated (auth error wins over invalid params)", async () => {
		// implementation choice: order of auth and params, same as for queries
		register(s, {
			auth: () => ({ status: 401, message: "no" }),
			handler: async function* () {},
		});
		const { body } = await expectOnlyError("limit=abc");
		expect(body.error).toBe("AuthenticationRequired");
	});
});

describe("message validation (atproto.com/specs/lexicon)", () => {
	// implementation choice: a message not matching the Lexicon is a server bug, so it is an InternalServerError
	// error frame with no details, logged on the server; earlier messages are unaffected

	async function expectInternalError(message: unknown) {
		register(s, async function* () {
			yield ev(1);
			yield message;
			yield ev(3);
		});
		const { frames, close } = await collect(s);
		expect(frames.map((f) => f.header.op)).toEqual([1, -1]);
		expect(frames[1].header).toEqual({ op: -1 });
		const body = frames[1].body as { error: string; message?: string };
		expect(body.error).toBe("InternalServerError");
		expect(close.code).toBe(1008);
		expect(errorLog).toHaveBeenCalled();
		return body;
	}

	it("rejects a message missing a required field (Lexicon object `required`) without revealing details", async () => {
		const body = await expectInternalError({ $type: "#event", text: "no seq" });
		expect(JSON.stringify(body)).not.toMatch(/seq|required/i);
	});

	it("rejects a $type that is not in a closed union", async () => {
		// lexicon union `closed`: "the set of types is fixed and can not be extended"
		await expectInternalError({ $type: `${SUB}#bogus`, seq: 2 });
	});

	it("rejects a message without $type when the union needs it", async () => {
		// lexicon: union variants include `$type` (the top-level exception for subscription messages
		// cannot be honoured since the header `t` is derived from it)
		// implementation choice: handlers must tag every message
		await expectInternalError({ seq: 2 });
	});

	it("rejects a field of the wrong type", async () => {
		await expectInternalError({ $type: "#event", seq: "2" });
	});

	it("rejects a float anywhere in the message, even inside an `unknown` field", async () => {
		// data-model: floats are "not allowed in atproto"
		await expectInternalError({ $type: "#event", seq: 2, extra: { deep: [1.5] } });
	});

	it("rejects a datetime without a timezone", async () => {
		// lexicon string format `datetime`: a timezone is required
		await expectInternalError({ $type: "#event", seq: 2, when: "2024-01-01T00:00:00" });
	});

	it("accepts a valid datetime", async () => {
		register(s, async function* () {
			yield ev(1, { when: "2024-01-01T00:00:00.000Z" });
		});
		const { frames } = await collect(s);
		expect(frames).toHaveLength(1);
		expect(frames[0].header.op).toBe(1);
	});

	it("rejects a non-object message", async () => {
		// event-stream: "Message payloads must always be objects."
		await expectInternalError("just a string");
		await expectInternalError(null);
		await expectInternalError([1, 2]);
	});
});
