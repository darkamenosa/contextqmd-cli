import { createHash } from "node:crypto";
import {
  createStore,
  extractSnippet,
  type EmbedProgress,
  type HybridQueryResult,
  type InternalStore,
  type QMDStore,
} from "@tobilu/qmd";
import { normalizeDocPath, type LocalCache } from "./local-cache.js";

export interface IndexedPage {
  pageUid: string;
  title: string;
  path: string;
}

export type SearchMode = "fts" | "vector" | "hybrid" | "auto";

export interface SearchOptions {
  library?: string;
  version?: string;
  maxResults?: number;
  mode?: SearchMode;
}

export interface DocSearchResult {
  pageUid: string;
  title: string;
  path: string;
  docPath: string;
  contentMd: string;
  score: number;
  snippet: string;
  library: string;
  version: string;
  searchMode: SearchMode;
  lineStart: number | null;
  lineEnd: number | null;
  url?: string;
}

/**
 * Pick the highest version from a list.
 * Prefers "latest" > semver-like (highest numeric) > most recently added (last).
 * Handles non-semver versions like "12.x", "stable", "v2.0" gracefully.
 */
function pickHighestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;
  if (versions.length === 1) return versions[0];
  if (versions.includes("latest")) return "latest";

  const scored = versions.map((v, index) => {
    const nums = v.replace(/^v/i, "").split(/[.\-]/).map(Number).filter(n => !isNaN(n));
    const score = nums.length > 0
      ? (nums[0] ?? 0) * 1e6 + (nums[1] ?? 0) * 1e3 + (nums[2] ?? 0)
      : -1;
    return { version: v, score, index };
  });

  const numeric = scored.filter(s => s.score >= 0);
  if (numeric.length > 0) {
    return numeric.sort((a, b) => b.score - a.score)[0].version;
  }

  return versions[versions.length - 1];
}

/**
 * Sanitize a query string for FTS5.
 *
 * FTS5 treats `-` as the NOT operator and other punctuation as syntax.
 * This replaces hyphens between word characters with spaces and strips
 * any remaining FTS5 operators that could cause parse errors.
 */
function sanitizeFTSQuery(query: string): string {
  return query
    .replace(/(\w)-(\w)/g, "$1 $2")
    .replace(/(^|\s)-(\s|$)/g, "$1$2")
    .replace(/[{}()^*]/g, "")
    .trim();
}

