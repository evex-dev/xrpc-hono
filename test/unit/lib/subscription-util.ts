import type { LexiconDoc } from "@atproto/lexicon";
import type { Hono } from "hono";
import { createXRPCHono, type XRPCHono } from "../../../src/index.js";
import { type DecodedFrame, type Subscription, startServer, subscribe, type TestServer } from "../../helpers/ws.js";

export const SUB = "io.example.sub";
export const STRICT = "io.example.strict";
export const NO_HANDLER = "io.example.nohandler";
export const DEFS = "io.example.defs";

/** A subscription whose message is a closed union (atproto.com/specs/lexicon "Subscription (Event Stream)"). */
export const subDoc: LexiconDoc = {
	lexicon: 1,
	id: SUB,
	defs: {
		main: {
			type: "subscription",
			parameters: {
				type: "params",
				properties: {
					cursor: { type: "integer" },
					limit: { type: "integer", default: 5, minimum: 1, maximum: 10 },
					flag: { type: "boolean" },
					tags: { type: "array", items: { type: "string" } },
					name: { type: "string" },
				},
			},
			message: { schema: { type: "union", closed: true, refs: ["#info", "#event", `${DEFS}#thing`] } },
			errors: [{ name: "FutureCursor" }, { name: "ConsumerTooSlow" }],
		},
		info: { type: "object", required: ["name"], properties: { name: { type: "string" }, message: { type: "string" } } },
		event: {
			type: "object",
			required: ["seq"],
			properties: {
				seq: { type: "integer", minimum: 1 },
				text: { type: "string" },
				a: { type: "string" },
				long_key_name_here: { type: "string" },
				link: { type: "cid-link" },
				data: { type: "bytes" },
				thumb: { type: "blob", accept: ["image/*"], maxSize: 100 },
				when: { type: "string", format: "datetime" },
				extra: { type: "unknown" },
			},
		},
	},
} as unknown as LexiconDoc;

export const defsDoc: LexiconDoc = {
	lexicon: 1,
	id: DEFS,
	defs: { thing: { type: "object", required: ["v"], properties: { v: { type: "string" } } } },
} as unknown as LexiconDoc;

export const strictDoc: LexiconDoc = {
	lexicon: 1,
	id: STRICT,
	defs: {
		main: {
			type: "subscription",
			parameters: { type: "params", required: ["topic"], properties: { topic: { type: "string" } } },
			message: { schema: { type: "union", closed: true, refs: [`${SUB}#info`] } },
		},
	},
} as unknown as LexiconDoc;

export const noHandlerDoc: LexiconDoc = {
	lexicon: 1,
	id: NO_HANDLER,
	defs: { main: { type: "subscription", message: { schema: { type: "union", refs: [`${SUB}#info`] } } } },
} as unknown as LexiconDoc;

export const docs: LexiconDoc[] = [subDoc, defsDoc, strictDoc, noHandlerDoc];

export type StreamCtx = { auth: any; params: Record<string, any>; signal: AbortSignal; c: any };

export type SubServer = { xrpc: XRPCHono<any>; server: TestServer };

/** Serves the test subscriptions; handlers are (re)registered per test with `register`. */
export async function startSubServer(wrap?: (app: Hono<any>) => Hono<any>): Promise<SubServer> {
	let xrpc!: XRPCHono<any>;
	const server = await startServer((upgradeWebSocket) => {
		xrpc = createXRPCHono(docs, { upgradeWebSocket });
		const app = xrpc.createApp();
		return wrap ? wrap(app) : app;
	});
	return { xrpc, server };
}

export function register(s: SubServer, handlerOrConfig: unknown, nsid = SUB) {
	s.xrpc.addStreamMethod(nsid, handlerOrConfig as any);
}

export type Collected = { sub: Subscription; frames: DecodedFrame[]; close: { code: number; reason: string } };

/** Subscribes, waits for the connection to close and returns everything that was received. */
export async function collect(s: SubServer, query = "", nsid = SUB): Promise<Collected> {
	const sub = subscribe(s.server.wsUrl, nsid, query);
	const close = await sub.closed;
	return { sub, frames: sub.frames(), close };
}

export function deferred<T = void>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export const ev = (seq: number, extra: Record<string, unknown> = {}) => ({ $type: "#event", seq, ...extra });
