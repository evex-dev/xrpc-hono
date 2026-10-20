import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Build dist/ (the published entry point and the CLI binary) before the e2e tests run. */
export default function setup() {
	const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
	execFileSync(process.execPath, [tsc, "-p", root], { cwd: root, stdio: "inherit" });
}
