/**
 * @license
 * Copied from https://github.com/bluesky-social/atproto/blob/main/packages/xrpc-server/src/types.ts
 * MIT License
 * Copyright (c) 2022-2025 Bluesky Social PBC, and Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { Context, Env, Next } from "hono";
// import type { NextFunction, Request, Response } from "express";
// import { CalcKeyFn, CalcPointsFn, RateLimiterI } from "./rate-limiter";
import type { XRPCError } from "./xrpc-server-errors.js";

type ErrorResult = {
	status: number;
	message?: string;
	error?: string;
};

export type Awaitable<T> = T | Promise<T>;

export type CatchallHandler<E extends Env> = (c: Context<E>, next: Next) => unknown;

export type Options<E extends Env> = {
	validateResponse?: boolean;
	catchall?: CatchallHandler<E>;
	payload?: RouteOptions;
	// rateLimits?: {
	// 	creator: RateLimiterCreator<HandlerContext>;
	// 	global?: ServerRateLimitDescription<HandlerContext>[];
	// 	shared?: ServerRateLimitDescription<HandlerContext>[];
	// 	bypass?: (ctx: HandlerContext) => boolean;
	// };
	/**
	 * By default, errors are converted to {@link XRPCError} using
	 * {@link XRPCError.fromError} before being rendered. If method handlers throw
	 * error objects that are not properly rendered in the HTTP response, this
	 * function can be used to properly convert them to {@link XRPCError}. The
	 * provided function will typically fallback to the default error conversion
	 * (`return XRPCError.fromError(err)`) if the error is not recognized.
	 *
	 * @note This function should not throw errors.
	 */
	errorParser?: (err: unknown) => XRPCError;
};

// export type UndecodedParams = Request["query"];

export type Primitive = string | number | boolean;
export type Params = { [P in string]?: undefined | Primitive | Primitive[] };

export type HandlerInput = {
	encoding: string;
	body: unknown;
};

export type AuthResult = {
	credentials: unknown;
	artifacts?: unknown;
};

// export const headersSchema = z.record(z.string())

// export type Headers = z.infer<typeof headersSchema>
export type Headers = Record<string, string>;

// export const handlerSuccess = z.object({
//   encoding: z.string(),
//   body: z.any(),
//   headers: headersSchema.optional(),
// })

// export type HandlerSuccess = z.infer<typeof handlerSuccess>
export type HandlerSuccess = {
	encoding: string;
	body?: any;
	headers?: Headers;
};

// export const handlerPipeThroughBuffer = z.object({
//   encoding: z.string(),
//   buffer: z.instanceof(Buffer),
//   headers: headersSchema.optional(),
// })

// export type HandlerPipeThroughBuffer = z.infer<typeof handlerPipeThroughBuffer>
export type HandlerPipeThroughBuffer = {
	encoding: string;
	buffer: Buffer;
	headers?: Headers;
};

// export const handlerPipeThroughStream = z.object({
//   encoding: z.string(),
//   stream: z.instanceof(Readable),
//   headers: headersSchema.optional(),
// })

// export type HandlerPipeThroughStream = z.infer<typeof handlerPipeThroughStream>
export type HandlerPipeThroughStream = {
	encoding: string;
	stream: Readable;
	headers?: Headers;
};

// export const handlerPipeThrough = z.union([
//   handlerPipeThroughBuffer,
//   handlerPipeThroughStream,
// ])

// export type HandlerPipeThrough = z.infer<typeof handlerPipeThrough>
export type HandlerPipeThrough = HandlerPipeThroughBuffer | HandlerPipeThroughStream;

export type Auth = void | AuthResult;
export type Input = void | HandlerInput;
export type Output = void | HandlerSuccess | ErrorResult;

export type AuthVerifier<C, A extends AuthResult = AuthResult> =
	| ((ctx: C) => Awaitable<A | ErrorResult>)
	| ((ctx: C) => Awaitable<A>);

export type MethodAuthContext<P extends Params = Params> = {
	params: P;
	req: Request;
	res: Response;
};

export type MethodAuthVerifier<A extends AuthResult = AuthResult, P extends Params = Params> = AuthVerifier<
	MethodAuthContext<P>,
	A
>;

