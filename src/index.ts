import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { jsonToLex, type LexiconDoc, Lexicons, type LexXrpcProcedure, type LexXrpcQuery, lexToJson } from "@atproto/lexicon";
import { isValidNsid } from "@atproto/syntax";
import { type Context, type Env, Hono } from "hono";
import type { BlankEnv } from "hono/types";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HonoConfigOrHandler, HonoXRPCHandlerConfig, HonoXRPCOptions } from "./types.js";
import { acceptsAnyEncoding, assertNoFloats, assertSchemaConstraints, matchesEncoding, normalizeMime } from "./validation.js";
import {
	type ErrorResult,
	excludeErrorResult,
	InternalServerError,
	InvalidRequestError,
	MethodNotImplementedError,
	XRPCError,
} from "./xrpc-server-errors.js";
import {
	type AuthResult,
	type HandlerInput,
	type HandlerPipeThrough,
	type HandlerSuccess,
	isHandlerPipeThroughBuffer,
	isHandlerPipeThroughStream,
	type Output,
	type Params,
} from "./xrpc-server-types.js";

export interface XRPCHono<E extends Env = BlankEnv> {
	addMethod<
		P extends Params = Params,
		I extends HandlerInput | undefined = undefined,
		O extends Output = Output,
		A extends AuthResult | ErrorResult | undefined = undefined,
	>(method: string, configOrFn: HonoConfigOrHandler<E, A, P, I, O>): void;
	addLexicon(doc: LexiconDoc): void;
	addLexicons(docs: LexiconDoc[]): void;
	createApp(): Hono<E>;
}

type MethodDef = LexXrpcQuery | LexXrpcProcedure;

