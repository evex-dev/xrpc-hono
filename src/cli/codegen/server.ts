import { type LexiconDoc, Lexicons } from "@atproto/lexicon";
import { NSID } from "@atproto/syntax";
import { IndentationText, Project, type SourceFile, VariableDeclarationKind } from "ts-morph";
import type { GeneratedAPI } from "../types.js";
import { gen, lexiconsTs, utilTs } from "./common.js";
import { genCommonImports, genImports, genRecord, genUserType, genXrpcInput, genXrpcOutput, genXrpcParams } from "./lex-gen.js";
import {
	type DefTreeNode,
	EnvTypeParameter,
	lexiconsToDefTree,
	schemasToNsidTokens,
	toCamelCase,
	toScreamingSnakeCase,
	toTitleCase,
} from "./util.js";

export async function genServerApi(lexiconDocs: LexiconDoc[], skipSub: boolean): Promise<GeneratedAPI> {
	const project = new Project({
		useInMemoryFileSystem: true,
		manipulationSettings: { indentationText: IndentationText.TwoSpaces },
	});
	const api: GeneratedAPI = { files: [] };
	const lexicons = new Lexicons(lexiconDocs);
	const nsidTree = lexiconsToDefTree(lexiconDocs);
	const nsidTokens = schemasToNsidTokens(lexiconDocs);
	for (const lexiconDoc of lexiconDocs) {
		api.files.push(await lexiconTs(project, lexicons, lexiconDoc));
	}
	api.files.push(await utilTs(project));
	api.files.push(await lexiconsTs(project, lexiconDocs));
	api.files.push(await indexTs(project, lexiconDocs, nsidTree, nsidTokens, skipSub));
	return api;
}

const indexTs = (
	project: Project,
	lexiconDocs: LexiconDoc[],
	nsidTree: DefTreeNode[],
	nsidTokens: Record<string, string[]>,
	skipSub: boolean,
) =>
	gen(project, "/index.ts", async (file) => {
		//= import {createServer as createXrpcServer, Server as XrpcServer} from '@atproto/xrpc-server'
		file.addImportDeclaration({
			moduleSpecifier: "@evex-dev/xrpc-hono",
			namedImports: [
				{ name: "Auth", isTypeOnly: true },
				{ name: "XRPCHono", alias: "XrpcServer" },
				// { name: "StreamConfigOrHandler", isTypeOnly: true },
				{ name: "HonoConfigOrHandler", isTypeOnly: true },
				{ name: "createXRPCHono", alias: "createXrpcServer" },
			],
		});
		file.addImportDeclaration({ moduleSpecifier: "hono", namedImports: [{ name: "Env", isTypeOnly: true }] });
		//= import {schemas} from './lexicons.js'
		file
			.addImportDeclaration({
				moduleSpecifier: "./lexicons.js",
			})
			.addNamedImport({
				name: "schemas",
			});

		// generate type imports
		for (const lexiconDoc of lexiconDocs) {
			if (
				lexiconDoc.defs.main?.type !== "query" &&
				lexiconDoc.defs.main?.type !== "subscription" &&
				lexiconDoc.defs.main?.type !== "procedure"
			) {
				continue;
			}
			file
				.addImportDeclaration({
					moduleSpecifier: `./types/${lexiconDoc.id.split(".").join("/")}.js`,
				})
				.setNamespaceImport(toTitleCase(lexiconDoc.id));
		}

		// generate token enums
		for (const nsidAuthority in nsidTokens) {
			// export const {THE_AUTHORITY} = {
			//  {Name}: "{authority.the.name}"
			// }
			file.addVariableStatement({
				isExported: true,
				declarationKind: VariableDeclarationKind.Const,
				declarations: [
					{
						name: toScreamingSnakeCase(nsidAuthority),
						initializer: [
							"{",
							...nsidTokens[nsidAuthority].map((nsidName) => `${toTitleCase(nsidName)}: "${nsidAuthority}.${nsidName}",`),
							"}",
						].join("\n"),
					},
				],
			});
		}

		//= export function createServer(options?: XrpcOptions) { ... }
		const createServerFn = file.addFunction({
			name: "createServer",
			returnType: "Server<E>",
			isExported: true,
			typeParameters: [{ name: "E", constraint: "Env", default: "Env" }],
		});
		createServerFn.setBodyText(`return new Server<E>(options)`);

		//= export class Server {...}
		const serverCls = file.addClass({
			name: "Server",
			isExported: true,
			typeParameters: [EnvTypeParameter],
		});
		//= xrpc: XrpcServer = createXrpcServer(methodSchemas)
		serverCls.addProperty({
			name: "xrpc",
			type: "XrpcServer<E>",
		});

		// generate classes for the schemas
		for (const ns of nsidTree) {
			//= ns: NS
			serverCls.addProperty({
				name: ns.propName,
				type: `${ns.className}<E>`,
			});

			// class...
			genNamespaceCls(file, ns, skipSub);
		}

		//= constructor (options?: XrpcOptions) {
		//=  this.xrpc = createXrpcServer(schemas, options)
		//=  {namespace declarations}
		//= }
		serverCls
			.addConstructor()
			.setBodyText(
				[
					"this.xrpc = createXrpcServer(schemas)",
					...nsidTree.map((ns) => `this.${ns.propName} = new ${ns.className}<E>(this)`),
				].join("\n"),
			);
	});

