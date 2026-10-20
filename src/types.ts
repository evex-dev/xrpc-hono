import type { Context, Env } from "hono";
import type { ErrorResult } from "./xrpc-server-errors.js";
import type { AuthResult, Awaitable, HandlerInput, Output, Params } from "./xrpc-server-types.js";

export type HonoAuthVerifierContext<E extends Env> = {
	ctx: Context<E>;
};

export type HonoAuthVerifier<E extends Env, A extends AuthResult | ErrorResult | undefined> = (
	ctx: HonoAuthVerifierContext<E>,
) => Awaitable<A>;

/**
 * `A` is the return type of the auth verifier (it may include `ErrorResult`).
 * The handler receives it without the `ErrorResult` branch.
 */
export type HonoXRPCHandlerConfig<
	E extends Env,
	A extends AuthResult | ErrorResult | undefined,
	P extends Params,
	I extends HandlerInput | undefined,
	O extends Output,
> = {
	auth?: HonoAuthVerifier<E, A>;
	handler: HonoXRPCHandler<E, Exclude<A, ErrorResult>, P, I, O>;
};

export type HonoXRPCHandler<
	E extends Env,
	A extends AuthResult | undefined,
	P extends Params,
	I extends HandlerInput | undefined,
	O extends Output,
> = (ctx: HonoXRPCReqContext<E, A, P, I>) => Awaitable<O>;

export type HonoXRPCReqContext<
	E extends Env,
	A extends AuthResult | undefined,
	P extends Params,
	I extends HandlerInput | undefined,
> = {
	auth: A;
	params: P;
	input: I;
	c: Context<E>;
};

export type HonoConfigOrHandler<
	E extends Env,
	A extends AuthResult | ErrorResult | undefined,
	P extends Params,
	I extends HandlerInput | undefined,
	O extends Output,
> = HonoXRPCHandlerConfig<E, A, P, I, O> | HonoXRPCHandler<E, Exclude<A, ErrorResult>, P, I, O>;

export type RequestLocals = {
	auth: AuthResult | undefined;
	nsid: string;
};

// biome-ignore lint/complexity/noBannedTypes: 今後拡張する
export type HonoXRPCOptions<E extends Env> = {};
