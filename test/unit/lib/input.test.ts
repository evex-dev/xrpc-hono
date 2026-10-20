import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it, vi } from "vitest";
import { expectXrpcError, lexicon, toBytes } from "../../helpers/xrpc.js";
import { build, okJson } from "./util.js";

const P = "io.example.input";
const CID_STR = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";

type Cap = { input?: any };

function setup(input: Record<string, unknown> | undefined) {
	const cap: Cap = {};
	const handler = vi.fn(({ input: i }: { input: unknown }) => {
		cap.input = i;
		return okJson();
	});
	const doc = lexicon(P, { type: "procedure", ...(input ? { input } : {}), output: { encoding: "application/json" } });
	const app = build([doc], { [P]: handler });
	const send = (body?: BodyInit, contentType?: string) =>
		app.request(`/xrpc/${P}`, { method: "POST", headers: contentType ? { "content-type": contentType } : {}, body });
	const sendJson = (value: unknown) => send(JSON.stringify(value), "application/json");
	return { cap, handler, send, sendJson };
}

const jsonInput = (schema: Record<string, unknown>) => ({ encoding: "application/json", schema });

const mainSchema = {
	type: "object",
	required: ["text"],
	nullable: ["nullableText"],
	properties: {
		text: { type: "string", maxLength: 10 },
		count: { type: "integer" },
		nullableText: { type: "string" },
		plainText: { type: "string" },
	},
};

async function rejected(t: ReturnType<typeof setup>, res: Response, status: number | number[] = 400) {
	await expectXrpcError(res, status);
	expect(t.handler).not.toHaveBeenCalled();
}

describe("JSON input", () => {
	it("passes a valid JSON body to the handler", async () => {
		const t = setup(jsonInput(mainSchema));
		const res = await t.sendJson({ text: "hi", count: 3 });
		expect(res.status).toBe(200);
		expect(t.cap.input.encoding).toBe("application/json");
		expect(t.cap.input.body).toStrictEqual({ text: "hi", count: 3 });
	});

	it("accepts Content-Type with a charset parameter", async () => {
		const t = setup(jsonInput(mainSchema));
		const res = await t.send(JSON.stringify({ text: "hi" }), "application/json; charset=utf-8");
		expect(res.status).toBe(200);
		// agreed behavior (same as @atproto/xrpc-server): the handler gets the media type without parameters
		expect(t.cap.input.encoding).toBe("application/json");
	});

	it("rejects a missing required property", async () => {
		const t = setup(jsonInput(mainSchema));
		await rejected(t, await t.sendJson({ count: 1 }));
	});

	it("rejects a wrong property type", async () => {
		const t = setup(jsonInput(mainSchema));
		await rejected(t, await t.sendJson({ text: 123 }));
	});

	it("rejects a float where an integer is expected", async () => {
		const t = setup(jsonInput(mainSchema));
		await rejected(t, await t.sendJson({ text: "a", count: 1.5 }));
	});

	it("rejects malformed JSON", async () => {
		const t = setup(jsonInput(mainSchema));
		await rejected(t, await t.send("{not json", "application/json"));
	});

	it("rejects a request with no body and no Content-Type when input is declared", async () => {
		const t = setup(jsonInput(mainSchema));
		await rejected(t, await t.send());
	});

	it("rejects a Content-Type that does not match the declared encoding", async () => {
		const t = setup(jsonInput(mainSchema));
		const res = await t.send(JSON.stringify({ text: "hi" }), "text/plain");
		await rejected(t, res, [400, 415]);
		expect(res.status).toBeLessThan(500);
	});

	it("ignores unexpected extra properties", async () => {
		const t = setup(jsonInput(mainSchema));
		expect((await t.sendJson({ text: "hi", extra: 1 })).status).toBe(200);
	});

	it("rejects null for a non-nullable property", async () => {
		const t = setup(jsonInput(mainSchema));
		await rejected(t, await t.sendJson({ text: "a", plainText: null }));
	});

	it("accepts null for a nullable property", async () => {
		const t = setup(jsonInput(mainSchema));
		expect((await t.sendJson({ text: "a", nullableText: null })).status).toBe(200);
	});

	it("maxLength counts UTF-8 bytes (9 bytes ok)", async () => {
		const t = setup(jsonInput(mainSchema));
		expect((await t.sendJson({ text: "あああ" })).status).toBe(200);
	});

	it("maxLength counts UTF-8 bytes (12 bytes rejected)", async () => {
		const t = setup(jsonInput(mainSchema));
		await rejected(t, await t.sendJson({ text: "ああああ" }));
	});

	it("accepts any JSON object when no schema is declared", async () => {
		const t = setup({ encoding: "application/json" });
		const res = await t.sendJson({ anything: [1, "two", { three: 3 }] });
		expect(res.status).toBe(200);
		expect(t.cap.input.body).toStrictEqual({ anything: [1, "two", { three: 3 }] });
	});

	it("passes undefined input to a procedure without input", async () => {
		const t = setup(undefined);
		const res = await t.send();
		expect(res.status).toBe(200);
		expect(t.handler).toHaveBeenCalledTimes(1);
		expect(t.cap.input).toBeUndefined();
	});

	it("accepts an empty body for a procedure without input", async () => {
		const t = setup(undefined);
		const res = await t.send("", "application/json");
		expect(res.status).toBe(200);
		expect(t.cap.input).toBeUndefined();
	});

	// user decision (same as @atproto/xrpc-server): a body for a procedure without input is rejected
	it("rejects a non-empty body for a procedure without input", async () => {
		const t = setup(undefined);
		await rejected(t, await t.send(JSON.stringify({ a: 1 }), "application/json"));
	});
});

