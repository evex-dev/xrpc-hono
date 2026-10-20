import { type LexiconDoc, Lexicons, type LexXrpcProcedure, type LexXrpcQuery } from "@atproto/lexicon";
import { NSID } from "@atproto/syntax";
import { type ClassDeclaration, IndentationText, Project, type SourceFile, VariableDeclarationKind } from "ts-morph";
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

export type GenServerApiOptions = {
	/** Extension of the relative imports in the generated files (`.js`, `.ts`, ... or `""` for none). */
	importExt?: string;
};

export async function genServerApi(
	lexiconDocs: LexiconDoc[],
	{ importExt = ".js" }: GenServerApiOptions = {},
): Promise<GeneratedAPI> {
	const project = new Project({
		useInMemoryFileSystem: true,
		manipulationSettings: { indentationText: IndentationText.TwoSpaces },
	});
	const api: GeneratedAPI = { files: [] };
	const lexicons = new Lexicons(lexiconDocs);
	const nsidTree = lexiconsToDefTree(lexiconDocs);
	const nsidTokens = schemasToNsidTokens(lexiconDocs);
	for (const lexiconDoc of lexiconDocs) {
		api.files.push(await lexiconTs(project, lexicons, lexiconDoc, importExt));
	}
	api.files.push(await utilTs(project));
	api.files.push(await lexiconsTs(project, lexiconDocs, importExt));
	api.files.push(await indexTs(project, lexiconDocs, nsidTree, nsidTokens, importExt));
	return api;
}

const indexTs = (
	project: Project,
	lexiconDocs: LexiconDoc[],
	nsidTree: DefTreeNode[],
	nsidTokens: Record<string, string[]>,
	importExt: string,
) =>
	gen(project, "/index.ts", async (file) => {
		genIndexImports(file, lexiconDocs, importExt);
		genTokenEnums(file, nsidTokens);
		genServerClass(file, nsidTree);
	});

type XrpcMethodType = "query" | "subscription" | "procedure";

function isXrpcMethodType(type: string | undefined): type is XrpcMethodType {
	return type === "query" || type === "subscription" || type === "procedure";
}

function genIndexImports(file: SourceFile, lexiconDocs: LexiconDoc[], importExt: string) {
	//= import {createServer as createXrpcServer, Server as XrpcServer} from '@atproto/xrpc-server'
	file.addImportDeclaration({
		moduleSpecifier: "@evex-dev/xrpc-hono",
		namedImports: [
			{ name: "Auth", isTypeOnly: true },
			{ name: "ErrorResult", isTypeOnly: true },
			{ name: "HonoXRPCOptions", alias: "XrpcOptions", isTypeOnly: true },
			{ name: "XRPCHono", alias: "XrpcServer", isTypeOnly: true },
			{ name: "HonoConfigOrHandler", isTypeOnly: true },
			{ name: "HonoStreamConfigOrHandler", isTypeOnly: true },
			{ name: "createXRPCHono", alias: "createXrpcServer" },
		],
	});
	file.addImportDeclaration({ moduleSpecifier: "hono", namedImports: [{ name: "Env", isTypeOnly: true }] });
	//= import {schemas} from './lexicons.js'
	file
		.addImportDeclaration({
			moduleSpecifier: `./lexicons${importExt}`,
		})
		.addNamedImport({
			name: "schemas",
		});

	// generate type imports
	for (const lexiconDoc of lexiconDocs) {
		if (!isXrpcMethodType(lexiconDoc.defs.main?.type)) {
			continue;
		}
		file
			.addImportDeclaration({
				moduleSpecifier: `./types/${lexiconDoc.id.split(".").join("/")}${importExt}`,
			})
			.setNamespaceImport(toTitleCase(lexiconDoc.id));
	}
}

function genTokenEnums(file: SourceFile, nsidTokens: Record<string, string[]>) {
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
}

function genServerClass(file: SourceFile, nsidTree: DefTreeNode[]) {
	//= export function createServer(options?: XrpcOptions) { ... }
	const createServerFn = file.addFunction({
		name: "createServer",
		returnType: "Server<E>",
		parameters: [{ name: "options", type: "XrpcOptions<E>", hasQuestionToken: true }],
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
		genNamespaceCls(file, ns);
	}

	//= constructor (options?: XrpcOptions) {
	//=  this.xrpc = createXrpcServer(schemas, options)
	//=  {namespace declarations}
	//= }
	serverCls
		.addConstructor({
			parameters: [{ name: "options", type: "XrpcOptions<E>", hasQuestionToken: true }],
		})
		.setBodyText(
			[
				"this.xrpc = createXrpcServer<E>(schemas, options)",
				...nsidTree.map((ns) => `this.${ns.propName} = new ${ns.className}<E>(this)`),
			].join("\n"),
		);
}

function genNamespaceCls(file: SourceFile, ns: DefTreeNode) {
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
		genNamespaceCls(file, child);
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
		if (!isXrpcMethodType(userType.def.type)) {
			continue;
		}
		genNamespaceMethod(cls, userType);
	}
}

