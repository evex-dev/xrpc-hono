import { InternalServerError, InvalidRequestError } from "./xrpc-server-errors.js";

export function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Wraps a failure from request validation, keeping the original error as `cause`. */
export function toInvalidRequest(e: unknown): InvalidRequestError {
	return new InvalidRequestError(errorMessage(e), undefined, { cause: e });
}

/** Wraps a failure from response validation, keeping the original error as `cause`. */
export function toInternalServerError(e: unknown): InternalServerError {
	return new InternalServerError(errorMessage(e), undefined, { cause: e });
}
