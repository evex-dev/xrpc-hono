import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { type Lexicons, lexToJson } from "@atproto/lexicon";
import type { Context, Env } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { MethodDef } from "./request.js";
import { toInternalServerError } from "./utils.js";
import { assertNoFloats, assertSchemaConstraints, matchesEncoding, normalizeMime } from "./validation.js";
import { InternalServerError, XRPCError } from "./xrpc-server-errors.js";
import {
	type HandlerPipeThrough,
	type HandlerPipeThroughBuffer,
	type HandlerPipeThroughStream,
	type HandlerSuccess,
	isHandlerPipeThroughBuffer,
	isHandlerPipeThroughStream,
	type Output,
} from "./xrpc-server-types.js";

/** Renders the value returned by a method handler as the HTTP response. */
export function renderOutput<E extends Env>(
	c: Context<E>,
	lexicons: Lexicons,
	nsid: string,
	def: MethodDef,
	output: Output | HandlerPipeThrough,
): Response {
	if (output === undefined || output === null) {
		if (def.output) throw new InternalServerError("A response body is expected but none was provided");
		return c.body(null, 200);
	}
	if (isHandlerPipeThroughStream(output)) {
		return renderPipeThroughStream(c, output);
	}
	if (isHandlerPipeThroughBuffer(output)) {
		return renderPipeThroughBuffer(c, output);
	}
	if (isHandlerSuccess(output)) {
		return renderHandlerSuccess(c, lexicons, nsid, def, output);
	}
	throw XRPCError.fromError(output);
}

/** Renders an error as an XRPC (JSON) error response. Unhandled exceptions are logged. */
export function errorResponse(c: Context, err: unknown, nsid: string): Response {
	const xrpcError = XRPCError.fromError(err);
	if (xrpcError instanceof InternalServerError) {
		// log trace for unhandled exceptions
		console.error(err, `unhandled exception in xrpc method ${nsid}`);
	}
	return c.json(xrpcError.payload, xrpcError.statusCode as ContentfulStatusCode);
}

function isHandlerSuccess(output: unknown): output is HandlerSuccess {
	return typeof output === "object" && output !== null && typeof (output as HandlerSuccess).encoding === "string";
}

function renderPipeThroughStream(c: Context, output: HandlerPipeThroughStream): Response {
	setHeaders(c, output);
	c.header("Content-Type", output.encoding);
	return c.body(readableToReadableStream(output.stream), 200);
}

function renderPipeThroughBuffer(c: Context, output: HandlerPipeThroughBuffer): Response {
	setHeaders(c, output);
	c.header("Content-Type", output.encoding);
	return c.body(Uint8Array.from(output.buffer), 200);
}

function renderHandlerSuccess(c: Context, lexicons: Lexicons, nsid: string, def: MethodDef, output: HandlerSuccess): Response {
	const mime = assertValidOutput(lexicons, nsid, def, output);
	setHeaders(c, output);
	if (output.body instanceof Readable || output.body instanceof ReadableStream) {
		c.header("Content-Type", output.encoding);
		return c.body(output.body instanceof Readable ? readableToReadableStream(output.body) : output.body, 200);
	}
	if (mime === "application/json") {
		return c.json(lexToJson(output.body) as object, 200);
	}
	c.header("Content-Type", output.encoding);
	return c.body(
		Buffer.isBuffer(output.body) ? output.body : output.body instanceof Uint8Array ? Buffer.from(output.body) : output.body,
		200,
	);
}

/** Returns the normalized output media type. */
function assertValidOutput(lexicons: Lexicons, nsid: string, def: MethodDef, output: HandlerSuccess): string {
	if (!def.output) {
		throw new InternalServerError("A response body was provided when none was expected");
	}
	const mime = output.encoding === "json" ? "application/json" : normalizeMime(output.encoding);
	if (!mime || !matchesEncoding(def.output.encoding, mime)) {
		throw new InternalServerError(`Invalid response encoding: ${output.encoding}`);
	}
	if (def.output.schema) {
		try {
			assertNoFloats(output.body, "Output");
			lexicons.assertValidXrpcOutput(nsid, output.body);
			assertSchemaConstraints(lexicons, def.output.schema, output.body, "Output");
		} catch (e) {
			throw toInternalServerError(e);
		}
	}
	return mime;
}

function setHeaders(c: Context, result: HandlerSuccess | HandlerPipeThrough) {
	const { headers }: { headers?: Record<string, string> } = result;
	if (headers) {
		for (const [name, val] of Object.entries(headers)) {
			if (val != null) c.header(name, val);
		}
	}
}

function readableToReadableStream(nodeReadable: Readable): ReadableStream {
	return new ReadableStream({
		start(controller) {
			nodeReadable.on("data", (chunk) => {
				controller.enqueue(chunk);
			});
			nodeReadable.on("end", () => {
				controller.close();
			});
			nodeReadable.on("error", (err) => {
				controller.error(err);
			});
		},
		cancel() {
			nodeReadable.destroy();
		},
	});
}
