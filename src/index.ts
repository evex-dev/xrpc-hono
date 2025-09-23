import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { type LexiconDoc, Lexicons, lexToJson } from "@atproto/lexicon";
import { type Context, type Env, type Handler, Hono } from "hono";
import type { BlankEnv } from "hono/types";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HonoAuthVerifier, HonoXRPCHandler, HonoXRPCHandlerConfig, RequestLocals } from "./types.js";
import {
	InternalServerError,
	InvalidRequestError,
	isErrorResult,
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

const kRequestLocals = Symbol("requestLocals");

export interface XRPCHono<E extends Env = BlankEnv> {
	addMethod<
		P extends Params = Params,
		I extends HandlerInput | undefined = undefined,
		O extends Output = Output,
		A extends AuthResult | undefined = undefined,
	>(method: string, configOrFn: HonoXRPCHandlerConfig<E, A, P, I, O> | HonoXRPCHandler<E, A, P, I, O>): void;
	addLexicon(doc: LexiconDoc): void;
	addLexicons(docs: LexiconDoc[]): void;
	createApp(): Hono<E>;
}
/** Options is **NOT supported** (arguments are accepted for compatibility). */
export const createXRPCHono = <E extends Env = BlankEnv>(lexiconsSource: LexiconDoc[], _options?: unknown): XRPCHono<E> => {
	const methods = new Map<string, HonoXRPCHandlerConfig<E, any, any, any, any>>();
	const lexicons = new Lexicons(lexiconsSource);

	return {
		addMethod(method, configOrFn) {
			const config = typeof configOrFn === "function" ? { handler: configOrFn } : configOrFn;
			methods.set(method, config);
		},
		createApp() {
			const app = new Hono<E>();

			// 全てのリクエストに実行するバリデーションとか
			app.use("/xrpc/:methodId", (c, next) => {
				const methodId = c.req.param("methodId");
				const def = lexicons.getDef(methodId);
				if (!def) {
					throw new MethodNotImplementedError();
				}
				// validate method
				if (def.type === "query" && c.req.method !== "GET") {
					throw new InvalidRequestError(`Incorrect HTTP method (${c.req.method}) expected GET`);
				} else if (def.type === "procedure" && c.req.method !== "POST") {
					throw new InvalidRequestError(`Incorrect HTTP method (${c.req.method}) expected POST`);
				}
				return next();
			});
			// 各メソッドのハンドラを登録
			for (const lexicon of lexiconsSource) {
				const hdconfig = methods.get(lexicon.id);
				if (!hdconfig) {
					continue;
				}
				const middlwares: Handler[] = [];
				middlwares.push(createLocalsMiddleware(lexicon.id));
				if (hdconfig.auth) {
					middlwares.push(createAuthMiddleware(hdconfig.auth));
				}
				const def = lexicons.getDef(lexicon.id);
				if (!def) continue;
				const method = def.type === "procedure" ? "POST" : "GET";
				app[method === "GET" ? "get" : "post"](`/xrpc/${lexicon.id}`, ...middlwares, async (c) => {
					const encoding = c.req.header("Content-Type");
					let input: HandlerInput | undefined;
					if (encoding) {
						let body: unknown;
						if (encoding.startsWith("application/json")) {
							try {
								body = await c.req.json();
							} catch (e) {
								throw new InvalidRequestError(String(e));
							}
						} else if (encoding.startsWith("application/x-www-form-urlencoded")) {
							body = await c.req.formData();
						} else if (encoding.startsWith("text/")) {
							body = await c.req.text();
						} else {
							throw new InvalidRequestError(`Unsupported encoding: ${encoding}`);
						}
						input = { encoding, body };
						try {
							lexicons.assertValidXrpcInput(lexicon.id, body);
						} catch (e) {
							throw new InvalidRequestError(String(e));
						}
					} else if (def.type === "procedure") {
						throw new InvalidRequestError("Request encoding (Content-Type) required but not provided");
					}
					const params = c.req.query();
					try {
						lexicons.assertValidXrpcParams(lexicon.id, params);
					} catch (e) {
						throw new InvalidRequestError(String(e));
					}
					const output = await hdconfig.handler({
						//@ts-expect-error reqにkRequestLocalsはある
						auth: (c.req[kRequestLocals] as RequestLocals)?.auth,
						params,
						input,
						c,
					});
					if (!output) {
						lexicons.assertValidXrpcOutput(lexicon.id, output);
						return c.status(200);
					} else if (isHandlerPipeThroughStream(output)) {
						setHeaders(c, output);
						c.header("Content-Type", output.encoding);
						return c.body(readableToReadableStream(output.stream), 200);
					} else if (isHandlerPipeThroughBuffer(output)) {
						setHeaders(c, output);
						c.status(200);
						c.header("Content-Type", output.encoding);
						return c.body(Uint8Array.from(output.buffer).buffer);
					} else if (isErrorResult(output)) {
						throw XRPCError.fromError(output);
					} else {
						lexicons.assertValidXrpcOutput(lexicon.id, output.body);
						c.status(200);
						setHeaders(c, output);
						if (output.encoding === "application/json" || output.encoding === "json") {
							const json = lexToJson(output.body) as object;
							return c.json(json);
						} else if (output.body instanceof Readable) {
							c.header("Content-Type", output.encoding);
							return c.body(readableToReadableStream(output.body), 200);
						} else {
							c.header("Content-Type", output.encoding);
							return c.body(
								Buffer.isBuffer(output.body)
									? output.body
									: output.body instanceof Uint8Array
										? Buffer.from(output.body)
										: output.body,
							);
						}
					}
				});
			}

			app.onError((err, c) => {
				//@ts-expect-error reqにkRequestLocalsはある
				const locals: RequestLocals | undefined = c.req[kRequestLocals];
				const methodSuffix = locals ? ` method ${locals.nsid}` : "";
				const xrpcError = XRPCError.fromError(err);
				if (xrpcError instanceof InternalServerError) {
					// log trace for unhandled exceptions
					console.error(err, `unhandled exception in xrpc${methodSuffix}`);
				} else {
					// do not log trace for known xrpc errors
					// console.error(
					//   {
					//     status: xrpcError.type,
					//     message: xrpcError.message,
					//     name: xrpcError.customErrorName,
					//   },
					//   `error in xrpc${methodSuffix}`,
					// )
				}
				return c.json(xrpcError.payload, xrpcError.type as ContentfulStatusCode);
			});

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

function createLocalsMiddleware(nsid: string): Handler {
	return (c, next) => {
		const locals: RequestLocals = { auth: undefined, nsid }; //@ts-ignore reqにkRequestLocalsはある
		c.req[kRequestLocals] = locals;
		return next();
	};
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

function createAuthMiddleware<E extends Env, A extends AuthResult>(verifier: HonoAuthVerifier<E, A>): Handler {
	return async (ctx, next) => {
		const result = await verifier({ ctx });
		if (isErrorResult(result)) {
			throw XRPCError.fromErrorResult(result);
		} //@ts-ignore reqにkRequestLocalsはある
		const locals: RequestLocals = ctx.req[kRequestLocals]!;
		locals.auth = result;
		return next();
	};
}

export * from "./types.js";
export * from "./xrpc-server-errors.js";
export * from "./xrpc-server-types.js";