/** Options is **NOT supported** (arguments are accepted for compatibility). */
export const createXRPCHono = <E extends Env = BlankEnv>(
	lexiconsSource: LexiconDoc[],
	options?: HonoXRPCOptions<E>,
): XRPCHono<E> => {
	const methods = new Map<string, HonoXRPCHandlerConfig<E, any, any, any, any>>();
	const lexicons = new Lexicons(lexiconsSource);

	// Lexicons and methods are looked up per request, so anything added after createApp() is served too.
	async function dispatch(c: Context<E>, nsid: string): Promise<Response> {
		if (!isValidNsid(nsid)) {
			throw new InvalidRequestError("invalid xrpc path");
		}
		const def = lexicons.getDef(nsid);
		if (!def || (def.type !== "query" && def.type !== "procedure")) {
			// unknown NSIDs, non-endpoint definitions and (not yet supported) subscriptions
			throw new MethodNotImplementedError();
		}
		const expectedMethod = def.type === "procedure" ? "POST" : "GET";
		if (c.req.method !== expectedMethod && !(expectedMethod === "GET" && c.req.method === "HEAD")) {
			throw new InvalidRequestError(`Incorrect HTTP method (${c.req.method}) expected ${expectedMethod}`);
		}
		const config = methods.get(nsid);
		if (!config) {
			throw new MethodNotImplementedError();
		}

		const auth = config.auth ? excludeErrorResult(await config.auth({ ctx: c })) : undefined;
		const params = parseParams(c, nsid, def);
		const input = await parseInput(c, nsid, def);

		const output: Output | HandlerPipeThrough = await config.handler({ auth, params, input, c });

		if (output === undefined || output === null) {
			if (def.output) throw new InternalServerError("A response body is expected but none was provided");
			return c.body(null, 200);
		}
		if (isHandlerPipeThroughStream(output)) {
			setHeaders(c, output);
			c.header("Content-Type", output.encoding);
			return c.body(readableToReadableStream(output.stream), 200);
		}
		if (isHandlerPipeThroughBuffer(output)) {
			setHeaders(c, output);
			c.header("Content-Type", output.encoding);
			return c.body(Uint8Array.from(output.buffer), 200);
		}
		if (isHandlerSuccess(output)) {
			const mime = assertValidOutput(nsid, def, output);
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
		throw XRPCError.fromError(output);
	}

	function parseParams(c: Context<E>, nsid: string, def: MethodDef): Params {
		const searchParams = new URL(c.req.url).searchParams;
		const params: Params = {};
		for (const [key, prop] of Object.entries(def.parameters?.properties ?? {})) {
			// an empty value is treated as if the parameter was omitted
			const values = searchParams.getAll(key).filter((v) => v !== "");
			if (values.length === 0) continue;
			if (prop.type === "array") {
				params[key] = values.map((v) => decodeParam(prop.items.type, v));
			} else {
				// a repeated non-array parameter is left as an array so that validation rejects it
				params[key] = values.length === 1 ? decodeParam(prop.type, values[0]) : values;
			}
		}
		try {
			// the validated value has Lexicon `default`s applied
			const validated = (lexicons.assertValidXrpcParams(nsid, params) as Params | undefined) ?? params;
			assertSchemaConstraints(lexicons, def.parameters, validated, "Params");
			return validated;
		} catch (e) {
			throw new InvalidRequestError(errorMessage(e), undefined, { cause: e });
		}
	}

	async function parseInput(c: Context<E>, nsid: string, def: MethodDef): Promise<HandlerInput | undefined> {
		if (def.type !== "procedure") {
			return undefined;
		}
		if (!def.input) {
			// an empty body is tolerated
			if (c.req.raw.body !== null && (await c.req.arrayBuffer()).byteLength > 0) {
				throw new InvalidRequestError("A request body was provided when none was expected");
			}
			return undefined;
		}
		if (c.req.raw.body === null) {
			throw new InvalidRequestError("A request body is expected but none was provided");
		}
		const contentType = c.req.header("Content-Type");
		if (!contentType) {
			throw new InvalidRequestError("Request encoding (Content-Type) required but not provided");
		}
		const encoding = normalizeMime(contentType);
		if (!encoding || !matchesEncoding(def.input.encoding, encoding)) {
			throw new InvalidRequestError(`Wrong request encoding (Content-Type): ${contentType}`);
		}

		let body: unknown;
		if (acceptsAnyEncoding(def.input.encoding) || (encoding !== "application/json" && !encoding.startsWith("text/"))) {
			// binary bodies (and anything under `*/*`) are handed to the handler as a web ReadableStream
			return { encoding, body: c.req.raw.body };
		}
		if (encoding === "application/json") {
			try {
				body = JSON.parse(await c.req.text());
			} catch (e) {
				throw new InvalidRequestError(`Invalid JSON body: ${errorMessage(e)}`, undefined, { cause: e });
			}
		} else {
			body = await c.req.text();
		}

		if (def.input.schema) {
			try {
				assertNoFloats(body, "Input");
				body = lexicons.assertValidXrpcInput(nsid, jsonToLex(body as any));
				assertSchemaConstraints(lexicons, def.input.schema, body, "Input");
			} catch (e) {
				throw new InvalidRequestError(errorMessage(e), undefined, { cause: e });
			}
		}
		return { encoding, body };
	}

	/** Returns the normalized output media type. */
	function assertValidOutput(nsid: string, def: MethodDef, output: HandlerSuccess): string {
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
				throw new InternalServerError(errorMessage(e), undefined, { cause: e });
			}
		}
		return mime;
	}

	return {
		addMethod(method, configOrFn) {
			const config = typeof configOrFn === "function" ? { handler: configOrFn } : configOrFn;
			methods.set(method, config);
		},
		createApp() {
			const app = new Hono<E>();
			const handle = async (c: Context<E>, nsid: string) => {
				try {
					return await dispatch(c, nsid);
				} catch (err) {
					return errorResponse(c, err, nsid);
				}
			};
			app.all("/xrpc/:nsid", (c) => handle(c, c.req.param("nsid")));
			// any other path under the /xrpc/ prefix still gets an XRPC (JSON) error response
			app.all("/xrpc/*", (c) => handle(c, ""));
			return app;
		},
		addLexicon(doc: LexiconDoc) {
			lexicons.add(doc);
		},

		addLexicons(docs: LexiconDoc[]) {
			for (const doc of docs) {
				this.addLexicon(doc);
			}
		},
	};
};

/** Decode a query parameter string to its Lexicon type; anything malformed is left as-is for validation to reject. */
function decodeParam(type: string, value: string): string | number | boolean {
	if (type === "integer") return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
	if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;
	return value;
}

function isHandlerSuccess(output: unknown): output is HandlerSuccess {
	return typeof output === "object" && output !== null && typeof (output as HandlerSuccess).encoding === "string";
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function errorResponse(c: Context, err: unknown, nsid: string): Response {
	const xrpcError = XRPCError.fromError(err);
	if (xrpcError instanceof InternalServerError) {
		// log trace for unhandled exceptions
		console.error(err, `unhandled exception in xrpc method ${nsid}`);
	}
	return c.json(xrpcError.payload, xrpcError.statusCode as ContentfulStatusCode);
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

export * from "./types.js";
export * from "./xrpc-server-errors.js";
export * from "./xrpc-server-types.js";
