/**
 * @license
 * Adapted from https://github.com/bluesky-social/atproto/blob/main/packages/xrpc-server/src/stream/frames.ts
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

import { encode, type LexValue } from "@atproto/lex-cbor";
import { lexToIpld } from "@atproto/lexicon";
import { XRPCError } from "./xrpc-server-errors.js";

/** The `op` of an event stream frame header (atproto.com/specs/event-stream#framing). */
export enum FrameType {
	Message = 1,
	Error = -1,
}

export type MessageFrameHeader = { op: FrameType.Message; t?: string };
export type ErrorFrameHeader = { op: FrameType.Error };
export type ErrorFrameBody<T extends string = string> = { error: T; message?: string };

/** A WebSocket frame of an event stream: a header and a payload, each encoded as DRISL-CBOR. */
export abstract class Frame {
	abstract header: MessageFrameHeader | ErrorFrameHeader;
	abstract body: unknown;

	get op(): FrameType {
		return this.header.op;
	}

	toBytes(): Uint8Array {
		const header = encode(this.header as LexValue);
		// lex values (eg. BlobRef) are converted to their data model form
		const body = encode(lexToIpld(this.body as any) as LexValue);
		const bytes = new Uint8Array(header.byteLength + body.byteLength);
		bytes.set(header, 0);
		bytes.set(body, header.byteLength);
		return bytes;
	}

	isMessage(): this is MessageFrame<unknown> {
		return this.op === FrameType.Message;
	}

	isError(): this is ErrorFrame {
		return this.op === FrameType.Error;
	}
}

export class MessageFrame<T = Record<string, unknown>> extends Frame {
	header: MessageFrameHeader;
	body: T;

	constructor(body: T, opts?: { type?: string }) {
		super();
		this.header = opts?.type !== undefined ? { op: FrameType.Message, t: opts.type } : { op: FrameType.Message };
		this.body = body;
	}

	get type(): string | undefined {
		return this.header.t;
	}

	/**
	 * Builds a message frame from a `$type`-tagged message of the subscription `nsid`. The `$type` moves to the
	 * header, in short form (`#commit`) when it refers to the subscription's own Lexicon.
	 */
	static fromLexValue(data: unknown, nsid: string): MessageFrame<unknown> {
		if (typeof data !== "object" || data === null || Array.isArray(data)) {
			return new MessageFrame(data);
		}
		const { $type, ...body } = data as Record<string, unknown>;
		if (typeof $type !== "string") {
			return new MessageFrame(data);
		}
		const split = $type.split("#");
		const type = split.length === 2 && (split[0] === "" || split[0] === nsid) ? `#${split[1]}` : $type;
		return new MessageFrame(body, { type });
	}
}

export class ErrorFrame<T extends string = string> extends Frame {
	header: ErrorFrameHeader;
	body: ErrorFrameBody<T>;

	constructor(body: ErrorFrameBody<T>) {
		super();
		this.header = { op: FrameType.Error };
		this.body = body;
	}

	get code(): T {
		return this.body.error;
	}

	get message(): string | undefined {
		return this.body.message;
	}

	static fromError(err: unknown): ErrorFrame {
		if (err instanceof ErrorFrame) return err;
		const { error = "Unknown", message } = XRPCError.fromError(err).payload;
		return new ErrorFrame(message === undefined ? { error } : { error, message });
	}
}