function genNamespaceMethod(cls: ClassDeclaration, userType: DefTreeNode["userTypes"][number]) {
	const moduleName = toTitleCase(userType.nsid);
	const name = toCamelCase(NSID.parse(userType.nsid).name || "");
	//= {name}<A extends Auth | ErrorResult = undefined>(cfg: HonoConfigOrHandler<...> | HonoStreamConfigOrHandler<...>) {...}
	const method = cls.addMethod({
		name,
		typeParameters: [
			{
				name: "A",
				constraint: "Auth | ErrorResult",
				default: "undefined",
			},
		],
	});
	// subscriptions take no input and are registered with addStreamMethod
	const isSubscription = userType.def.type === "subscription";
	method.addParameter({
		name: "cfg",
		type: isSubscription
			? `HonoStreamConfigOrHandler<E, A, ${moduleName}.QueryParams, ${moduleName}.HandlerOutput>`
			: `HonoConfigOrHandler<E, A, ${moduleName}.QueryParams, ${moduleName}.HandlerInput, ${moduleName}.HandlerOutput>`,
	});
	method.setBodyText(
		[
			`const nsid = '${userType.nsid}'`,
			`return this._server.xrpc.${isSubscription ? "addStreamMethod" : "addMethod"}(nsid, cfg)`,
		].join("\n"),
	);
}

const lexiconTs = (project: Project, lexicons: Lexicons, lexiconDoc: LexiconDoc, importExt: string) =>
	gen(project, `/types/${lexiconDoc.id.split(".").join("/")}.ts`, async (file) => {
		const main = lexiconDoc.defs.main;
		if (main?.type === "query" || main?.type === "procedure") {
			// binary input is a web ReadableStream; only binary output may (also) be a node stream.Readable
			const streamingOutput = main.output?.encoding && (!main.output.schema || main.output.encoding.includes(","));
			if (streamingOutput) {
				//= import stream from 'node:stream'
				file.addImportDeclaration({
					moduleSpecifier: "node:stream",
					defaultImport: "stream",
				});
			}
		}

		genCommonImports(file, lexiconDoc.id, importExt);

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
		genImports(file, imports, lexiconDoc.id, importExt);
	});

function genServerXrpcMethod(file: SourceFile, lexicons: Lexicons, lexUri: string) {
	const def = lexicons.getDefOrThrow(lexUri, ["query", "procedure"]);

	genHandlerInput(file, def);
	const hasHandlerSuccess = genHandlerSuccess(file, def);
	genHandlerError(file, def);
	genHandlerOutput(file, hasHandlerSuccess);
}

type MethodDef = LexXrpcQuery | LexXrpcProcedure;

//= export interface HandlerInput {...}
function genHandlerInput(file: SourceFile, def: MethodDef) {
	if (def.type === "procedure" && def.input?.encoding) {
		const handlerInput = file.addInterface({
			name: "HandlerInput",
			isExported: true,
		});

		handlerInput.addProperty({
			name: "encoding",
			type: encodingToType(def.input.encoding),
		});
		handlerInput.addProperty({
			name: "body",
			type: def.input.schema
				? def.input.encoding.includes(",")
					? "InputSchema | ReadableStream<Uint8Array>"
					: "InputSchema"
				: "ReadableStream<Uint8Array>",
		});
	} else {
		file.addTypeAlias({
			isExported: true,
			name: "HandlerInput",
			type: "undefined",
		});
	}
}

// export interface HandlerSuccess {...}
/** @returns whether a HandlerSuccess was emitted */
function genHandlerSuccess(file: SourceFile, def: MethodDef): boolean {
	if (!(def.output?.schema || def.output?.encoding)) {
		return false;
	}
	const handlerSuccess = file.addInterface({
		name: "HandlerSuccess",
		isExported: true,
	});

	if (def.output.encoding) {
		handlerSuccess.addProperty({
			name: "encoding",
			type: encodingToType(def.output.encoding),
		});
	}
	if (def.output?.schema) {
		if (def.output.encoding.includes(",")) {
			handlerSuccess.addProperty({
				name: "body",
				type: "OutputSchema | Uint8Array | ReadableStream<Uint8Array> | stream.Readable",
			});
		} else {
			handlerSuccess.addProperty({ name: "body", type: "OutputSchema" });
		}
	} else if (def.output?.encoding) {
		handlerSuccess.addProperty({
			name: "body",
			type: "Uint8Array | ReadableStream<Uint8Array> | stream.Readable",
		});
	}
	handlerSuccess.addProperty({
		name: "headers?",
		type: "{ [key: string]: string }",
	});
	return true;
}

// export interface HandlerError {...}
function genHandlerError(file: SourceFile, def: MethodDef) {
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
}

// export type HandlerOutput = ...
function genHandlerOutput(file: SourceFile, hasHandlerSuccess: boolean) {
	file.addTypeAlias({
		isExported: true,
		name: "HandlerOutput",
		type: `HandlerError | ${hasHandlerSuccess ? "HandlerSuccess" : "undefined"}`,
	});
}

function genServerXrpcStreaming(file: SourceFile, lexicons: Lexicons, lexUri: string) {
	const def = lexicons.getDefOrThrow(lexUri, ["subscription"]);

	// export type HandlerError = ErrorFrame<'FutureCursor' | ...>
	file.addImportDeclaration({
		moduleSpecifier: "@evex-dev/xrpc-hono",
		namedImports: [{ name: "ErrorFrame", isTypeOnly: true }],
	});
	const errorNames = def.errors?.map((e) => `'${e.name}'`).join(" | ") || "never";
	file.addTypeAlias({
		name: "HandlerError",
		isExported: true,
		type: `ErrorFrame<${errorNames}>`,
	});

	// export type HandlerOutput = ...
	file.addTypeAlias({
		isExported: true,
		name: "HandlerOutput",
		type: def.message?.schema ? "HandlerError | OutputSchema" : "HandlerError",
	});
}

function encodingToType(encoding: string) {
	return encoding
		.split(",")
		.map((v) => v.trim())
		.map((v) => {
			if (v === "*/*") return "string";
			if (v.endsWith("/*")) return `\`${v.slice(0, -1)}\${string}\``;
			return `'${v}'`;
		})
		.join(" | ");
}