function genNamespaceCls(file: SourceFile, ns: DefTreeNode, skipSub: boolean) {
	//= export class {ns}NS<E extends Env> {...}
	const cls = file.addClass({
		name: ns.className,
		isExported: true,
		typeParameters: [EnvTypeParameter],
	});
	//= _server: Server<E>
	cls.addProperty({
		name: "_server",
		type: "Server<E>",
	});

	for (const child of ns.children) {
		//= child: ChildNS
		cls.addProperty({
			name: child.propName,
			type: `${child.className}<E>`,
		});

		// recurse
		genNamespaceCls(file, child, skipSub);
	}

	//= constructor(server: Server) {
	//=  this._server = server
	//=  {child namespace declarations}
	//= }
	const cons = cls.addConstructor();
	cons.addParameter({
		name: "server",
		type: "Server<E>",
	});
	cons.setBodyText(
		[`this._server = server`, ...ns.children.map((ns) => `this.${ns.propName} = new ${ns.className}<E>(server)`)].join("\n"),
	);

	// methods
	for (const userType of ns.userTypes) {
		if (userType.def.type !== "query" && userType.def.type !== "subscription" && userType.def.type !== "procedure") {
			continue;
		}
		const moduleName = toTitleCase(userType.nsid);
		const name = toCamelCase(NSID.parse(userType.nsid).name || "");
		const isSubscription = userType.def.type === "subscription";
		if (isSubscription && skipSub) continue;
		const method = cls.addMethod({
			name,
			typeParameters: [
				{
					name: "A",
					constraint: "Auth",
					default: "void",
				},
			],
		});
		if (isSubscription)
			throw new Error(
				"Subscriptions are not supported yet. Contributions are welcome: https://github.com/evex-dev/xrpc-hono/ \nTo skip subscription methods during generation, use the --skip-sub option.",
			);
		method.addParameter({
			name: "cfg",
			type: /*isSubscription
				? `StreamConfigOrHandler<
        	  A,
        	  ${moduleName}.QueryParams,
        	  ${moduleName}.HandlerOutput,
        >`
				:*/ `HonoConfigOrHandler<
		  E,
          A,
          ${moduleName}.QueryParams,
          ${moduleName}.HandlerInput,
          ${moduleName}.HandlerOutput,
        >`,
		});
		const methodType = /*isSubscription ? "streamMethod" :*/ "addMethod";
		method.setBodyText(
			[
				`const nsid = '${userType.nsid}'`,
				`return this._server.xrpc.${methodType}(nsid, cfg)`,
			].join("\n"),
		);
	}
}

const lexiconTs = (project: Project, lexicons: Lexicons, lexiconDoc: LexiconDoc) =>
	gen(project, `/types/${lexiconDoc.id.split(".").join("/")}.ts`, async (file) => {
		const main = lexiconDoc.defs.main;
		if (main?.type === "query" || main?.type === "procedure") {
			const streamingInput = main?.type === "procedure" && main.input?.encoding && !main.input.schema;
			const streamingOutput = main.output?.encoding && !main.output.schema;
			if (streamingInput || streamingOutput) {
				//= import stream from 'node:stream'
				file.addImportDeclaration({
					moduleSpecifier: "node:stream",
					defaultImport: "stream",
				});
			}
		}

		genCommonImports(file, lexiconDoc.id);

		const imports: Set<string> = new Set();
		for (const defId in lexiconDoc.defs) {
			const def = lexiconDoc.defs[defId];
			const lexUri = `${lexiconDoc.id}#${defId}`;
			if (defId === "main") {
				if (def.type === "query" || def.type === "procedure") {
					genXrpcParams(file, lexicons, lexUri);
					genXrpcInput(file, imports, lexicons, lexUri);
					genXrpcOutput(file, imports, lexicons, lexUri, false);
					genServerXrpcMethod(file, lexicons, lexUri);
				} else if (def.type === "subscription") {
					genXrpcParams(file, lexicons, lexUri);
					genXrpcOutput(file, imports, lexicons, lexUri, false);
					genServerXrpcStreaming(file, lexicons, lexUri);
				} else if (def.type === "record") {
					genRecord(file, imports, lexicons, lexUri);
				} else {
					genUserType(file, imports, lexicons, lexUri);
				}
			} else {
				genUserType(file, imports, lexicons, lexUri);
			}
		}
		genImports(file, imports, lexiconDoc.id);
	});

