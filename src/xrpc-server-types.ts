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
import type { Readable } from "node:stream";
import type { ErrorResult } from "./xrpc-server-errors.js";

export type Awaitable<T> = T | Promise<T>;

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

export type Headers = Record<string, string>;

export type HandlerSuccess = {
	encoding: string;
	body?: any;
	headers?: Headers;
};

export type HandlerPipeThroughBuffer = {
	encoding: string;
	buffer: Buffer;
	headers?: Headers;
};

export type HandlerPipeThroughStream = {
	encoding: string;
	stream: Readable;
	headers?: Headers;
};

export type HandlerPipeThrough = HandlerPipeThroughBuffer | HandlerPipeThroughStream;

export type Auth = undefined | AuthResult;
export type Input = undefined | HandlerInput;
export type Output = undefined | HandlerSuccess | ErrorResult;

export function isHandlerPipeThroughBuffer(output: Output): output is HandlerPipeThroughBuffer {
	// We only need to discriminate between possible Output values
	return output != null && "buffer" in output && output.buffer !== undefined;
}

export function isHandlerPipeThroughStream(output: Output): output is HandlerPipeThroughStream {
	// We only need to discriminate between possible Output values
	return output != null && "stream" in output && output.stream !== undefined;
}
