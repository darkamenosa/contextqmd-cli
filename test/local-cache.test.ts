import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalCache } from "../src/lib/local-cache.js";
import type { PageRecord } from "../src/lib/types.js";

describe("LocalCache legacy compatibility", () => {
  let cacheDir: string;
  let cache: LocalCache;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "contextqmd-cli-cache-"));
    cache = new LocalCache(cacheDir);
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  function seedLegacyInstall() {
    const legacyDir = join(cacheDir, "docs", "laravel", "docs", "12.x");
    const pagesDir = join(legacyDir, "pages");
    mkdirSync(pagesDir, { recursive: true });

    const pageIndex: PageRecord[] = [{
      page_uid: "intro",
      path: "getting-started.md",
      title: "Getting Started",
      url: "https://example.test/getting-started",
      checksum: "sha256:intro",
      bytes: 42,
      headings: ["Getting Started"],
      updated_at: "2026-03-15T00:00:00Z",
    }];

    writeFileSync(
      join(cacheDir, "state", "installed.json"),
      JSON.stringify({
        libraries: [
          {
            namespace: "laravel",
            name: "docs",
            version: "12.x",
            profile: "full",
            installed_at: "2026-03-15T00:00:00Z",
            manifest_checksum: "sha256:manifest",
            page_count: 1,
          },
        ],
      }, null, 2),
    );
    writeFileSync(join(legacyDir, "manifest.json"), JSON.stringify({ version: "12.x" }, null, 2));
    writeFileSync(join(legacyDir, "page-index.json"), JSON.stringify(pageIndex, null, 2));
    writeFileSync(join(pagesDir, "intro.md"), "# Getting Started\n\nLegacy cache content.\n");
  }

  it("normalizes legacy installed state entries to slug-based records", () => {
    seedLegacyInstall();

    expect(cache.listInstalled()).toEqual([
      expect.objectContaining({
        slug: "laravel",
        version: "12.x",
        profile: "full",
      }),
    ]);
    expect(cache.findInstalled("laravel", "12.x")).toEqual(
      expect.objectContaining({
        slug: "laravel",
        version: "12.x",
      }),
    );
  });

  it("reads manifests, page index, and page content from the legacy docs layout", () => {
    seedLegacyInstall();

    expect(cache.hasManifest("laravel", "12.x")).toBe(true);
    expect(cache.loadPageIndex("laravel", "12.x")).toHaveLength(1);
    expect(cache.readPage("laravel", "12.x", "intro")).toContain("Legacy cache content");
    expect(cache.countPages("laravel", "12.x")).toBe(1);
    expect(cache.listPageUids("laravel", "12.x")).toEqual(["intro"]);
  });

  it("backs up a legacy docs install so update can proceed", () => {
    seedLegacyInstall();

    const backupDir = cache.backupVersion("laravel", "12.x");

    expect(backupDir).toBeTruthy();
    expect(existsSync(join(cacheDir, "docs", "laravel", "docs", "12.x"))).toBe(false);
    expect(existsSync(join(backupDir!, "manifest.json"))).toBe(true);
  });

  it("removes a legacy docs install by canonical slug", () => {
    seedLegacyInstall();

    cache.removeVersion("laravel", "12.x");
    cache.removeInstalled("laravel", "12.x");

    expect(cache.findInstalled("laravel", "12.x")).toBeUndefined();
    expect(existsSync(join(cacheDir, "docs", "laravel", "docs", "12.x"))).toBe(false);
  });
});
