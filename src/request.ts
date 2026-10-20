import { jsonToLex, type Lexicons, type LexXrpcProcedure, type LexXrpcQuery, type LexXrpcSubscription } from "@atproto/lexicon";
import { isValidNsid } from "@atproto/syntax";
import type { Context, Env } from "hono";
import { errorMessage, toInvalidRequest } from "./utils.js";
import { acceptsAnyEncoding, assertNoFloats, assertSchemaConstraints, matchesEncoding, normalizeMime } from "./validation.js";
import { InvalidRequestError, MethodNotImplementedError } from "./xrpc-server-errors.js";
import type { HandlerInput, Params } from "./xrpc-server-types.js";

export type MethodDef = LexXrpcQuery | LexXrpcProcedure;
export type EndpointDef = MethodDef | LexXrpcSubscription;

/** Resolves the Lexicon definition of the requested endpoint, which must be a query, a procedure or a subscription. */
export function getEndpointDef(lexicons: Lexicons, nsid: string): EndpointDef {
	if (!isValidNsid(nsid)) {
		throw new InvalidRequestError("invalid xrpc path");
	}
	const def = lexicons.getDef(nsid);
	if (!def || (def.type !== "query" && def.type !== "procedure" && def.type !== "subscription")) {
		// unknown NSIDs and non-endpoint definitions
		throw new MethodNotImplementedError();
	}
	return def;
}

/** Queries are served over GET (and HEAD), procedures over POST. */
export function assertHttpMethod(c: Context, def: MethodDef): void {
	const expectedMethod = def.type === "procedure" ? "POST" : "GET";
	if (c.req.method !== expectedMethod && !(expectedMethod === "GET" && c.req.method === "HEAD")) {
		throw new InvalidRequestError(`Incorrect HTTP method (${c.req.method}) expected ${expectedMethod}`);
	}
}

/** Decode a query parameter string to its Lexicon type; anything malformed is left as-is for validation to reject. */
function decodeParam(type: string, value: string): string | number | boolean {
	if (type === "integer") return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
	if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;
	return value;
}

/** Reads the query parameters declared by the Lexicon, decoded according to their types. */
function readQueryParams(c: Context, def: EndpointDef): Params {
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
	return params;
}

export function parseParams<E extends Env>(c: Context<E>, lexicons: Lexicons, nsid: string, def: EndpointDef): Params {
	const params = readQueryParams(c, def);
	try {
		// the validated value has Lexicon `default`s applied
		const validated = (lexicons.assertValidXrpcParams(nsid, params) as Params | undefined) ?? params;
		assertSchemaConstraints(lexicons, def.parameters, validated, "Params");
		return validated;
	} catch (e) {
		throw toInvalidRequest(e);
	}
}

export async function parseInput<E extends Env>(
	c: Context<E>,
	lexicons: Lexicons,
	nsid: string,
	def: MethodDef,
): Promise<HandlerInput | undefined> {
	if (def.type !== "procedure") {
		return undefined;
	}
	if (!def.input) {
		await assertNoInputBody(c);
		return undefined;
	}
	if (c.req.raw.body === null) {
		throw new InvalidRequestError("A request body is expected but none was provided");
	}
	const encoding = checkContentType(c, def.input.encoding);
	if (isStreamedEncoding(def.input.encoding, encoding)) {
		// binary bodies (and anything under `*/*`) are handed to the handler as a web ReadableStream
		return { encoding, body: c.req.raw.body };
	}

	let body = await readBody(c, encoding);
	if (def.input.schema) {
		body = validateInputBody(lexicons, nsid, def.input.schema, body);
	}
	return { encoding, body };
}

/** An empty body is tolerated when the method takes no input. */
async function assertNoInputBody(c: Context): Promise<void> {
	if (c.req.raw.body !== null && (await c.req.arrayBuffer()).byteLength > 0) {
		throw new InvalidRequestError("A request body was provided when none was expected");
	}
}

/** Checks the Content-Type header against the Lexicon input encoding and returns the normalized media type. */
function checkContentType(c: Context, defEncoding: string): string {
	const contentType = c.req.header("Content-Type");
	if (!contentType) {
		throw new InvalidRequestError("Request encoding (Content-Type) required but not provided");
	}
	const encoding = normalizeMime(contentType);
	if (!encoding || !matchesEncoding(defEncoding, encoding)) {
		throw new InvalidRequestError(`Wrong request encoding (Content-Type): ${contentType}`);
	}
	return encoding;
}

/** Whether the body is passed through untouched rather than decoded (see `parseInput`). */
function isStreamedEncoding(defEncoding: string, encoding: string): boolean {
	return acceptsAnyEncoding(defEncoding) || (encoding !== "application/json" && !encoding.startsWith("text/"));
}

/** Reads a JSON body (parsed) or any other body as text. */
async function readBody(c: Context, encoding: string): Promise<unknown> {
	if (encoding !== "application/json") {
		return c.req.text();
	}
	try {
		return JSON.parse(await c.req.text());
	} catch (e) {
		throw new InvalidRequestError(`Invalid JSON body: ${errorMessage(e)}`, undefined, { cause: e });
	}
}

/** Validates the body against the Lexicon input schema, returning the value with Lexicon types applied. */
function validateInputBody(
	lexicons: Lexicons,
	nsid: string,
	schema: NonNullable<LexXrpcProcedure["input"]>["schema"],
	body: unknown,
): unknown {
	try {
		assertNoFloats(body, "Input");
		const validated = lexicons.assertValidXrpcInput(nsid, jsonToLex(body as any));
		assertSchemaConstraints(lexicons, schema, validated, "Input");
		return validated;
	} catch (e) {
		throw toInvalidRequest(e);
	}
}
