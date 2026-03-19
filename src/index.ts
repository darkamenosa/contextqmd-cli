#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version as string;
import { Command, CommanderError } from "commander";
import { loadConfig } from "./lib/config.js";
import { DocIndexer } from "./lib/doc-indexer.js";
import { LocalCache } from "./lib/local-cache.js";
import { RegistryClient } from "./lib/registry-client.js";
import {
  addLocalDocs,
  getDoc,
  installDocs,
  listInstalledDocs,
  listLocalDocs,
  removeDocs,
  removeLocalDocs,
  searchDocs,
  searchLibraries,
  showLocalDocs,
  type AppDeps,
  type CommandResult,
  updateDocs,
} from "./lib/service.js";

type CliIo = {
  env?: NodeJS.ProcessEnv;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
};

type GlobalOptions = {
  json?: boolean;
  registry?: string;
  token?: string;
  cacheDir?: string;
};

function defaultIo(): Required<CliIo> {
  return {
    env: process.env,
    writeStdout: chunk => process.stdout.write(chunk),
    writeStderr: chunk => process.stderr.write(chunk),
  };
}

function resolveEntrypointPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

export function isCliEntrypoint(argvPath = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;
  return resolveEntrypointPath(argvPath) === resolveEntrypointPath(fileURLToPath(moduleUrl));
}

async function withDeps<T>(
  env: NodeJS.ProcessEnv,
  options: GlobalOptions,
  io: Required<CliIo>,
  run: (deps: AppDeps) => Promise<T> | T,
): Promise<T> {
  const config = loadConfig();
  const registryUrl = options.registry ?? config.registry_url;
  const token = options.token ?? env.CONTEXTQMD_API_TOKEN;
  const cacheDir = options.cacheDir ?? config.local_cache_dir;
  const registryClient = new RegistryClient(registryUrl, token);
  const cache = new LocalCache(cacheDir);
  const indexer = new DocIndexer(join(cacheDir, "index.sqlite"), cache);

  try {
    return await run({
      registryClient,
      cache,
      indexer,
      reportProgress: message => io.writeStderr(`${message}\n`),
    });
  } finally {
    await indexer.close();
  }
}

function renderResult(result: CommandResult, options: GlobalOptions, io: Required<CliIo>): number {
  const output = options.json
    ? JSON.stringify(result.structuredContent ?? {}, null, 2)
    : result.text;
  const normalized = output.endsWith("\n") ? output : `${output}\n`;

  if (result.isError) {
    io.writeStderr(normalized);
    return 1;
  }

  io.writeStdout(normalized);
  return 0;
}

function addGlobalOptions(command: Command): Command {
  return command
    .option("--json", "Print structured output as JSON")
    .option("--registry <url>", "Registry URL override")
    .option("--token <token>", "Registry token override")
    .option("--cache-dir <path>", "Local cache directory override");
}

function invalidArgumentsResult(message: string): CommandResult {
  return {
    text: message,
    isError: true,
    structuredContent: {
      error: {
        code: "INVALID_ARGUMENTS",
        message,
      },
    },
  };
}

function parseLibraryArg(arg: string): { library: string; version?: string } {
  const atIndex = arg.lastIndexOf("@");
  if (atIndex > 0) {
    return { library: arg.slice(0, atIndex), version: arg.slice(atIndex + 1) };
  }
  return { library: arg };
}

async function installLibraries(
  deps: AppDeps,
  libraries: string[],
): Promise<CommandResult> {
  if (libraries.length === 1) {
    const parsed = parseLibraryArg(libraries[0]);
    return installDocs(deps, { library: parsed.library, version: parsed.version });
  }

  const results: Array<Record<string, unknown>> = [];
  const output: string[] = [];
  let hasError = false;

  for (const lib of libraries) {
    const parsed = parseLibraryArg(lib);
    const result = await installDocs(deps, { library: parsed.library, version: parsed.version });
    output.push(result.text);
    results.push({
      input: lib,
      ...(result.structuredContent ?? {}),
    });
    hasError = hasError || Boolean(result.isError);
  }

  const errorCount = results.filter(result => "error" in result).length;

  return {
    text: output.join("\n\n"),
    isError: hasError,
    structuredContent: {
      results,
      success_count: results.length - errorCount,
      error_count: errorCount,
    },
  };
}

