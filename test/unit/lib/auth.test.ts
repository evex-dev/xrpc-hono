import { describe, expect, it, vi } from "vitest";
import { AuthRequiredError, ForbiddenError } from "../../../src/index.js";
import { expectXrpcError } from "../../helpers/xrpc.js";
import { build, okJson, procDoc, queryDoc } from "./util.js";

const Q = "io.example.authq";
const P = "io.example.authp";

describe("auth", () => {
	it("passes { ctx } to the verifier and its result to the handler as auth", async () => {
		let seen: unknown;
		const verifier = vi.fn(({ ctx }: { ctx: { req: { header(n: string): string | undefined } } }) => {
			expect(ctx.req.header("authorization")).toBe("Bearer t");
			return { credentials: { did: "did:example:alice" } };
		});
		const app = build([queryDoc(Q)], {
			[Q]: {
				auth: verifier,
				handler: ({ auth }: { auth: unknown }) => {
					seen = auth;
					return okJson();
				},
			},
		});
		const res = await app.request(`/xrpc/${Q}`, { headers: { authorization: "Bearer t" } });
		expect(res.status).toBe(200);
		expect(verifier).toHaveBeenCalledTimes(1);
		expect(seen).toStrictEqual({ credentials: { did: "did:example:alice" } });
	});

	it("supports an async verifier", async () => {
		let seen: unknown;
		const app = build([queryDoc(Q)], {
			[Q]: {
				auth: async () => ({ credentials: { did: "did:example:alice" } }),
				handler: ({ auth }: { auth: unknown }) => {
					seen = auth;
					return okJson();
				},
			},
		});
		expect((await app.request(`/xrpc/${Q}`)).status).toBe(200);
		expect(seen).toStrictEqual({ credentials: { did: "did:example:alice" } });
	});

	it("rejects when the verifier returns an ErrorResult", async () => {
		const handler = vi.fn(okJson);
		const app = build([queryDoc(Q)], {
			[Q]: { auth: () => ({ status: 401, error: "AuthenticationRequired", message: "token required" }), handler },
		});
		const body = await expectXrpcError(await app.request(`/xrpc/${Q}`), 401);
		expect(body).toStrictEqual({ error: "AuthenticationRequired", message: "token required" });
		expect(handler).not.toHaveBeenCalled();
	});

	it.each([
		["AuthRequiredError", () => new AuthRequiredError("no"), 401],
		["ForbiddenError", () => new ForbiddenError("no"), 403],
		["plain Error", () => new Error("boom"), 500],
	] as const)("verifier throwing %s yields %i and skips the handler", async (_n, make, status) => {
		const handler = vi.fn(okJson);
		const app = build([queryDoc(Q)], {
			[Q]: {
				auth: () => {
					throw make();
				},
				handler,
			},
		});
		await expectXrpcError(await app.request(`/xrpc/${Q}`), status);
		expect(handler).not.toHaveBeenCalled();
	});

	it("passes auth undefined when no verifier is configured", async () => {
		let seen: unknown = "unset";
		const app = build([queryDoc(Q)], {
			[Q]: ({ auth }: { auth: unknown }) => {
				seen = auth;
				return okJson();
			},
		});
		expect((await app.request(`/xrpc/${Q}`)).status).toBe(200);
		expect(seen).toBeUndefined();
	});

	it("applies auth to procedures (POST)", async () => {
		const handler = vi.fn(okJson);
		const app = build([procDoc(P)], {
			[P]: {
				auth: () => {
					throw new AuthRequiredError("no");
				},
				handler,
			},
		});
		await expectXrpcError(await app.request(`/xrpc/${P}`, { method: "POST" }), 401);
		expect(handler).not.toHaveBeenCalled();
	});
});
