---
name: contextqmd-docs
description: Fallback documentation lookup using the `contextqmd` CLI when context7 MCP is unavailable or fails. Use this skill when context7 MCP tools are not in the session, when context7 returns errors or empty results, or when you need local-first docs with version pinning and semantic search. Also use when the user explicitly asks for contextqmd. Activates for library documentation needs — frameworks like React, Vue, Next.js, Rails, Prisma, Inertia.js, Tailwind CSS, Laravel, etc. — but only after context7 has been tried first or is known to be unavailable.
---

# ContextQMD Documentation Lookup (context7 fallback)

Use the `contextqmd` CLI to install, search, and read library documentation locally. All search is local after a one-time install — no network during search. Always pass `--json` for structured, parseable output.

## When to Use

**context7 MCP is the primary documentation tool.** Use contextqmd only when:
- context7 MCP tools are not available in the current session
- context7 returns errors or fails to fetch docs
- context7 returns empty/poor results for a query
- The user explicitly asks to use contextqmd
- You need local-first capabilities (offline search, version pinning, semantic/hybrid search)

## Workflow

### 1. Check what's already installed

```bash
contextqmd libraries list --json
```

If the library and version you need is already listed, skip to step 3.

### 2. Find and install

Search the registry:

```bash
contextqmd libraries search "react" --json
contextqmd libraries search "laravel" --limit 10 --json
```

Install one or many libraries at once:

```bash
contextqmd libraries install react
contextqmd libraries install react laravel kamal
contextqmd libraries install react@19.2.0
```

The `@version` syntax pins a specific version. Installation downloads a docs bundle (SHA-256 verified), falls back to page-by-page API if needed, and indexes everything for local search. Idempotent — re-running when docs are current is a no-op.

### 3. Search locally

```bash
contextqmd docs search "authentication guards" --library laravel --json
contextqmd docs search "useRef" --library react@19.2.0 --json
contextqmd docs search "middleware" --library laravel --mode fts --max-results 10 --json
```

Search is entirely local. If the library isn't installed, you'll get a `NOT_INSTALLED` error — go back to step 2.

**JSON output fields per result:** `doc_path`, `page_uid`, `title`, `score`, `snippet`, `line_start`, `line_end`, `search_mode`, `url`

### 4. Read a specific page

Use `--doc-path` (canonical path from search results) or `--page-uid` (UID fallback):

```bash
contextqmd docs get --library laravel --doc-path authentication.md --json
contextqmd docs get --library react@19.2.0 --page-uid hooks/useRef --json
```

**Reading modes:**
- **Sequential:** `--from-line 40 --max-lines 60` — read a slice from a starting line
- **Context window:** `--around-line 120 --before 5 --after 20` — read around a line anchor from search
- **Line numbers:** `--line-numbers` — prefix each line with its number

### 5. Iterate

If search returns nothing useful:
- Rephrase: try the class/function name with `--mode fts`, or describe the concept differently with `--mode vector`
- Broaden: drop the `--library` filter to search across all installed docs
- Read more of the page with different `--from-line` / `--max-lines` ranges

## Search Modes (`--mode`)

The `auto` mode (default) classifies your query automatically:

| Query shape | Mode selected | Why |
|---|---|---|
| 1-2 words, no question mark | `fts` | Short terms are best matched by keyword search |
| Code patterns (camelCase, `::`, brackets, semver) | `fts` | Code identifiers need exact matching |
| Starts with how/what/why/when, or contains "best practice", "pattern", "explain" | `vector` | Conceptual questions benefit from semantic search |
| 6+ word conceptual query | `hybrid` | Long conceptual queries need both keyword and semantic |
| 8+ words | `hybrid` | Complex queries need combined ranking |

You can override with `--mode fts`, `--mode vector`, or `--mode hybrid`.

**Vector and hybrid require embeddings.** Run `contextqmd docs embed` first — this generates vector embeddings for all installed docs. Without embeddings, vector/hybrid silently fall back to FTS.

## Local Docs

Index project-local files for search alongside registry packages:

```bash
contextqmd local add ./docs --name app-docs
contextqmd local add README.md architecture/notes --name product-docs
contextqmd local list --json
contextqmd local show app-docs --json
contextqmd docs search "rate limits" --library app-docs@local --json
contextqmd local remove app-docs
```

Local docs use version `"local"` and share the same search index as registry packages. Supported file types: `.md`, `.mdx`, `.rst`, `.txt`, `.adoc`, and extensionless files named README, CHANGELOG, etc.

## Other Commands

```bash
contextqmd libraries update laravel       # refresh to latest version
contextqmd libraries update               # refresh all installed
contextqmd libraries remove laravel@12.x  # remove a specific version
contextqmd docs embed                     # generate vector embeddings
contextqmd --version                      # check CLI version
```

## Global Flags

| Flag | Description |
|---|---|
| `--json` | Structured JSON output (always use this for parsing) |
| `--registry <url>` | Registry URL override (default: `https://contextqmd.com`) |
| `--token <token>` | Authentication token |
| `--cache-dir <path>` | Cache directory override (default: `~/.cache/contextqmd`) |

**Environment variable:** `CONTEXTQMD_API_TOKEN` — alternative to `--token`.

**Config file:** `~/.config/contextqmd/config.json` (all fields optional):

```json
{
  "registry_url": "https://contextqmd.com",
  "local_cache_dir": "~/.cache/contextqmd",
  "preferred_search_mode": "auto"
}
```

## Tips for AI Agents

- Always pass `--json` — structured output is easier to parse and more reliable
- Install early: scan package.json / Gemfile and install all relevant docs upfront
- Use `--around-line N --before 5 --after 20` to window into large pages efficiently
- If search returns nothing, rephrase: try the class name (fts) or describe the concept differently (vector)
- Local docs (`local add ./docs --name X`) use version "local" and share the search index

## context7 (Primary)

context7 MCP is the default documentation tool. Try it first:

```
mcp__plugin_context7-plugin_context7__resolve-library-id({ libraryName: "react" })
mcp__plugin_context7-plugin_context7__query-docs({ context7CompatibleLibraryID: "/facebook/react", query: "useRef hook" })
```

If context7 fails, is unavailable, or returns empty results — then use the contextqmd CLI workflow above.
