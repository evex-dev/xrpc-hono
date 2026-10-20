import type { LexiconDoc } from "@atproto/lexicon";
import { createXRPCHono } from "../../../src/index.js";
import { lexicon } from "../../helpers/xrpc.js";

export type AnyMethod = any;

/** Create a Hono app serving `docs` with the given handlers (nsid -> handler | config). */
export function build(docs: LexiconDoc[], methods: Record<string, AnyMethod> = {}) {
	const xrpc = createXRPCHono(docs);
	for (const [nsid, m] of Object.entries(methods)) xrpc.addMethod(nsid, m);
	return xrpc.createApp();
}

/** Query lexicon with schemaless JSON output. */
export function queryDoc(id: string, extra: Record<string, unknown> = {}): LexiconDoc {
	return lexicon(id, { type: "query", output: { encoding: "application/json" }, ...extra });
}

/** Procedure lexicon with schemaless JSON output. */
export function procDoc(id: string, extra: Record<string, unknown> = {}): LexiconDoc {
	return lexicon(id, { type: "procedure", output: { encoding: "application/json" }, ...extra });
}

export const okJson = () => ({ encoding: "application/json", body: {} });

export function post(path: string, body?: BodyInit, contentType?: string): [string, RequestInit] {
	const headers: Record<string, string> = {};
	if (contentType) headers["content-type"] = contentType;
	return [path, { method: "POST", headers, body }];
}
