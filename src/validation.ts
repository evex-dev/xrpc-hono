import { BlobRef, type Lexicons, ValidationError } from "@atproto/lexicon";
import { isDatetimeString } from "@atproto/syntax";

/** Media type of a Content-Type value: lower-cased, without parameters such as `charset`. */
export function normalizeMime(value: string | null | undefined): string | undefined {
	const mime = value?.split(";")[0].trim().toLowerCase();
	return mime?.includes("/") ? mime : undefined;
}

/**
 * Whether `mime` is acceptable for a Lexicon body `encoding`, which may be an exact MIME type,
 * a comma-separated list, a `type/*` glob or `*\/*`.
 */
export function matchesEncoding(defEncoding: string, mime: string): boolean {
	return matchesMimePatterns(defEncoding.split(","), mime);
}

/** Whether a Lexicon body `encoding` accepts any MIME type (`*\/*`). */
export function acceptsAnyEncoding(defEncoding: string): boolean {
	return defEncoding.split(",").some((entry) => entry.trim() === "*/*");
}

function matchesMimePatterns(patterns: string[], mime: string): boolean {
	return patterns.some((entry) => {
		const allowed = entry.trim().toLowerCase();
		return allowed === "*/*" || allowed === mime || (allowed.endsWith("/*") && mime.startsWith(allowed.slice(0, -1)));
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** The atproto data model has no floats: reject any non-integer number, at any depth. */
export function assertNoFloats(value: unknown, path: string): void {
	if (typeof value === "number") {
		if (!Number.isInteger(value)) throw new ValidationError(`${path} must not be a float`);
	} else if (Array.isArray(value)) {
		for (const [i, item] of value.entries()) assertNoFloats(item, `${path}/${i}`);
	} else if (isPlainObject(value)) {
		for (const [key, item] of Object.entries(value)) assertNoFloats(item, `${path}/${key}`);
	}
}

type SchemaNode = { type: string; [key: string]: any };

// refs are stored as absolute `lex:` URIs once a doc is added to Lexicons; `$type` values are bare NSIDs
function normalizeRef(ref: string): string {
	const uri = ref.startsWith("lex:") ? ref : `lex:${ref}`;
	return uri.endsWith("#main") ? uri.slice(0, -"#main".length) : uri;
}

function getDef(lexicons: Lexicons, ref: string): SchemaNode | undefined {
	return (lexicons.getDef(ref) ?? lexicons.getDef(normalizeRef(ref))) as SchemaNode | undefined;
}

/**
 * Check the Lexicon constraints that `@atproto/lexicon` does not enforce, by walking an already-validated value
 * along its schema:
 * - `format: "datetime"` strictly (`@atproto/lexicon` is lenient, e.g. it accepts a missing timezone)
 * - `blob` `accept` and `maxSize`
 */
export function assertSchemaConstraints(lexicons: Lexicons, schema: SchemaNode | undefined, value: unknown, path: string): void {
	if (!schema || value === undefined || value === null) return;
	switch (schema.type) {
		case "string":
			if (schema.format === "datetime" && typeof value === "string" && !isDatetimeString(value)) {
				throw new ValidationError(`${path} must be an valid atproto datetime (both RFC-3339 and ISO-8601)`);
			}
			return;
		case "blob":
			if (value instanceof BlobRef) {
				if (schema.accept && !matchesMimePatterns(schema.accept, value.mimeType.toLowerCase())) {
					throw new ValidationError(`${path} mimeType ${value.mimeType} is not accepted (${schema.accept.join(", ")})`);
				}
				if (schema.maxSize !== undefined && value.size > schema.maxSize) {
					throw new ValidationError(`${path} size ${value.size} exceeds maxSize ${schema.maxSize}`);
				}
			}
			return;
		case "array":
			if (Array.isArray(value)) {
				for (const [i, item] of value.entries()) assertSchemaConstraints(lexicons, schema.items, item, `${path}/${i}`);
			}
			return;
		case "object":
		case "params":
			if (isPlainObject(value)) {
				for (const [key, prop] of Object.entries(schema.properties ?? {})) {
					assertSchemaConstraints(lexicons, prop as SchemaNode, value[key], `${path}/${key}`);
				}
			}
			return;
		case "record":
			assertSchemaConstraints(lexicons, schema.record, value, path);
			return;
		case "ref":
			assertSchemaConstraints(lexicons, getDef(lexicons, schema.ref), value, path);
			return;
		case "union": {
			if (!isPlainObject(value) || typeof value.$type !== "string") return;
			const $type = normalizeRef(value.$type);
			const ref = (schema.refs as string[]).find((r) => normalizeRef(r) === $type);
			if (ref) assertSchemaConstraints(lexicons, getDef(lexicons, ref), value, path);
			return;
		}
	}
}
