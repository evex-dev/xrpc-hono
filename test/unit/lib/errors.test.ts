import { describe, expect, it } from "vitest";
import {
	AuthRequiredError,
	ForbiddenError,
	InternalServerError,
	InvalidRequestError,
	MethodNotImplementedError,
	NotEnoughResourcesError,
	UpstreamFailureError,
	UpstreamTimeoutError,
	XRPCError,
} from "../../../src/index.js";
import { expectXrpcError, lexicon } from "../../helpers/xrpc.js";
import { build } from "./util.js";

const Q = "io.example.err";
const doc = lexicon(Q, {
	type: "query",
	output: { encoding: "application/json" },
	errors: [{ name: "HandleNotFound" }],
});
const call = (handler: unknown) => build([doc], { [Q]: handler }).request(`/xrpc/${Q}`);

describe("error responses", () => {
	it("returns a handler ErrorResult with the declared error name and message", async () => {
		const res = await call(() => ({ status: 400, error: "HandleNotFound", message: "no such handle" }));
		expect(await expectXrpcError(res, 400)).toStrictEqual({ error: "HandleNotFound", message: "no such handle" });
	});

	it("returns an ErrorResult with status 429", async () => {
		const res = await call(() => ({ status: 429, error: "RateLimitExceeded" }));
		const body = await expectXrpcError(res, 429);
		expect(body.error).toBe("RateLimitExceeded");
	});

	it("maps a thrown InvalidRequestError with a custom name", async () => {
		const res = await call(() => {
			throw new InvalidRequestError("bad thing", "CustomName");
		});
		expect(await expectXrpcError(res, 400)).toStrictEqual({ error: "CustomName", message: "bad thing" });
	});

	it.each([
		[InvalidRequestError, 400],
		[AuthRequiredError, 401],
		[ForbiddenError, 403],
		[InternalServerError, 500],
		[MethodNotImplementedError, 501],
		[UpstreamFailureError, 502],
		[NotEnoughResourcesError, 503],
		[UpstreamTimeoutError, 504],
	] as const)("thrown %o yields status %i in error format", async (Cls, status) => {
		const res = await call(() => {
			throw new Cls("x");
		});
		await expectXrpcError(res, status);
	});

	it("maps XRPCError(413, ...) to 413", async () => {
		const res = await call(() => {
			throw new XRPCError(413, "too big");
		});
		await expectXrpcError(res, 413);
	});

	it("maps XRPCError(429) to 429", async () => {
		const res = await call(() => {
			throw new XRPCError(429);
		});
		await expectXrpcError(res, 429);
	});

	it("maps a plain thrown Error to 500", async () => {
		await expectXrpcError(
			await call(() => {
				throw new Error("boom");
			}),
			500,
		);
	});

	it("maps a thrown non-Error value to 500", async () => {
		await expectXrpcError(
			await call(() => {
				throw "boom";
			}),
			500,
		);
	});

	it("maps a rejected async handler to 500", async () => {
		await expectXrpcError(await call(async () => Promise.reject(new Error("boom"))), 500);
	});
});