export function classifyQuery(query: string): SearchMode {
  const q = query.trim();

  if (q.split(/\s+/).length <= 2 && !q.includes("?")) {
    return "fts";
  }

  const codePatterns = [
    /[a-z][A-Z]/,
    /[a-z]_[a-z]/,
    /\w+\.\w+\.\w+/,
    /`[^`]+`/,
    /^[A-Z_]{3,}$/,
    /\berr(or)?[:\s]+/i,
    /\d+\.\d+\.\d+/,
    /[{}()\[\]<>]/,
    /^(get|set|use|create|delete|update)\w+/i,
    /\w+::\w+/,
    /\w+\/\w+/,
  ];

  if (codePatterns.some(pattern => pattern.test(q))) {
    return "fts";
  }

  const conceptualPatterns = [
    /^(how|what|why|when|where|can|should|is it|does)\b/i,
    /\b(best practice|pattern|approach|strategy|concept|overview|guide)\b/i,
    /\b(difference between|compare|vs\.?|versus)\b/i,
    /\b(explain|understand|learn|tutorial)\b/i,
  ];

  if (conceptualPatterns.some(pattern => pattern.test(q))) {
    if (q.split(/\s+/).length >= 6) {
      return "hybrid";
    }
    return "vector";
  }

  if (q.split(/\s+/).length >= 8) {
    return "hybrid";
  }

  return "fts";
}

export class DocIndexer {
  private storePromise: Promise<QMDStore>;
  private cache: LocalCache;

  constructor(dbPath: string, cache: LocalCache) {
    this.storePromise = createStore({
      dbPath,
      config: { collections: {} },
    });
    this.cache = cache;
  }

  async close(): Promise<void> {
    const store = await this.storePromise;
    await store.close();
  }

  async getStore(): Promise<InternalStore> {
    return (await this.storePromise).internal;
  }

  static collectionName(slug: string, version: string): string {
    return `${slug}__${version}`;
  }

  static parseCollectionName(collectionName: string): { slug: string; version: string } | null {
    const idx = collectionName.lastIndexOf("__");
    if (idx <= 0 || idx === collectionName.length - 2) return null;
    return { slug: collectionName.slice(0, idx), version: collectionName.slice(idx + 2) };
  }

  async indexLibraryVersion(slug: string, version: string): Promise<number> {
    const store = await this.getStore();
    const collectionName = DocIndexer.collectionName(slug, version);
    const pageUids = this.cache.listPageUids(slug, version);
    const desiredPaths = new Set<string>();

    let indexed = 0;
    for (const pageUid of pageUids) {
      const content = this.cache.readPage(slug, version, pageUid);
      if (!content) continue;

      const page = this.cache.findPageByUid(slug, version, pageUid);
      const docPath = page ? normalizeDocPath(page.path) : `${pageUid}.md`;
      desiredPaths.add(docPath);
      const title = page?.title ?? extractTitle(content, pageUid);
      const hash = await hashContent(content);
      const now = new Date().toISOString();
      const legacyPath = `${pageUid}.md`;
      const existing = store.findActiveDocument(collectionName, docPath);
      const legacyExisting = docPath === legacyPath
        ? existing
        : store.findActiveDocument(collectionName, legacyPath);

      if (existing && existing.hash === hash) {
        if (existing.title !== title) {
          store.updateDocumentTitle(existing.id, title, now);
        }
        continue;
      }
      if (!existing && legacyExisting && legacyExisting.hash === hash) {
        store.insertDocument(collectionName, docPath, title, legacyExisting.hash, now, now);
        if (legacyPath !== docPath) {
          store.deactivateDocument(collectionName, legacyPath);
        }
        indexed++;
        continue;
      }

      store.insertContent(hash, content, now);
      if (existing) {
        store.updateDocument(existing.id, title, hash, now);
      } else {
        store.insertDocument(collectionName, docPath, title, hash, now, now);
        if (legacyExisting && legacyPath !== docPath) {
          store.deactivateDocument(collectionName, legacyPath);
        }
      }
      indexed++;
    }

    for (const activePath of store.getActiveDocumentPaths(collectionName)) {
      if (!desiredPaths.has(activePath)) {
        store.deactivateDocument(collectionName, activePath);
      }
    }

    return indexed;
  }

  async embed(onProgress?: (info: EmbedProgress) => void): Promise<{ chunksEmbedded: number }> {
    const store = await this.storePromise;
    const result = await store.embed({ onProgress });
    return { chunksEmbedded: result.chunksEmbedded };
  }

  async removeLibraryVersion(slug: string, version: string): Promise<void> {
    const store = await this.getStore();
    const collectionName = DocIndexer.collectionName(slug, version);
    const paths = store.getActiveDocumentPaths(collectionName);
    for (const path of paths) {
      store.deactivateDocument(collectionName, path);
    }
  }

  private resolveCollections(options: SearchOptions): string[] {
    if (options.library && options.version) {
      return [DocIndexer.collectionName(options.library, options.version)];
    }
    if (options.library) {
      const versions = this.cache.listInstalled()
        .filter(lib => lib.slug === options.library)
        .map(lib => lib.version);
      const best = pickHighestVersion(versions);
      if (best) return [DocIndexer.collectionName(options.library, best)];
      return [];
    }
    return [];
  }

  async search(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    if (options.version && !options.library) {
      console.warn(
        `[contextqmd] version filter "${options.version}" specified without library — version will be applied as a post-query filter`,
      );
    }

    const requestedMode = options.mode ?? "auto";
    const effectiveMode = requestedMode === "auto" ? classifyQuery(query) : requestedMode;

    if (effectiveMode === "vector") {
      const results = await this.searchVector(query, options);
      if (results.length > 0) return results;
      return (await this.searchFTS(query, options)).map(result => ({ ...result, searchMode: "fts" as SearchMode }));
    }

    if (effectiveMode === "hybrid") {
      const results = await this.searchHybrid(query, options);
      if (results.length > 0) return results;
      return (await this.searchFTS(query, options)).map(result => ({ ...result, searchMode: "fts" as SearchMode }));
    }

    return this.searchFTS(query, options);
  }

  async searchFTS(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    const store = await this.getStore();
    const limit = options.maxResults ?? 10;
    const collections = this.resolveCollections(options);
    const collectionFilter = collections.length === 1 ? collections[0] : undefined;

    const sanitized = sanitizeFTSQuery(query);
    const results = store.searchFTS(sanitized, limit * 2, collectionFilter);
    return this.mapAnyResults(results, query, options, "fts").slice(0, limit);
  }

  async searchVector(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    const store = await this.storePromise;
    const limit = options.maxResults ?? 10;
    const collections = this.resolveCollections(options);
    const collectionFilter = collections.length === 1 ? collections[0] : undefined;

    try {
      const results = await withTimeout(
        store.searchVector(query, {
          collection: collectionFilter,
          limit: limit * 2,
        }),
        30_000,
      );
      return this.mapAnyResults(results, query, options, "vector").slice(0, limit);
    } catch (error) {
      console.warn(`[contextqmd] vector search failed, falling back to FTS: ${(error as Error).message}`);
      return [];
    }
  }

  async searchHybrid(query: string, options: SearchOptions = {}): Promise<DocSearchResult[]> {
    const store = await this.storePromise;
    const limit = options.maxResults ?? 10;
    const collections = this.resolveCollections(options);

    try {
      const results = await withTimeout(
        store.search({
          query,
          ...(collections.length === 1
            ? { collection: collections[0] }
            : collections.length > 1
              ? { collections }
              : {}),
          limit,
        }),
        60_000,
      );
      return this.mapAnyResults<HybridQueryResult>(
        results,
        query,
        options,
        "hybrid",
        result => this.extractSnippetInfo(result.body ?? "", query, result.bestChunkPos),
      ).slice(0, limit);
    } catch (error) {
      console.warn(`[contextqmd] hybrid search failed, falling back to FTS: ${(error as Error).message}`);
      return [];
    }
  }

  private mapAnyResults<T extends { displayPath: string; title: string; score: number; body?: string }>(
    results: T[],
    query: string,
    options: SearchOptions,
    mode: SearchMode,
    snippetFn: (result: T) => SearchSnippet = result =>
      this.extractSnippetInfo(result.body ?? "", query, (result as { chunkPos?: number }).chunkPos),
  ): DocSearchResult[] {
    return results
      .map(result => {
        const collectionName = (result as { collectionName?: string }).collectionName ?? result.displayPath.split("/")[0];
        const parsed = DocIndexer.parseCollectionName(collectionName);
        const library = parsed ? parsed.slug : collectionName;

        let docPath = result.displayPath;
        if (docPath.startsWith(`${collectionName}/`)) {
          docPath = docPath.slice(collectionName.length + 1);
        }
        docPath = normalizeDocPath(docPath);

        const page = parsed ? this.cache.findPageByPath(parsed.slug, parsed.version, docPath) : null;
        const pageUid = page?.page_uid ?? docPath.replace(/\.md$/, "");
        const contentMd = parsed ? (this.cache.readPage(parsed.slug, parsed.version, pageUid) ?? result.body ?? "") : (result.body ?? "");
        const snippet = snippetFn(result);

        return {
          pageUid,
          title: page?.title ?? result.title,
          path: result.displayPath,
          docPath,
          contentMd,
          score: result.score,
          snippet: snippet.snippet,
          library,
          searchMode: mode,
          _version: parsed?.version,
          lineStart: snippet.lineStart,
          lineEnd: snippet.lineEnd,
          url: page?.url,
        };
      })
      .filter(result => {
        if (options.library && result.library !== options.library) return false;
        if (options.version && result._version !== options.version) return false;
        return true;
      })
      .map(({ _version, ...result }) => ({ ...result, version: _version ?? "unknown" }));
  }

  private extractSnippetInfo(body: string, query: string, chunkPos?: number): SearchSnippet {
    if (!body.trim()) {
      return { snippet: "", lineStart: null, lineEnd: null };
    }

    const { snippet, line, snippetLines } = extractSnippet(body, query, 500, chunkPos);
    if (!line || line < 1) {
      return { snippet, lineStart: null, lineEnd: null };
    }

    return {
      snippet,
      lineStart: line,
      lineEnd: line + Math.max(snippetLines - 1, 0),
    };
  }
}

type SearchSnippet = {
  snippet: string;
  lineStart: number | null;
  lineEnd: number | null;
};

async function hashContent(content: string): Promise<string> {
  return createHash("sha256").update(content).digest("hex");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}
