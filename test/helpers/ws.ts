import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { decodeFirst } from "cborg";
import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { CID } from "multiformats/cid";

export type TestServer = {
	/** `http://127.0.0.1:<port>` */
	httpUrl: string;
	/** `ws://127.0.0.1:<port>` */
	wsUrl: string;
	close(): Promise<void>;
};

/**
 * Serves the app built by `build` on a random local port with WebSocket support (`@hono/node-ws`).
 * `build` receives the `upgradeWebSocket` helper to pass to `createXRPCHono`.
 */
export async function startServer(build: (upgradeWebSocket: UpgradeWebSocket<any, any, any>) => Hono<any>): Promise<TestServer> {
	const app = new Hono();
	const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
	app.route("/", build(upgradeWebSocket));
	const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
	});
	injectWebSocket(server);
	const { port } = server.address() as AddressInfo;
	return {
		httpUrl: `http://127.0.0.1:${port}`,
		wsUrl: `ws://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				(server as any).closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

/** DAG-CBOR decoding options: CIDs are tag 42 with a leading 0x00 byte (atproto.com/specs/data-model). */
const decodeOptions = {
	strict: true,
	allowIndefinite: false,
	allowUndefined: false,
	allowNaN: false,
	allowInfinity: false,
	rejectDuplicateMapKeys: true,
	tags: Object.assign([] as ((inner: any) => any)[], {
		42: (bytes: Uint8Array) => {
			if (bytes[0] !== 0) throw new Error("CID tag must start with 0x00");
			return CID.decode(bytes.subarray(1));
		},
	}),
};

export type DecodedFrame = {
	header: Record<string, unknown>;
	body: unknown;
	/** the raw frame */
	bytes: Uint8Array;
};

/** Splits a binary frame into its two concatenated CBOR objects (header, payload); throws on anything else. */
export function decodeFrame(bytes: Uint8Array): DecodedFrame {
	const [header, rest] = decodeFirst(bytes, decodeOptions);
	if (rest.byteLength === 0) throw new Error("frame has no payload");
	const [body, trailing] = decodeFirst(rest, decodeOptions);
	if (trailing.byteLength !== 0) throw new Error("frame has more than two CBOR objects");
	return { header, body, bytes };
}

export type ReceivedMessage = { binary: true; bytes: Uint8Array } | { binary: false; text: string };

export type Subscription = {
	ws: WebSocket;
	/** every message received so far, in order */
	received: ReceivedMessage[];
	/** resolves once the server accepted the upgrade */
	opened: Promise<void>;
	/** resolves when the connection is closed (by either side) */
	closed: Promise<{ code: number; reason: string; wasClean: boolean }>;
	/** resolves once at least `n` messages have been received (or the connection closed) */
	waitFor(n: number): Promise<ReceivedMessage[]>;
	/** the binary messages received so far, decoded */
	frames(): DecodedFrame[];
};

/** Opens a WebSocket to `<wsUrl>/xrpc/<nsid>?<query>` and records what the server sends. */
export function subscribe(wsUrl: string, nsid: string, query = "", init?: { protocols?: string[] }): Subscription {
	const ws = new WebSocket(`${wsUrl}/xrpc/${nsid}${query ? `?${query}` : ""}`, init?.protocols);
	ws.binaryType = "arraybuffer";
	const received: ReceivedMessage[] = [];
	const waiters: { n: number; resolve: () => void }[] = [];
	let isClosed = false;
	const notify = () => {
		for (const w of waiters.splice(0)) {
			if (isClosed || received.length >= w.n) w.resolve();
			else waiters.push(w);
		}
	};
	ws.addEventListener("message", (ev) => {
		received.push(
			typeof ev.data === "string"
				? { binary: false, text: ev.data }
				: { binary: true, bytes: new Uint8Array(ev.data as ArrayBuffer) },
		);
		notify();
	});
	const opened = new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
	});
	opened.catch(() => {});
	const closed = new Promise<{ code: number; reason: string; wasClean: boolean }>((resolve) => {
		ws.addEventListener("close", (ev) => {
			isClosed = true;
			notify();
			resolve({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
		});
	});
	return {
		ws,
		received,
		opened,
		closed,
		waitFor(n) {
			if (isClosed || received.length >= n) return Promise.resolve(received);
			return new Promise((resolve) => waiters.push({ n, resolve: () => resolve(received) }));
		},
		frames() {
			return received.flatMap((m) => (m.binary ? [decodeFrame(m.bytes)] : []));
		},
	};
}
