#!/usr/bin/env node

import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import yesno from "yesno";
import { genServerApi } from "./codegen/server.js";
import { applyFileDiff, genFileDiff, printFileDiff, readAllLexicons } from "./util.js";

const program = new Command();

program
	.name("gen-xrpc-hono")
	.description("Generate a TS server API with xrpc-hono")
	.option("--yes", "skip confirmation")
	.option(
		"--import-ext <ext>",
		'file extension of the relative imports in the generated files (e.g. ".ts"); use --import-ext "" for extension-less imports',
		toImportExt,
		".js",
	)
	.argument("<outdir>", "path of the directory to write to", toPath)
	.argument("<lexicons...>", "paths of the lexicon files to include", toPaths)
	.action(async (outDir: string, lexiconPaths: string[], o: { yes?: true; importExt: string }) => {
		const lexicons = readAllLexicons(lexiconPaths);
		const api = await genServerApi(lexicons, { importExt: o.importExt });
		const diff = genFileDiff(outDir, api);
		console.log("This will write the following files:");
		printFileDiff(diff);
		if (!o?.yes) await confirmOrExit();
		applyFileDiff(diff);
		console.log("API generated.");
	});

program.parse();

function toPath(v: string) {
	return v ? path.resolve(v) : undefined;
}

function toImportExt(v: string) {
	if (v !== "" && !/^\.[A-Za-z0-9]+$/.test(v)) {
		throw new InvalidArgumentError('expected an extension starting with "." (e.g. ".js" or ".ts"), or ""');
	}
	return v;
}

function toPaths(v: string, acc: string[]) {
	acc = acc || [];
	acc.push(path.resolve(v));
	return acc;
}

async function confirmOrExit() {
	const ok = await yesno({
		question: "Are you sure you want to continue? [y/N]",
		defaultValue: false,
	});
	if (!ok) {
		console.log("Aborted.");
		process.exit(0);
	}
}
