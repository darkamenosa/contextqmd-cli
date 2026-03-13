# contextqmd-cli

`contextqmd` is a standalone CLI for ContextQMD. It mirrors the MCP tool surface, but it talks to the registry API directly and manages its own local docs cache and search index.

## Commands

```bash
contextqmd libraries search "inertia rails"
contextqmd libraries install "inertia rails" --version 3.17.0
contextqmd libraries list
contextqmd libraries update inertiajs/inertia-rails
contextqmd libraries remove inertiajs/inertia-rails --version 3.17.0

contextqmd docs search "file uploads" --library inertiajs/inertia-rails --version 3.17.0 --mode hybrid
contextqmd docs get --library inertiajs/inertia-rails --version 3.17.0 --doc-path guides/forms.md --from-line 120 --max-lines 80
```

## Output

- Default: prints human-readable text
- `--json`: prints structured JSON

## Architecture

- Direct registry API client for search, resolve, manifest, page-index, page, and bundle download
- Local docs cache for installed packages
- Local search index for `docs search`

## Global Flags

- `--registry`
- `--token`
- `--cache-dir`

## Local Run

```bash
npm install
npm run build
npm link

contextqmd libraries search "inertia rails"
contextqmd --json libraries list
```
