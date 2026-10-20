import type { Lexicons, LexXrpcSubscription } from "@atproto/lexicon";
import type { Context, Env } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { parseParams } from "./request.js";
import type { HonoXRPCOptions, HonoXRPCStreamConfig } from "./types.js";
import { toInternalServerError } from "./utils.js";
import { assertNoFloats, assertSchemaConstraints } from "./validation.js";
import {
	excludeErrorResult,
	InternalServerError,
	MethodNotImplementedError,
	type ResponseType,
	XRPCError,
} from "./xrpc-server-errors.js";
import { ErrorFrame, Frame, MessageFrame } from "./xrpc-server-frames.js";

// WebSocket close codes (RFC 6455 section 7.4.1)
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;
const WS_OPEN = 1;

/**
 * Serves a subscription (atproto.com/specs/event-stream). Requests that can not be upgraded to a WebSocket get an
 * HTTP error; anything failing after that (params, auth, the handler) is sent as an error frame on the stream.
 */
export async function handleSubscription<E extends Env>(
	c: Context<E>,
	lexicons: Lexicons,
	nsid: string,
	def: LexXrpcSubscription,
	config: HonoXRPCStreamConfig<E, any, any, unknown> | undefined,
	upgradeWebSocket: HonoXRPCOptions<E>["upgradeWebSocket"],
): Promise<Response> {
	if (c.req.method !== "GET") {
		c.header("Allow", "GET");
		throw new XRPCError(405 as ResponseType, `Incorrect HTTP method (${c.req.method}) expected GET`, "MethodNotAllowed");
	}
	if (!config) {
		throw new MethodNotImplementedError();
	}
	if (!upgradeWebSocket) {
		throw new MethodNotImplementedError("WebSockets are not supported by this server");
	}
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
		throw upgradeRequired(c);
	}
	const events = createStreamEvents(c, lexicons, nsid, def, config);
	const res = await upgradeWebSocket(() => events)(c, async () => {});
	if (!res) {
		throw upgradeRequired(c);
	}
	return res;
}

function upgradeRequired(c: Context): XRPCError {
	c.header("Upgrade", "websocket");
	return new XRPCError(426 as ResponseType, "A WebSocket upgrade is required", "UpgradeRequired");
}

function createStreamEvents<E extends Env>(
	c: Context<E>,
	lexicons: Lexicons,
	nsid: string,
	def: LexXrpcSubscription,
	config: HonoXRPCStreamConfig<E, any, any, unknown>,
): WSEvents {
	const ac = new AbortController();
	const { signal } = ac;

	async function* messages(): AsyncGenerator<Uint8Array> {
		const auth = config.auth ? excludeErrorResult(await config.auth({ ctx: c })) : undefined;
		const params = parseParams(c, lexicons, nsid, def);
		for await (const item of config.handler({ auth, params, signal, c })) {
			if (item instanceof ErrorFrame) throw item;
			const frame = item instanceof Frame ? item : toMessageFrame(lexicons, nsid, def, item);
			yield frame.toBytes();
		}
	}

	async function stream(ws: WSContext) {
		let error: ErrorFrame | undefined;
		try {
			for await (const bytes of messages()) {
				// leaving the loop also ends the handler's iterator
				if (signal.aborted || ws.readyState !== WS_OPEN) return;
				ws.send(bytes as Uint8Array<ArrayBuffer>);
			}
		} catch (err) {
			if (signal.aborted) return;
			error = ErrorFrame.fromError(err);
			if (!(err instanceof ErrorFrame) && XRPCError.fromError(err) instanceof InternalServerError) {
				// log trace for unhandled exceptions
				console.error(err, `unhandled exception in xrpc subscription ${nsid}`);
			}
		}
		if (ws.readyState !== WS_OPEN) return;
		try {
			if (error) {
				// streams are closed immediately after an error frame
				ws.send(error.toBytes() as Uint8Array<ArrayBuffer>);
				ws.close(CLOSE_POLICY, closeReason(error.code));
			} else {
				ws.close(CLOSE_NORMAL);
			}
		} catch (err) {
			console.error(err, `failed to close xrpc subscription ${nsid}`);
		}
	}

	return {
		onOpen(_evt, ws) {
			void stream(ws);
		},
		// frames received from the client are ignored
		onMessage() {},
		onClose() {
			ac.abort();
		},
	};
}

/** Validates a message yielded by the handler against the subscription's message schema. */
function toMessageFrame(lexicons: Lexicons, nsid: string, def: LexXrpcSubscription, item: unknown): MessageFrame<unknown> {
	if (typeof item !== "object" || item === null || Array.isArray(item)) {
		throw new InternalServerError("A message must be an object");
	}
	const value = item as Record<string, unknown>;
	// a short form `$type` (`#commit`) refers to the subscription's own Lexicon
	const message =
		typeof value.$type === "string" && value.$type.startsWith("#") ? { ...value, $type: `${nsid}${value.$type}` } : value;
	try {
		assertNoFloats(message, "Message");
		lexicons.assertValidXrpcMessage(nsid, message);
		assertSchemaConstraints(lexicons, def.message?.schema, message, "Message");
	} catch (e) {
		throw toInternalServerError(e);
	}
	return MessageFrame.fromLexValue(message, nsid);
}

/** A close reason is limited to 123 bytes. */
function closeReason(reason: string): string | undefined {
	return new TextEncoder().encode(reason).byteLength <= 123 ? reason : undefined;
}
