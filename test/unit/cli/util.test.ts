import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFileDiff, genFileDiff, readAllLexicons } from "../../../src/cli/util.js";
import { lexicon } from "../../helpers/xrpc.js";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrpc-hono-"));
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string) {
	const p = path.join(dir, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, content);
	return p;
}

function writeLexicon(rel: string, id: string) {
	return write(rel, JSON.stringify(lexicon(id, { type: "query", output: { encoding: "application/json" } })));
}

describe("readAllLexicons", () => {
	it("returns parsed LexiconDocs for valid lexicon .json files", () => {
		const a = writeLexicon("a.json", "com.example.a");
		const b = writeLexicon("b.json", "com.example.b");
		const docs = readAllLexicons([a, b]);
		expect(docs.map((d) => d.id)).toEqual(["com.example.a", "com.example.b"]);
		expect(docs[0].lexicon).toBe(1);
	});

	it("skips non-.json paths, non-lexicon JSON, malformed JSON and invalid lexicons but keeps valid ones", () => {
		const good = writeLexicon("good.json", "com.example.good");
		const txt = write("note.txt", JSON.stringify(lexicon("com.example.txt", { type: "query" })));
		const notLex = write("foo.json", '{"foo":1}');
		const malformed = write("bad.json", "{not json");
		const invalid = write(
			"invalid.json",
			JSON.stringify({ lexicon: 1, id: "com.example.invalid", defs: { main: { type: "bogus" } } }),
		);
		const docs = readAllLexicons([txt, notLex, malformed, invalid, good]);
		expect(docs.map((d) => d.id)).toEqual(["com.example.good"]);
	});

	it("returns docs sorted by path regardless of argument order", () => {
		const a = writeLexicon("a.json", "com.example.a");
		const b = writeLexicon("b.json", "com.example.b");
		const c = writeLexicon("c.json", "com.example.c");
		const ids = (paths: string[]) => readAllLexicons(paths).map((d) => d.id);
		expect(ids([c, a, b])).toEqual(["com.example.a", "com.example.b", "com.example.c"]);
		expect(ids([b, c, a])).toEqual(ids([a, b, c]));
	});
});

describe("genFileDiff", () => {
	it("classifies files as add / mod / del, ignores non-.ts files, and uses absolute paths", () => {
		const out = path.join(dir, "out");
		write("out/existing.ts", "old");
		write("out/sub/stale.ts", "stale");
		write("out/readme.md", "keep me");
		const diff = genFileDiff(out, {
			files: [
				{ path: "/existing.ts", content: "new" },
				{ path: "/fresh.ts", content: "fresh" },
			],
		});
		const byPath = Object.fromEntries(diff.map((d) => [d.path, d.act]));
		expect(byPath).toEqual({
			[path.join(out, "existing.ts")]: "mod",
			[path.join(out, "fresh.ts")]: "add",
			[path.join(out, "sub/stale.ts")]: "del",
		});
		for (const d of diff) expect(path.isAbsolute(d.path)).toBe(true);
		expect(diff.some((d) => d.path.endsWith("readme.md"))).toBe(false);
	});

	it("treats every file as added when outDir does not exist", () => {
		const out = path.join(dir, "missing");
		const diff = genFileDiff(out, { files: [{ path: "/index.ts", content: "x" }] });
		expect(diff).toEqual([{ act: "add", path: path.join(out, "index.ts"), content: "x" }]);
	});
});

describe("applyFileDiff", () => {
	it("writes add/mod contents (creating parent dirs) and removes del files", () => {
		const added = path.join(dir, "deep/nested/dir/new.ts");
		const modded = path.join(dir, "mod.ts");
		const deleted = path.join(dir, "del.ts");
		fs.writeFileSync(modded, "old");
		fs.writeFileSync(deleted, "bye");
		applyFileDiff([
			{ act: "add", path: added, content: "added" },
			{ act: "mod", path: modded, content: "modified" },
			{ act: "del", path: deleted },
		]);
		expect(fs.readFileSync(added, "utf8")).toBe("added");
		expect(fs.readFileSync(modded, "utf8")).toBe("modified");
		expect(fs.existsSync(deleted)).toBe(false);
	});
});
