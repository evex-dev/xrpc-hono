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

const classes = [
	[InvalidRequestError, 400],
	[AuthRequiredError, 401],
	[ForbiddenError, 403],
	[InternalServerError, 500],
	[MethodNotImplementedError, 501],
	[UpstreamFailureError, 502],
	[NotEnoughResourcesError, 503],
	[UpstreamTimeoutError, 504],
] as const;

describe("error classes", () => {
	it.each(classes)("%o has the spec status %i and a well-formed payload", (Cls, status) => {
		const e = new Cls("msg");
		expect(e.statusCode).toBe(status);
		const { error, message } = e.payload;
		expect(error).toMatch(/^[\x21-\x7e]+$/);
		// the spec only requires `message` to be an optional string; its content for 500s is up to the server
		if (status === 500) {
			if (message !== undefined) expect(message).toBeTypeOf("string");
		} else {
			expect(message).toBe("msg");
		}
	});

	it("InvalidRequestError accepts a custom error name", () => {
		expect(new InvalidRequestError("msg", "CustomName").payload.error).toBe("CustomName");
	});

	it("XRPCError.fromError maps a plain Error to 500", () => {
		expect(XRPCError.fromError(new Error("x")).statusCode).toBe(500);
	});

	it("XRPCError.fromError maps an ErrorResult to its status", () => {
		expect(XRPCError.fromError({ status: 404, error: "NotFound" }).statusCode).toBe(404);
	});
});
