import type { Context, Env } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
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

export type HonoXRPCStreamContext<E extends Env, A extends AuthResult | undefined, P extends Params> = {
	auth: A;
	params: P;
	/** Aborted when the connection closes; pass it on to whatever produces the messages. */
	signal: AbortSignal;
	c: Context<E>;
};

/**
 * Yields the messages of an event stream (`$type`-tagged values of the subscription's message union), or `Frame`s.
 * Throwing (or yielding an `ErrorFrame`) ends the stream with an error frame.
 */
export type HonoXRPCStreamHandler<E extends Env, A extends AuthResult | undefined, P extends Params, O> = (
	ctx: HonoXRPCStreamContext<E, A, P>,
) => AsyncIterable<O>;

export type HonoXRPCStreamConfig<E extends Env, A extends AuthResult | ErrorResult | undefined, P extends Params, O> = {
	auth?: HonoAuthVerifier<E, A>;
	handler: HonoXRPCStreamHandler<E, Exclude<A, ErrorResult>, P, O>;
};

export type HonoStreamConfigOrHandler<E extends Env, A extends AuthResult | ErrorResult | undefined, P extends Params, O> =
	| HonoXRPCStreamConfig<E, A, P, O>
	| HonoXRPCStreamHandler<E, Exclude<A, ErrorResult>, P, O>;

export type RequestLocals = {
	auth: AuthResult | undefined;
	nsid: string;
};

export type HonoXRPCOptions<E extends Env> = {
	/**
	 * The WebSocket helper of the runtime (eg. `upgradeWebSocket` of `@hono/node-ws`, `hono/bun` or `hono/deno`),
	 * required to serve subscriptions. It must call `onOpen` once the connection is established.
	 */
	upgradeWebSocket?: UpgradeWebSocket<any, any, any>;
};