export type HandlerContext<A extends Auth = Auth, P extends Params = Params, I extends Input = Input> = MethodAuthContext<P> & {
	auth: A;
	input: I;
	resetRouteRateLimits: () => Promise<void>;
};

export type MethodHandler<
	A extends Auth = Auth,
	P extends Params = Params,
	I extends Input = Input,
	O extends Output = Output,
> = (ctx: HandlerContext<A, P, I>) => Awaitable<O | HandlerPipeThrough>;

// export type RateLimiterCreator<T extends HandlerContext = HandlerContext> = <
// 	C extends T = T,
// >(opts: {
// 	keyPrefix: string;
// 	durationMs: number;
// 	points: number;
// 	calcKey: CalcKeyFn<C>;
// 	calcPoints: CalcPointsFn<C>;
// 	failClosed?: boolean;
// }) => RateLimiterI<C>;

// export type ServerRateLimitDescription<
// 	C extends HandlerContext = HandlerContext,
// > = {
// 	name: string;
// 	durationMs: number;
// 	points: number;
// 	calcKey?: CalcKeyFn<C>;
// 	calcPoints?: CalcPointsFn<C>;
// 	failClosed?: boolean;
// };

// export type SharedRateLimitOpts<C extends HandlerContext = HandlerContext> = {
// 	name: string;
// 	calcKey?: CalcKeyFn<C>;
// 	calcPoints?: CalcPointsFn<C>;
// };

// export type RouteRateLimitOpts<C extends HandlerContext = HandlerContext> = {
// 	durationMs: number;
// 	points: number;
// 	calcKey?: CalcKeyFn<C>;
// 	calcPoints?: CalcPointsFn<C>;
// };

// export type RateLimitOpts<C extends HandlerContext = HandlerContext> =
// 	| SharedRateLimitOpts<C>
// 	| RouteRateLimitOpts<C>;

// export function isSharedRateLimitOpts<
// 	C extends HandlerContext = HandlerContext,
// >(opts: RateLimitOpts<C>): opts is SharedRateLimitOpts<C> {
// 	return typeof opts["name"] === "string";
// }

export type RouteOptions = {
	blobLimit?: number;
	jsonLimit?: number;
	textLimit?: number;
};

export type MethodConfig<A extends Auth = Auth, P extends Params = Params, I extends Input = Input, O extends Output = Output> = {
	handler: MethodHandler<A, P, I, O>;
	auth?: MethodAuthVerifier<Extract<A, AuthResult>, P>;
	opts?: RouteOptions;
	// rateLimit?:
	// 	| RateLimitOpts<HandlerContext<A, P, I>>
	// 	| RateLimitOpts<HandlerContext<A, P, I>>[];
};

export type MethodConfigOrHandler<
	A extends Auth = Auth,
	P extends Params = Params,
	I extends Input = Input,
	O extends Output = Output,
> = MethodHandler<A, P, I, O> | MethodConfig<A, P, I, O>;

export type StreamAuthContext<P extends Params = Params> = {
	params: P;
	req: IncomingMessage;
};

export type StreamAuthVerifier<A extends AuthResult = AuthResult, P extends Params = Params> = AuthVerifier<
	StreamAuthContext<P>,
	A
>;

export type StreamContext<A extends Auth = Auth, P extends Params = Params> = StreamAuthContext<P> & {
	auth: A;
	signal: AbortSignal;
};

export type StreamHandler<A extends Auth = Auth, P extends Params = Params, O = unknown> = (
	ctx: StreamContext<A, P>,
) => AsyncIterable<O>;

export type StreamConfig<A extends Auth = Auth, P extends Params = Params, O = unknown> = {
	auth?: StreamAuthVerifier<Extract<A, AuthResult>, P>;
	handler: StreamHandler<A, P, O>;
};

export type StreamConfigOrHandler<A extends Auth = Auth, P extends Params = Params, O = unknown> =
	| StreamHandler<A, P, O>
	| StreamConfig<A, P, O>;

export function isHandlerPipeThroughBuffer(output: Output): output is HandlerPipeThroughBuffer {
	// We only need to discriminate between possible Output values
	return output != null && "buffer" in output && output.buffer !== undefined;
}

export function isHandlerPipeThroughStream(output: Output): output is HandlerPipeThroughStream {
	// We only need to discriminate between possible Output values
	return output != null && "stream" in output && output.stream !== undefined;
}
