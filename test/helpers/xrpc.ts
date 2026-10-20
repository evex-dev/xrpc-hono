import { Readable } from "node:stream";
import type { LexiconDoc } from "@atproto/lexicon";
import { expect } from "vitest";

/** Build a single-definition Lexicon document (`defs.main`), optionally with extra named defs. */
export function lexicon(id: string, main: Record<string, unknown>, defs: Record<string, unknown> = {}): LexiconDoc {
	return { lexicon: 1, id, defs: { main, ...defs } } as unknown as LexiconDoc;
}

/** Parse the media type part of a Content-Type header (drops parameters such as charset). */
export function mediaType(res: Response): string | undefined {
	return res.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
}

export type XrpcErrorBody = { error: string; message?: string };

/**
 * Asserts the XRPC error response format (atproto.com/specs/xrpc "Error Responses"):
 * - `Content-Type` is `application/json`
 * - payload is a JSON object with `error` (string, required, ASCII constant without whitespace)
 *   and optionally `message` (string)
 */
export async function expectXrpcError(res: Response, status?: number | number[]): Promise<XrpcErrorBody> {
	if (Array.isArray(status)) {
		expect(status).toContain(res.status);
	} else if (status !== undefined) {
		expect(res.status).toBe(status);
	} else {
		expect(res.status).toBeGreaterThanOrEqual(400);
	}
	expect(mediaType(res)).toBe("application/json");
	const body = (await res.json()) as unknown;
	expect(body).toBeTypeOf("object");
	expect(body).not.toBeNull();
	const { error, message } = body as Record<string, unknown>;
	expect(error).toBeTypeOf("string");
	expect(error).toMatch(/^[\x21-\x7e]+$/);
	if (message !== undefined) expect(message).toBeTypeOf("string");
	return body as XrpcErrorBody;
}

/** Collect a request/response body in whatever binary form a handler may have received it. */
export async function toBytes(body: unknown): Promise<Uint8Array> {
	if (body instanceof Uint8Array) return new Uint8Array(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
	if (body instanceof ReadableStream) return new Uint8Array(await new Response(body).arrayBuffer());
	if (body instanceof Readable) {
		const chunks: Buffer[] = [];
		for await (const chunk of body) chunks.push(Buffer.from(chunk));
		return new Uint8Array(Buffer.concat(chunks));
	}
	throw new TypeError(`not a binary body: ${Object.prototype.toString.call(body)}`);
}

/** Decode standard base64 (RFC 4648 section 4, padding optional) as used by `$bytes`. */
export function fromBase64(b64: string): Uint8Array {
	return new Uint8Array(Buffer.from(b64, "base64"));
}