describe("data model types in JSON input", () => {
	const bytesInput = (maxLength?: number) =>
		jsonInput({
			type: "object",
			properties: { data: { type: "bytes", ...(maxLength ? { maxLength } : {}) } },
		});

	it("decodes {$bytes} into a Uint8Array", async () => {
		const t = setup(bytesInput());
		const res = await t.sendJson({ data: { $bytes: "AQID" } });
		expect(res.status).toBe(200);
		expect(t.cap.input.body.data).toBeInstanceOf(Uint8Array);
		expect(Array.from(t.cap.input.body.data)).toStrictEqual([1, 2, 3]);
	});

	it("accepts unpadded base64 in {$bytes}", async () => {
		const t = setup(bytesInput());
		const res = await t.sendJson({ data: { $bytes: "AQIDBA" } });
		expect(res.status).toBe(200);
		expect(t.cap.input.body.data).toBeInstanceOf(Uint8Array);
		expect(Array.from(t.cap.input.body.data)).toStrictEqual([1, 2, 3, 4]);
	});

	it("enforces bytes maxLength", async () => {
		const t = setup(bytesInput(3));
		await rejected(t, await t.sendJson({ data: { $bytes: "AQIDBA" } }));
	});

	it("decodes {$link} into a CID", async () => {
		const t = setup(jsonInput({ type: "object", properties: { ref: { type: "cid-link" } } }));
		const res = await t.sendJson({ ref: { $link: CID_STR } });
		expect(res.status).toBe(200);
		const cid = CID.asCID(t.cap.input.body.ref);
		expect(cid).not.toBeNull();
		expect(cid?.toString()).toBe(CID_STR);
	});

	describe("blob", () => {
		const blobInput = () =>
			jsonInput({ type: "object", properties: { file: { type: "blob", accept: ["image/*"], maxSize: 1000 } } });
		const blob = async (over: Record<string, unknown> = {}) => {
			const cid = CID.create(1, 0x55, await sha256.digest(new Uint8Array([1, 2, 3])));
			return { file: { $type: "blob", ref: { $link: cid.toString() }, mimeType: "image/png", size: 100, ...over } };
		};

		it("accepts a matching blob ref", async () => {
			const t = setup(blobInput());
			expect((await t.sendJson(await blob())).status).toBe(200);
		});

		it("rejects a mimeType outside accept", async () => {
			const t = setup(blobInput());
			await rejected(t, await t.sendJson(await blob({ mimeType: "text/plain" })));
		});

		it("rejects a size above maxSize", async () => {
			const t = setup(blobInput());
			await rejected(t, await t.sendJson(await blob({ size: 2000 })));
		});
	});

	describe("unknown", () => {
		const unknownInput = () => jsonInput({ type: "object", properties: { meta: { type: "unknown" } } });

		it("accepts an object", async () => {
			const t = setup(unknownInput());
			expect((await t.sendJson({ meta: { a: 1 } })).status).toBe(200);
		});

		it("rejects a non-object at the top level", async () => {
			const t = setup(unknownInput());
			await rejected(t, await t.sendJson({ meta: "str" }));
		});

		it("rejects floats inside", async () => {
			const t = setup(unknownInput());
			await rejected(t, await t.sendJson({ meta: { a: 1.5 } }));
		});
	});
});