function globalOptionsFor(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function topLevelHelpText(): string {
  return `
──── Quick Reference ─────────────────────────────────────────────────

  npm install -g contextqmd

  contextqmd libraries search react
  contextqmd libraries install react laravel
  contextqmd docs search "useEffect cleanup" --library react
  contextqmd docs get --library react@19.0.0 --doc-path hooks.md

Registry Packages
  libraries search <query>         Find libraries in the registry
  libraries install <lib...>       Install docs (one or many at once)
  libraries list                   Show installed packages
  libraries update [lib]           Refresh installed packages
  libraries remove <lib>           Remove a package

Local Docs
  local add <path...> --name X     Index local files as a searchable package
  local list                       List local-only packages
  local show <lib>                 Show source paths for a local package
  local remove <lib>               Remove a local package

Search & Retrieval
  docs search <query>              Search installed docs (FTS by default)
  docs get --library slug[@ver]      Retrieve a specific doc page
  docs embed                       Generate vector embeddings (optional)

Search Modes (--mode)
  auto       Default. Uses FTS; falls back gracefully without embeddings.
  fts        Short keywords, function names, exact terms.
  vector     Conceptual questions (requires: docs embed).
  hybrid     Long queries mixing keywords and concepts (requires: docs embed).

──── For AI Agents ───────────────────────────────────────────────────

When to use contextqmd
  Your training data has a cutoff. Library APIs change between versions.
  Use contextqmd to get version-accurate docs before writing code.

  Reach for it when:
  - You're about to use a library API you're not 100% sure about
  - A user asks "how do I do X with library Y"
  - You need to check method signatures, config options, or patterns
  - You're debugging and suspect incorrect API usage

Workflow
  1. Check installed    contextqmd libraries list --json
  2. Install            contextqmd libraries install <lib>
  3. Search             contextqmd docs search "<query>" --library <lib> --json
  4. Read the page      contextqmd docs get --library <lib>[@ver] --doc-path <path> --json

Tips
  - Always pass --json for structured, parseable output.
  - Use --mode fts for function/class names, --mode vector for conceptual questions.
  - Use --around-line N --before 5 --after 20 to window into large pages.
  - Install early: scan package.json / Gemfile and install all relevant docs upfront.
  - If search returns nothing, rephrase: try the class name (fts) or
    describe the concept differently (vector).
  - Local docs (local add ./docs --name X) use version "local" and share the
    same search index as registry packages.
`.trimStart();
}

function localHelpText(): string {
  return `
Examples:
  contextqmd local add ./docs --name app-docs
  contextqmd local add README.md architecture/notes --name product-docs
  contextqmd local show app-docs
  contextqmd docs search "rate limits" --library app-docs@local
`.trimStart();
}

function createProgram(io: Required<CliIo>, onExitCode: (code: number) => void): Command {
  const program = addGlobalOptions(new Command());

  program
    .name("contextqmd")
    .version(VERSION, "-v, --version")
    .description("Local-first docs workflows for AI agents: registry packages, local docs, and searchable context.")
    .exitOverride()
    .showHelpAfterError()
    .addHelpText("after", `\n${topLevelHelpText()}\n`)
    .configureOutput({
      writeOut: chunk => io.writeStdout(chunk),
      writeErr: chunk => io.writeStderr(chunk),
    });

  const libraries = program.command("libraries").description("Registry package workflows");
  libraries
    .command("search")
    .argument("<query>", "Search query")
    .option("--limit <count>", "Maximum libraries to return")
    .action(async function(query: string, options: { limit?: string }) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps =>
        searchLibraries(deps, { query, ...(options.limit ? { limit: Number(options.limit) } : {}) }));
      onExitCode(renderResult(result, global, io));
    });

  libraries
    .command("install")
    .argument("<libraries...>", "Library slugs (use slug@version for a specific version, e.g. sentry@26.3.1)")
    .action(async function(libraries: string[]) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => installLibraries(deps, libraries));
      onExitCode(renderResult(result, global, io));
    });

  libraries
    .command("list")
    .action(async function() {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => listInstalledDocs(deps));
      onExitCode(renderResult(result, global, io));
    });

  libraries
    .command("update")
    .argument("[library]", "Optional library slug")
    .action(async function(library?: string) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => updateDocs(deps, library ? { library } : {}));
      onExitCode(renderResult(result, global, io));
    });

  libraries
    .command("remove")
    .argument("<library>", "Library slug (use slug@version to remove a specific version)")
    .action(async function(library: string) {
      const global = globalOptionsFor(this);
      const parsed = parseLibraryArg(library);
      const result = await withDeps(io.env, global, io, deps => removeDocs(deps, { library: parsed.library, version: parsed.version }));
      onExitCode(renderResult(result, global, io));
    });

  const local = program.command("local").description("Ad hoc local files and directories for docs search");
  local.addHelpText("after", `\n${localHelpText()}\n`);
  local
    .command("add")
    .argument("<paths...>", "Files or directories to index locally")
    .option("--name <name>", "Library slug to use for these local docs")
    .action(async function(paths: string[], options: { name?: string }) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => addLocalDocs(deps, { paths, name: options.name }));
      onExitCode(renderResult(result, global, io));
    });

  local
    .command("list")
    .action(async function() {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => listLocalDocs(deps));
      onExitCode(renderResult(result, global, io));
    });

  local
    .command("show")
    .argument("<library>", "Local docs library slug")
    .action(async function(library: string) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => showLocalDocs(deps, { library }));
      onExitCode(renderResult(result, global, io));
    });

  local
    .command("remove")
    .argument("<library>", "Local docs library slug")
    .action(async function(library: string) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => removeLocalDocs(deps, { library }));
      onExitCode(renderResult(result, global, io));
    });

  const docs = program.command("docs").description("Search and read installed docs");
  docs
    .command("search")
    .argument("<query>", "Search query")
    .option("--library <library>", "Filter to a specific library (use slug@version for a specific version)")
    .option("--mode <mode>", "Search mode")
    .option("--max-results <count>", "Maximum results to return")
    .action(async function(
      query: string,
      options: { library?: string; mode?: string; maxResults?: string },
    ) {
      const global = globalOptionsFor(this);
      const parsed = options.library ? parseLibraryArg(options.library) : { library: undefined, version: undefined };
      const result = await withDeps(io.env, global, io, deps =>
        searchDocs(deps, {
          query,
          ...(parsed.library ? { library: parsed.library } : {}),
          ...(parsed.version ? { version: parsed.version } : {}),
          ...(options.mode ? { mode: options.mode as never } : {}),
          ...(options.maxResults ? { max_results: Number(options.maxResults) } : {}),
        }));
      onExitCode(renderResult(result, global, io));
    });

  docs
    .command("get")
    .requiredOption("--library <library>", "Library slug (use slug@version for a specific version)")
    .option("--doc-path <docPath>", "Canonical document path")
    .option("--page-uid <pageUid>", "Page UID fallback")
    .option("--from-line <line>", "Start line")
    .option("--max-lines <count>", "Maximum lines")
    .option("--around-line <line>", "Anchor line")
    .option("--before <count>", "Lines before around-line")
    .option("--after <count>", "Lines after around-line")
    .option("--line-numbers", "Include line numbers")
    .action(async function(options: {
      library: string;
      docPath?: string;
      pageUid?: string;
      fromLine?: string;
      maxLines?: string;
      aroundLine?: string;
      before?: string;
      after?: string;
      lineNumbers?: boolean;
    }) {
      const global = globalOptionsFor(this);
      const parsed = parseLibraryArg(options.library);
      const result = await withDeps(io.env, global, io, deps =>
        getDoc(deps, {
          library: parsed.library,
          version: parsed.version,
          ...(options.docPath ? { doc_path: options.docPath } : {}),
          ...(options.pageUid ? { page_uid: options.pageUid } : {}),
          ...(options.fromLine ? { from_line: Number(options.fromLine) } : {}),
          ...(options.maxLines ? { max_lines: Number(options.maxLines) } : {}),
          ...(options.aroundLine ? { around_line: Number(options.aroundLine) } : {}),
          ...(options.before ? { before: Number(options.before) } : {}),
          ...(options.after ? { after: Number(options.after) } : {}),
          ...(options.lineNumbers ? { line_numbers: true } : {}),
        }));
      onExitCode(renderResult(result, global, io));
    });

  docs
    .command("embed")
    .description("Generate vector embeddings for installed docs (enables vector and hybrid search)")
    .action(async function() {
      const global = globalOptionsFor(this);
      await withDeps(io.env, global, io, async deps => {
        const { indexer } = deps;
        deps.reportProgress?.("Generating embeddings for vector search...");
        const result = await indexer.embed((info) => {
          if (info.totalChunks > 0) {
            deps.reportProgress?.(`Embedding: ${info.chunksEmbedded}/${info.totalChunks} chunks`);
          }
        });
        if (global.json) {
          io.writeStdout(JSON.stringify({ chunks_embedded: result.chunksEmbedded }, null, 2) + "\n");
        } else {
          io.writeStdout(`Done. ${result.chunksEmbedded} chunks embedded.\n`);
        }
        return result;
      });
    });

  return program;
}

export async function runCli(argv: string[], inputIo: CliIo = {}): Promise<number> {
  const io = { ...defaultIo(), ...inputIo } as Required<CliIo>;
  let exitCode = 0;
  const program = createProgram(io, code => {
    exitCode = code;
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code !== "commander.helpDisplayed" && error.code !== "commander.version") {
        io.writeStderr(`${error.message}\n`);
      }
      return error.exitCode;
    }

    io.writeStderr(`${(error as Error).message}\n`);
    return 1;
  }
}

if (isCliEntrypoint()) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
