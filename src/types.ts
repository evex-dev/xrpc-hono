import type { Context, Env } from "hono";
import type { AuthResult, Awaitable, HandlerInput, Output, Params } from "./xrpc-server-types.js";

type ErrorResult = {
	status: number;
	message?: string;
	error?: string;
};

export type HonoAuthVerifierContext<E extends Env> = {
	ctx: Context<E>;
};

export type HonoAuthVerifier<E extends Env, A extends AuthResult | undefined> = (
	ctx: HonoAuthVerifierContext<E>,
) => Awaitable<A | ErrorResult>;

export type HonoXRPCHandlerConfig<
	E extends Env,
	P extends Params,
	I extends HandlerInput | undefined,
	O extends Output,
	A extends AuthResult | undefined,
> = {
	auth?: HonoAuthVerifier<E, A>;
	handler: HonoXRPCHandler<E, P, I, O, A>;
};

export type HonoXRPCHandler<
	E extends Env,
	P extends Params,
	I extends HandlerInput | undefined,
	O extends Output,
	A extends AuthResult | undefined,
> = (ctx: HonoXRPCReqContext<E, P, I, A>) => Awaitable<O>;

export type HonoXRPCReqContext<
	E extends Env,
	P extends Params,
	I extends HandlerInput | undefined,
	A extends AuthResult | undefined,
> = {
	auth: A;
	params: P;
	input: I;
	c: Context<E>;
};
export type RequestLocals = {
	auth: AuthResult | undefined;
	nsid: string;
};
