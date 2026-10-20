import { describe, expect, it, vi } from "vitest";
import { expectXrpcError } from "../../helpers/xrpc.js";
import { build, okJson, procDoc, queryDoc } from "./util.js";

const Q = "io.example.params";

/** Build an app whose query declares `properties` (and `required`), capturing received params. */
function setup(properties: Record<string, unknown>, required: string[] = []) {
	const captured: { params?: Record<string, unknown> } = {};
	const handler = vi.fn(({ params }: { params: Record<string, unknown> }) => {
		captured.params = params;
		return okJson();
	});
	const doc = queryDoc(Q, { parameters: { type: "params", required, properties } });
	const app = build([doc], { [Q]: handler });
	const get = (qs: string | URLSearchParams) => app.request(`/xrpc/${Q}?${qs.toString()}`);
	return { captured, handler, get, app };
}

const qs = (entries: [string, string][]) => new URLSearchParams(entries);

describe("params decoding", () => {
	it("passes a string param", async () => {
		const t = setup({ str: { type: "string" } });
		expect((await t.get("str=hello")).status).toBe(200);
		expect(t.captured.params?.str).toBe("hello");
	});

	it.each([
		["10", 10],
		["-5", -5],
		["0", 0],
	])("decodes integer %s to a number", async (raw, expected) => {
		const t = setup({ int: { type: "integer" } });
		expect((await t.get(`int=${raw}`)).status).toBe(200);
		expect(t.captured.params?.int).toBe(expected);
	});

	it.each([
		["true", true],
		["false", false],
	])("decodes boolean %s to a boolean", async (raw, expected) => {
		const t = setup({ bool: { type: "boolean" } });
		expect((await t.get(`bool=${raw}`)).status).toBe(200);
		expect(t.captured.params?.bool).toBe(expected);
	});

	it("decodes repeated names into an array of strings", async () => {
		const t = setup({ strs: { type: "array", items: { type: "string" } } });
		expect((await t.get("strs=a&strs=b")).status).toBe(200);
		expect(t.captured.params?.strs).toStrictEqual(["a", "b"]);
	});

	it("decodes a single value of an array param into a one-element array", async () => {
		const t = setup({ strs: { type: "array", items: { type: "string" } } });
		expect((await t.get("strs=a")).status).toBe(200);
		expect(t.captured.params?.strs).toStrictEqual(["a"]);
	});

	it("decodes arrays of integers and booleans", async () => {
		const t = setup({
			ints: { type: "array", items: { type: "integer" } },
			bools: { type: "array", items: { type: "boolean" } },
		});
		expect((await t.get("ints=1&ints=2&bools=true&bools=false")).status).toBe(200);
		expect(t.captured.params?.ints).toStrictEqual([1, 2]);
		expect(t.captured.params?.bools).toStrictEqual([true, false]);
	});

	it("percent-decodes values", async () => {
		const t = setup({ str: { type: "string" } });
		expect((await t.get(qs([["str", "a b&c=あ"]]))).status).toBe(200);
		expect(t.captured.params?.str).toBe("a b&c=あ");
	});

	it("leaves an absent optional param undefined", async () => {
		const t = setup({ str: { type: "string" } });
		expect((await t.get("")).status).toBe(200);
		expect(t.captured.params?.str).toBeUndefined();
	});

	it("ignores unexpected extra query params", async () => {
		const t = setup({ str: { type: "string" } });
		expect((await t.get("other=1")).status).toBe(200);
		// agreed behavior (same as @atproto/xrpc-server): params not in the Lexicon are dropped
		expect(t.captured.params).not.toHaveProperty("other");
	});

	// user decision (same as @atproto/xrpc-server): Lexicon defaults are applied to omitted params
	it("applies Lexicon defaults to omitted params", async () => {
		const t = setup({
			int: { type: "integer", default: 50 },
			bool: { type: "boolean", default: false },
			str: { type: "string" },
		});
		expect((await t.get("str=x")).status).toBe(200);
		expect(t.captured.params).toStrictEqual({ int: 50, bool: false, str: "x" });
	});

	it("does not override a given param with its default", async () => {
		const t = setup({ int: { type: "integer", default: 50 } });
		expect((await t.get("int=3")).status).toBe(200);
		expect(t.captured.params?.int).toBe(3);
	});

	// agreed behavior (same as @atproto/xrpc-server): an empty value is treated as an omitted parameter
	it("treats an empty value as an omitted param", async () => {
		const t = setup({ int: { type: "integer" }, str: { type: "string" } });
		expect((await t.get("int=&str=")).status).toBe(200);
		expect(t.captured.params?.int).toBeUndefined();
		expect(t.captured.params?.str).toBeUndefined();
	});

	it("passes params on a procedure too", async () => {
		const captured: { params?: Record<string, unknown> } = {};
		const doc = procDoc(Q, { parameters: { type: "params", properties: { int: { type: "integer" } } } });
		const app = build([doc], {
			[Q]: ({ params }: { params: Record<string, unknown> }) => {
				captured.params = params;
				return okJson();
			},
		});
		const res = await app.request(`/xrpc/${Q}?int=5`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(captured.params?.int).toBe(5);
	});
});

describe("params validation", () => {
	async function expectRejected(t: ReturnType<typeof setup>, query: string | URLSearchParams) {
		const res = await t.get(query);
		await expectXrpcError(res, 400);
		expect(t.handler).not.toHaveBeenCalled();
	}

	it("rejects a missing required param", async () => {
		const t = setup({ str: { type: "string" } }, ["str"]);
		await expectRejected(t, "");
	});

	it("rejects a required param given only an empty value", async () => {
		const t = setup({ str: { type: "string" } }, ["str"]);
		await expectRejected(t, "str=");
	});

	it.each(["abc", "1.5"])("rejects non-integer value %s for an integer param", async (v) => {
		const t = setup({ int: { type: "integer" } });
		await expectRejected(t, `int=${v}`);
	});

	it.each([
		["0", 400],
		["101", 400],
		["1", 200],
		["100", 200],
	])("integer minimum 1 / maximum 100: %s -> %i", async (v, status) => {
		const t = setup({ int: { type: "integer", minimum: 1, maximum: 100 } });
		const res = await t.get(`int=${v}`);
		expect(res.status).toBe(status);
		if (status === 400) {
			await expectXrpcError(res, 400);
			expect(t.handler).not.toHaveBeenCalled();
		}
	});

	it.each([
		["4", 400],
		["2", 200],
	])("integer enum [1,2,3]: %s -> %i", async (v, status) => {
		const t = setup({ int: { type: "integer", enum: [1, 2, 3] } });
		const res = await t.get(`int=${v}`);
		expect(res.status).toBe(status);
		if (status === 400) await expectXrpcError(res, 400);
	});

	it.each([
		["abc", 200],
		["あ", 200],
		["あa", 400],
		["abcd", 400],
	])("string maxLength 3 counts UTF-8 bytes: %j -> %i", async (v, status) => {
		const t = setup({ str: { type: "string", maxLength: 3 } });
		const res = await t.get(qs([["str", v]]));
		expect(res.status).toBe(status);
		if (status === 400) await expectXrpcError(res, 400);
	});

	it.each([
		["a", 400],
		["é", 200],
	])("string minLength 2 counts UTF-8 bytes: %j -> %i", async (v, status) => {
		const t = setup({ str: { type: "string", minLength: 2 } });
		const res = await t.get(qs([["str", v]]));
		expect(res.status).toBe(status);
		if (status === 400) await expectXrpcError(res, 400);
	});

	it.each([
		["👨‍👩‍👧👍", 200],
		["abc", 400],
	])("string maxGraphemes 2: %j -> %i", async (v, status) => {
		const t = setup({ str: { type: "string", maxGraphemes: 2 } });
		const res = await t.get(qs([["str", v]]));
		expect(res.status).toBe(status);
		if (status === 400) await expectXrpcError(res, 400);
	});

	it("string minGraphemes 2 rejects a single grapheme cluster", async () => {
		const t = setup({ str: { type: "string", minGraphemes: 2 } });
		await expectRejected(t, qs([["str", "👨‍👩‍👧"]]));
	});

	it("string enum is a closed set", async () => {
		const t = setup({ str: { type: "string", enum: ["a", "b"] } });
		await expectRejected(t, "str=c");
	});

	it("string knownValues is not a closed set", async () => {
		const t = setup({ str: { type: "string", knownValues: ["a", "b"] } });
		expect((await t.get("str=c")).status).toBe(200);
	});

	it("array maxLength 2 rejects three values", async () => {
		const t = setup({ strs: { type: "array", items: { type: "string" }, maxLength: 2 } });
		await expectRejected(t, "strs=a&strs=b&strs=c");
	});

	it("array maxLength 2 accepts two values", async () => {
		const t = setup({ strs: { type: "array", items: { type: "string" }, maxLength: 2 } });
		expect((await t.get("strs=a&strs=b")).status).toBe(200);
	});

	it("rejects a non-integer element of an integer array", async () => {
		const t = setup({ ints: { type: "array", items: { type: "integer" } } });
		await expectRejected(t, "ints=1&ints=x");
	});
});

const formats: [string, string[], string[]][] = [
	["did", ["did:plc:ewvi7nxzyoun6zhxrhs64oiz", "did:web:example.com"], ["not-a-did"]],
	["handle", ["alice.example.com"], ["not a handle"]],
	["at-identifier", ["alice.example.com", "did:plc:ewvi7nxzyoun6zhxrhs64oiz"], ["not an identifier"]],
	["nsid", ["com.example.fooBar"], ["invalid"]],
	[
		"datetime",
		["1985-04-12T23:20:50.123Z", "1985-04-12T23:20:50Z", "1985-04-12T23:20:50.123-07:00", "1985-04-12T23:20:50.123+00:00"],
		[
			"1985-04-12",
			"1985-04-12T23:20:50.123",
			"1985-04-12t23:20:50.123Z",
			"1985-04-12T23:20:50.123-00:00",
			"1985-04-12 23:20:50.123Z",
		],
	],
	["at-uri", ["at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/com.example.record/3jui7kd54zh2y"], ["https://example.com"]],
	["cid", ["bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a"], ["notacid"]],
	["tid", ["3jzfcijpj2z2a"], ["invalid"]],
	["record-key", ["self"], [".."]],
	["uri", ["https://example.com/path"], ["not a uri"]],
	["language", ["ja", "pt-BR"], ["not a language!"]],
];

describe("params string formats", () => {
	describe.each(formats)("format %s", (format, valid, invalid) => {
		it.each(valid)("accepts %j", async (v) => {
			const t = setup({ str: { type: "string", format } });
			const res = await t.get(qs([["str", v]]));
			expect(res.status).toBe(200);
			expect(t.captured.params?.str).toBe(v);
		});

		it.each(invalid)("rejects %j", async (v) => {
			const t = setup({ str: { type: "string", format } });
			const res = await t.get(qs([["str", v]]));
			await expectXrpcError(res, 400);
			expect(t.handler).not.toHaveBeenCalled();
		});
	});
});
