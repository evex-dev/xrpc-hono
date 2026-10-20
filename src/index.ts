import { type LexiconDoc, Lexicons } from "@atproto/lexicon";
import { type Context, type Env, Hono } from "hono";
import type { BlankEnv } from "hono/types";
import { assertHttpMethod, getMethodDef, parseInput, parseParams } from "./request.js";
import { errorResponse, renderOutput } from "./response.js";
import type { HonoConfigOrHandler, HonoXRPCHandlerConfig, HonoXRPCOptions } from "./types.js";
import { type ErrorResult, excludeErrorResult, MethodNotImplementedError } from "./xrpc-server-errors.js";
import type { AuthResult, HandlerInput, HandlerPipeThrough, Output, Params } from "./xrpc-server-types.js";

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

/** Options is **NOT supported** (arguments are accepted for compatibility). */
export const createXRPCHono = <E extends Env = BlankEnv>(
	lexiconsSource: LexiconDoc[],
	options?: HonoXRPCOptions<E>,
): XRPCHono<E> => {
	const methods = new Map<string, HonoXRPCHandlerConfig<E, any, any, any, any>>();
	const lexicons = new Lexicons(lexiconsSource);

	// Lexicons and methods are looked up per request, so anything added after createApp() is served too.
	async function dispatch(c: Context<E>, nsid: string): Promise<Response> {
		const def = getMethodDef(lexicons, nsid);
		assertHttpMethod(c, def);
		const config = methods.get(nsid);
		if (!config) {
			throw new MethodNotImplementedError();
		}

		const auth = config.auth ? excludeErrorResult(await config.auth({ ctx: c })) : undefined;
		const params = parseParams(c, lexicons, nsid, def);
		const input = await parseInput(c, lexicons, nsid, def);

		const output: Output | HandlerPipeThrough = await config.handler({ auth, params, input, c });
		return renderOutput(c, lexicons, nsid, def, output);
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

export * from "./types.js";
export * from "./xrpc-server-errors.js";
export * from "./xrpc-server-types.js";