describe("unions", () => {
	const unionDoc = (closed: boolean) => {
		const cap: Cap = {};
		const handler = vi.fn(() => okJson());
		const doc = lexicon(
			P,
			{
				type: "procedure",
				input: {
					encoding: "application/json",
					schema: {
						type: "object",
						properties: { u: { type: "union", refs: ["#a", "#b"], ...(closed ? { closed: true } : {}) } },
					},
				},
				output: { encoding: "application/json" },
			},
			{
				a: { type: "object", properties: { x: { type: "string" } } },
				b: { type: "object", properties: { y: { type: "integer" } } },
			},
		);
		const app = build([doc], { [P]: handler });
		const send = (value: unknown) =>
			app.request(`/xrpc/${P}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(value),
			});
		return { cap, handler, send };
	};

	it("open union accepts a known variant with $type", async () => {
		const t = unionDoc(false);
		expect((await t.send({ u: { $type: `${P}#a`, x: "s" } })).status).toBe(200);
	});

	it("open union accepts an unknown $type", async () => {
		const t = unionDoc(false);
		expect((await t.send({ u: { $type: "com.example.other#thing", z: 1 } })).status).toBe(200);
	});

	it("open union rejects a variant object without $type", async () => {
		const t = unionDoc(false);
		await expectXrpcError(await t.send({ u: { x: "s" } }), 400);
		expect(t.handler).not.toHaveBeenCalled();
	});

	it("closed union rejects an unknown $type", async () => {
		const t = unionDoc(true);
		await expectXrpcError(await t.send({ u: { $type: "com.example.other#thing" } }), 400);
		expect(t.handler).not.toHaveBeenCalled();
	});
});

describe("binary input", () => {
	const bytes = new Uint8Array([0, 1, 2, 255]);

	it.each(["image/png", "application/octet-stream"])("accepts %s under encoding */*", async (ct) => {
		const t = setup({ encoding: "*/*" });
		const res = await t.send(bytes, ct);
		expect(res.status).toBe(200);
		expect(t.cap.input.encoding).toBe(ct);
		// user decision: binary bodies are handed over as a web ReadableStream
		expect(t.cap.input.body).toBeInstanceOf(ReadableStream);
		expect(Array.from(await toBytes(t.cap.input.body))).toStrictEqual(Array.from(bytes));
	});

	it("accepts image/jpeg under encoding image/*", async () => {
		const t = setup({ encoding: "image/*" });
		const res = await t.send(bytes, "image/jpeg");
		expect(res.status).toBe(200);
		expect(t.cap.input.body).toBeInstanceOf(ReadableStream);
		expect(Array.from(await toBytes(t.cap.input.body))).toStrictEqual(Array.from(bytes));
	});

	it("rejects text/plain under encoding image/*", async () => {
		const t = setup({ encoding: "image/*" });
		const res = await t.send("hello", "text/plain");
		await rejected(t, res, [400, 415]);
		expect(res.status).toBeLessThan(500);
	});
});

// lexicon spec "datetime": timezone is required, upper-case T, no "-00:00".
describe("datetime format in bodies", () => {
	const dtSchema = {
		type: "object",
		properties: {
			at: { type: "string", format: "datetime" },
			list: { type: "array", items: { type: "string", format: "datetime" } },
			nested: { type: "ref", ref: "#nested" },
		},
	};
	const setupDt = () => {
		const cap: Cap = {};
		const handler = vi.fn(({ input: i }: { input: unknown }) => {
			cap.input = i;
			return okJson();
		});
		const doc = lexicon(
			P,
			{ type: "procedure", input: jsonInput(dtSchema), output: { encoding: "application/json" } },
			{ nested: { type: "object", properties: { at: { type: "string", format: "datetime" } } } },
		);
		const app = build([doc], { [P]: handler });
		const sendJson = (value: unknown) =>
			app.request(`/xrpc/${P}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
		return { cap, handler, sendJson, send: sendJson as any };
	};

	it("accepts valid datetimes at every level", async () => {
		const t = setupDt();
		const res = await t.sendJson({
			at: "1985-04-12T23:20:50.123Z",
			list: ["1985-04-12T23:20:50Z", "1985-04-12T23:20:50.123-07:00"],
			nested: { at: "1985-04-12T23:20:50.123+00:00" },
		});
		expect(res.status).toBe(200);
	});

	it.each([
		["a direct property", { at: "1985-04-12T23:20:50.123" }],
		["an array item", { list: ["1985-04-12T23:20:50.123Z", "1985-04-12T23:20:50.123-00:00"] }],
		["a property of a referenced object", { nested: { at: "1985-04-12t23:20:50.123Z" } }],
	])("rejects an invalid datetime in %s", async (_, body) => {
		const t = setupDt();
		await rejected(t as any, await t.sendJson(body));
	});
});
