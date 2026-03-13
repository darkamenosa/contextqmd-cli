#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { loadConfig } from "./lib/config.js";
import { DocIndexer } from "./lib/doc-indexer.js";
import { LocalCache } from "./lib/local-cache.js";
import { RegistryClient } from "./lib/registry-client.js";
import {
  getDoc,
  installDocs,
  listInstalledDocs,
  removeDocs,
  searchDocs,
  searchLibraries,
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

function globalOptionsFor(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function createProgram(io: Required<CliIo>, onExitCode: (code: number) => void): Command {
  const program = addGlobalOptions(new Command());

  program
    .name("contextqmd")
    .description("CLI for ContextQMD")
    .exitOverride()
    .configureOutput({
      writeOut: chunk => io.writeStdout(chunk),
      writeErr: chunk => io.writeStderr(chunk),
    });

  const libraries = program.command("libraries").description("Library package workflows");
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
    .argument("<library>", "Library query or slug")
    .option("--version <version>", "Version to install")
    .action(async function(library: string, options: { version?: string }) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => installDocs(deps, { library, version: options.version }));
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
    .argument("[library]", "Optional library slug (namespace/name)")
    .action(async function(library?: string) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => updateDocs(deps, library ? { library } : {}));
      onExitCode(renderResult(result, global, io));
    });

  libraries
    .command("remove")
    .argument("<library>", "Library slug (namespace/name)")
    .option("--version <version>", "Installed version to remove")
    .action(async function(library: string, options: { version?: string }) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps => removeDocs(deps, { library, version: options.version }));
      onExitCode(renderResult(result, global, io));
    });

  const docs = program.command("docs").description("Installed documentation operations");
  docs
    .command("search")
    .argument("<query>", "Search query")
    .option("--library <library>", "Filter to a specific library")
    .option("--version <version>", "Filter to a specific version")
    .option("--mode <mode>", "Search mode")
    .option("--max-results <count>", "Maximum results to return")
    .action(async function(
      query: string,
      options: { library?: string; version?: string; mode?: string; maxResults?: string },
    ) {
      const global = globalOptionsFor(this);
      const result = await withDeps(io.env, global, io, deps =>
        searchDocs(deps, {
          query,
          ...(options.library ? { library: options.library } : {}),
          ...(options.version ? { version: options.version } : {}),
          ...(options.mode ? { mode: options.mode as never } : {}),
          ...(options.maxResults ? { max_results: Number(options.maxResults) } : {}),
        }));
      onExitCode(renderResult(result, global, io));
    });

  docs
    .command("get")
    .requiredOption("--library <library>", "Library slug (namespace/name)")
    .requiredOption("--version <version>", "Installed version")
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
      version: string;
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
      const result = await withDeps(io.env, global, io, deps =>
        getDoc(deps, {
          library: options.library,
          version: options.version,
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
      if (error.code !== "commander.helpDisplayed") {
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
  process.exit(exitCode);
}
