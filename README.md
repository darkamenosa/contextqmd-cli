# contextqmd-cli

`contextqmd` is a standalone CLI for ContextQMD. It talks to the registry API directly and manages a local docs cache and search index powered by QMD (SQLite + BM25 + vector search).

Requires Node.js >= 22.0.0.

## Commands

### Library Management

```bash
contextqmd libraries search "laravel"
contextqmd libraries install laravel --version 12.x
contextqmd libraries install laravel kamal
contextqmd libraries list
contextqmd libraries update laravel
contextqmd libraries remove laravel --version 12.x
```

### Documentation Search & Retrieval

```bash
contextqmd docs search "authentication guards" --library laravel --version 12.x --mode hybrid
contextqmd docs get --library laravel --version 12.x --doc-path authentication.md --from-line 120 --max-lines 80
```

Search modes: `fts` (full-text), `vector`, `hybrid`, `auto` (default — heuristic picks based on query shape).

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output instead of human-readable text |
| `--registry <url>` | Registry URL (default: `https://contextqmd.com`) |
| `--token <token>` | Authentication token |
| `--cache-dir <path>` | Local cache directory (default: `~/.cache/contextqmd`) |

## Architecture

```
src/
  index.ts              CLI entrypoint (Commander.js argument parsing, IO abstraction)
  lib/
    service.ts          Business logic — install, search, update, remove orchestration
    registry-client.ts  HTTP client for the ContextQMD registry API (uses built-in fetch)
    local-cache.ts      Filesystem cache with atomic installs and backup/restore
    doc-indexer.ts      Search index wrapping @tobilu/qmd (SQLite + BM25 + vector)
    config.ts           Config loader (~/.config/contextqmd/config.json with defaults)
    types.ts            Shared API contract types (Library, Version, Manifest, etc.)
```

**Install pipeline:** Resolves library via registry → fetches manifest → tries bundle download (tar.gz with SHA-256 verification) → falls back to page-by-page API download → indexes pages for local search.

**Search pipeline:** Classifies query (code patterns → FTS, conceptual questions → vector/hybrid) → searches local QMD index → falls back to FTS if vector/hybrid returns empty.

## Configuration

Optional config file at `~/.config/contextqmd/config.json`:

```json
{
  "registry_url": "https://contextqmd.com",
  "default_install_mode": "slim",
  "preferred_search_mode": "auto",
  "local_cache_dir": "~/.cache/contextqmd",
  "allow_origin_fetch": true,
  "allow_remote_bundles": true,
  "verify_registry_signatures": true
}
```

All fields are optional — defaults are used for anything not specified.

## Development

```bash
npm install
npm run build       # compile TypeScript to dist/
npm run check       # type-check without emitting
npm test            # run tests (vitest)
npm link            # symlink the contextqmd binary globally
```

## Dependencies

- **[commander](https://github.com/tj/commander.js)** — CLI argument parsing
- **[@tobilu/qmd](https://github.com/tobilu/qmd)** — local search index (SQLite + BM25 + vector + LLM reranking)
- **[zod](https://github.com/colinhacks/zod)** — schema validation