function genServerXrpcMethod(file: SourceFile, lexicons: Lexicons, lexUri: string) {
	const def = lexicons.getDefOrThrow(lexUri, ["query", "procedure"]);

	//= export interface HandlerInput {...}
	if (def.type === "procedure" && def.input?.encoding) {
		const handlerInput = file.addInterface({
			name: "HandlerInput",
			isExported: true,
		});

		handlerInput.addProperty({
			name: "encoding",
			type: def.input.encoding
				.split(",")
				.map((v) => `'${v.trim()}'`)
				.join(" | "),
		});
		handlerInput.addProperty({
			name: "body",
			type: def.input.schema
				? def.input.encoding.includes(",")
					? "InputSchema | stream.Readable"
					: "InputSchema"
				: "stream.Readable",
		});
	} else {
		file.addTypeAlias({
			isExported: true,
			name: "HandlerInput",
			type: "void",
		});
	}

	// export interface HandlerSuccess {...}
	let hasHandlerSuccess = false;
	if (def.output?.schema || def.output?.encoding) {
		hasHandlerSuccess = true;
		const handlerSuccess = file.addInterface({
			name: "HandlerSuccess",
			isExported: true,
		});

		if (def.output.encoding) {
			handlerSuccess.addProperty({
				name: "encoding",
				type: def.output.encoding
					.split(",")
					.map((v) => `'${v.trim()}'`)
					.join(" | "),
			});
		}
		if (def.output?.schema) {
			if (def.output.encoding.includes(",")) {
				handlerSuccess.addProperty({
					name: "body",
					type: "OutputSchema | Uint8Array | stream.Readable",
				});
			} else {
				handlerSuccess.addProperty({ name: "body", type: "OutputSchema" });
			}
		} else if (def.output?.encoding) {
			handlerSuccess.addProperty({
				name: "body",
				type: "Uint8Array | stream.Readable",
			});
		}
		handlerSuccess.addProperty({
			name: "headers?",
			type: "{ [key: string]: string }",
		});
	}

	// export interface HandlerError {...}
	const handlerError = file.addInterface({
		name: "HandlerError",
		isExported: true,
	});
	handlerError.addProperties([
		{ name: "status", type: "number" },
		{ name: "message?", type: "string" },
	]);
	if (def.errors?.length) {
		handlerError.addProperty({
			name: "error?",
			type: def.errors.map((err) => `'${err.name}'`).join(" | "),
		});
	}

	// export type HandlerOutput = ...
	file.addTypeAlias({
		isExported: true,
		name: "HandlerOutput",
		type: `HandlerError | ${hasHandlerSuccess ? "HandlerSuccess" : "void"}`,
	});
}

function genServerXrpcStreaming(file: SourceFile, lexicons: Lexicons, lexUri: string) {
	const def = lexicons.getDefOrThrow(lexUri, ["subscription"]);

	file.addImportDeclaration({
		moduleSpecifier: "@atproto/xrpc-server",
		namedImports: [{ name: "ErrorFrame" }],
	});

	file.addImportDeclaration({
		moduleSpecifier: "node:http",
		namedImports: [{ name: "IncomingMessage" }],
	});

	// export type HandlerError = ...
	file.addTypeAlias({
		name: "HandlerError",
		isExported: true,
		type: `ErrorFrame<${arrayToUnion(def.errors?.map((e) => e.name))}>`,
	});

	// export type HandlerOutput = ...
	file.addTypeAlias({
		isExported: true,
		name: "HandlerOutput",
		type: `HandlerError | ${def.message?.schema ? "OutputSchema" : "void"}`,
	});
}

function arrayToUnion(arr?: string[]) {
	if (!arr?.length) {
		return "never";
	}
	return arr.map((item) => `'${item}'`).join(" | ");
}
