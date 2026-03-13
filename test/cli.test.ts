import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isCliEntrypoint, runCli } from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type PageFixture = {
  page_uid: string;
  path: string;
  title: string;
  url: string;
  content_md: string;
};

type VersionFixture = {
  version: string;
  channel: "stable";
  manifest_checksum: string;
  pages: PageFixture[];
};

type RegistryFixture = {
  currentVersion: string;
  versions: Record<string, VersionFixture>;
};

function buildFixture(): RegistryFixture {
  return {
    currentVersion: "3.17.0",
    versions: {
      "3.17.0": {
        version: "3.17.0",
        channel: "stable",
        manifest_checksum: "sha256:manifest-317",
        pages: [
          {
            page_uid: "forms",
            path: "guides/forms.md",
            title: "Forms",
            url: "https://example.test/guides/forms",
            content_md: "# Forms\n\nFile uploads are supported.\n\nUse FormData for uploads.\n",
          },
        ],
      },
      "3.18.0": {
        version: "3.18.0",
        channel: "stable",
        manifest_checksum: "sha256:manifest-318",
        pages: [
          {
            page_uid: "forms",
            path: "guides/forms.md",
            title: "Forms",
            url: "https://example.test/guides/forms",
            content_md: "# Forms\n\nFile uploads changed.\n\nUse the upload helper.\n",
          },
        ],
      },
    },
  };
}

function jsonResponse(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  jsonResponse(res, { error: { code: "not_found", message: "Not found" } }, 404);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function pageIndexFor(version: VersionFixture) {
  return version.pages.map(page => ({
    page_uid: page.page_uid,
    path: page.path,
    title: page.title,
    url: page.url,
    checksum: `sha256:${page.page_uid}`,
    bytes: Buffer.byteLength(page.content_md),
    headings: [page.title],
    updated_at: "2026-03-13T00:00:00Z",
  }));
}

function manifestFor(version: VersionFixture) {
  return {
    schema_version: "1.0",
    namespace: "inertiajs",
    name: "inertia-rails",
    display_name: "Inertia Rails",
    version: version.version,
    channel: version.channel,
    generated_at: "2026-03-13T00:00:00Z",
    doc_count: version.pages.length,
    source: {
      type: "github",
      url: "https://github.com/inertiajs/inertia-rails",
      etag: null,
    },
    page_index: {
      url: `/api/v1/libraries/inertiajs/inertia-rails/versions/${version.version}/page-index`,
      sha256: null,
    },
    profiles: {},
    source_policy: {
      license_name: "MIT",
      license_status: "verified",
      mirror_allowed: true,
      origin_fetch_allowed: true,
      attribution_required: false,
    },
    provenance: {
      normalizer_version: "2026-03-13",
      splitter_version: "v1",
      manifest_checksum: version.manifest_checksum,
    },
  };
}

async function startFakeRegistry(fixture: RegistryFixture): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/api/v1/libraries") {
      const query = (url.searchParams.get("query") ?? "").toLowerCase();
      const matches = query.includes("inertia")
        ? [
          {
            namespace: "inertiajs",
            name: "inertia-rails",
            display_name: "Inertia Rails",
            aliases: ["inertia-rails", "inertiarails"],
            homepage_url: "https://github.com/inertiajs/inertia-rails",
            default_version: "3.18.0",
            source_type: "github",
            license_status: "verified",
            version_count: Object.keys(fixture.versions).length,
          },
        ]
        : [];
      return jsonResponse(res, { data: matches, meta: { cursor: null } });
    }

    if (method === "GET" && url.pathname === "/api/v1/libraries/inertiajs/inertia-rails/versions") {
      return jsonResponse(res, {
        data: Object.values(fixture.versions).map(version => ({
          version: version.version,
          channel: version.channel,
          generated_at: "2026-03-13T00:00:00Z",
          manifest_checksum: version.manifest_checksum,
        })),
        meta: { cursor: null },
      });
    }

    if (method === "POST" && url.pathname === "/api/v1/resolve") {
      const body = await readJson(req) as { version_hint?: string };
      const versionKey = body.version_hint && fixture.versions[body.version_hint]
        ? body.version_hint
        : fixture.currentVersion;
      const version = fixture.versions[versionKey];
      return jsonResponse(res, {
        data: {
          library: {
            namespace: "inertiajs",
            name: "inertia-rails",
            display_name: "Inertia Rails",
            aliases: ["inertia-rails", "inertiarails"],
            homepage_url: "https://github.com/inertiajs/inertia-rails",
            default_version: "3.18.0",
            source_type: "github",
            license_status: "verified",
          },
          version: {
            version: version.version,
            channel: version.channel,
            generated_at: "2026-03-13T00:00:00Z",
            manifest_checksum: version.manifest_checksum,
          },
        },
        meta: { cursor: null },
      });
    }

    const manifestMatch = url.pathname.match(/^\/api\/v1\/libraries\/inertiajs\/inertia-rails\/versions\/([^/]+)\/manifest$/);
    if (method === "GET" && manifestMatch) {
      const version = fixture.versions[manifestMatch[1]];
      return version ? jsonResponse(res, { data: manifestFor(version), meta: { cursor: null } }) : notFound(res);
    }

    const pageIndexMatch = url.pathname.match(/^\/api\/v1\/libraries\/inertiajs\/inertia-rails\/versions\/([^/]+)\/page-index$/);
    if (method === "GET" && pageIndexMatch) {
      const version = fixture.versions[pageIndexMatch[1]];
      return version ? jsonResponse(res, { data: pageIndexFor(version), meta: { cursor: null } }) : notFound(res);
    }

    const pageMatch = url.pathname.match(/^\/api\/v1\/libraries\/inertiajs\/inertia-rails\/versions\/([^/]+)\/pages\/([^/]+)$/);
    if (method === "GET" && pageMatch) {
      const version = fixture.versions[pageMatch[1]];
      const page = version?.pages.find(candidate => candidate.page_uid === pageMatch[2]);
      return page
        ? jsonResponse(res, {
            data: {
              page_uid: page.page_uid,
              path: page.path,
              title: page.title,
              url: page.url,
              content_md: page.content_md,
            },
            meta: { cursor: null },
          })
        : notFound(res);
    }

    return notFound(res);
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fake registry server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function invoke(argv: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  let stdout = "";
  let stderr = "";

  const exitCode = await runCli(argv, {
    env,
    writeStdout: (chunk) => {
      stdout += chunk;
    },
    writeStderr: (chunk) => {
      stderr += chunk;
    },
  });

  return { exitCode, stdout, stderr };
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("contextqmd CLI", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(process.cwd(), "tmp-contextqmd-cli-cache-"));
    cleanups.push(() => rmSync(cacheDir, { recursive: true, force: true }));
  });

  it("publishes the contextqmd binary from the compiled entrypoint", () => {
    expect(packageJson.bin.contextqmd).toBe("dist/index.js");
  });

  it("treats a symlinked binary path as the CLI entrypoint", () => {
    const dir = mkdtempSync(join(process.cwd(), "tmp-contextqmd-cli-entrypoint-"));
    const targetPath = join(dir, "index.js");
    const symlinkPath = join(dir, "contextqmd");

    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    writeFileSync(targetPath, "export {};\n");
    symlinkSync(targetPath, symlinkPath);

    expect(isCliEntrypoint(symlinkPath, pathToFileURL(targetPath).href)).toBe(true);
  });

  it("searches libraries directly against the registry API", async () => {
    const fixture = buildFixture();
    const registry = await startFakeRegistry(fixture);
    cleanups.push(registry.close);

    const result = await invoke(
      ["--registry", registry.baseUrl, "--cache-dir", cacheDir, "--json", "libraries", "search", "inertia rails"],
      { ...process.env, CONTEXTQMD_MCP_COMMAND: "missing-binary" },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      query: "inertia rails",
      results: [
        {
          library: "inertiajs/inertia-rails",
          default_version: "3.18.0",
          versions: ["3.17.0", "3.18.0"],
        },
      ],
    });
    expect(result.stderr).toBe("");
  });

  it("installs docs directly from the page API and supports local docs search/get", async () => {
    const fixture = buildFixture();
    const registry = await startFakeRegistry(fixture);
    cleanups.push(registry.close);

    const install = await invoke(
      [
        "--registry", registry.baseUrl,
        "--cache-dir", cacheDir,
        "--json",
        "libraries", "install", "inertia rails",
        "--version", "3.17.0",
      ],
      { ...process.env, CONTEXTQMD_MCP_COMMAND: "missing-binary" },
    );

    expect(install.exitCode).toBe(0);
    expect(JSON.parse(install.stdout)).toMatchObject({
      library: "inertiajs/inertia-rails",
      version: "3.17.0",
      changed: true,
      install_method: "page_fallback",
      page_count: 1,
    });
    expect(install.stderr).toContain("Resolving inertia rails");
    expect(install.stderr).toContain("Downloading page content 1/1");

    const search = await invoke(
      [
        "--registry", registry.baseUrl,
        "--cache-dir", cacheDir,
        "--json",
        "docs", "search", "file uploads",
        "--library", "inertiajs/inertia-rails",
        "--version", "3.17.0",
        "--mode", "fts",
      ],
      process.env,
    );

    expect(search.exitCode).toBe(0);
    expect(JSON.parse(search.stdout)).toMatchObject({
      results: [
        {
          doc_path: "guides/forms.md",
          page_uid: "forms",
          version: "3.17.0",
        },
      ],
    });

    const getDoc = await invoke(
      [
        "--registry", registry.baseUrl,
        "--cache-dir", cacheDir,
        "docs", "get",
        "--library", "inertiajs/inertia-rails",
        "--version", "3.17.0",
        "--doc-path", "guides/forms.md",
        "--from-line", "1",
        "--max-lines", "3",
      ],
      process.env,
    );

    expect(getDoc.exitCode).toBe(0);
    expect(getDoc.stdout).toContain("# Forms");
    expect(getDoc.stdout).toContain("File uploads are supported.");
  });

  it("updates installed docs in place and removes them locally", async () => {
    const fixture = buildFixture();
    const registry = await startFakeRegistry(fixture);
    cleanups.push(registry.close);

    await invoke(
      [
        "--registry", registry.baseUrl,
        "--cache-dir", cacheDir,
        "libraries", "install", "inertiajs/inertia-rails",
        "--version", "3.17.0",
      ],
      process.env,
    );

    fixture.currentVersion = "3.18.0";

    const update = await invoke(
      [
        "--registry", registry.baseUrl,
        "--cache-dir", cacheDir,
        "--json",
        "libraries", "update", "inertiajs/inertia-rails",
      ],
      process.env,
    );

    expect(update.exitCode).toBe(0);
    expect(JSON.parse(update.stdout)).toMatchObject({
      results: [
        {
          library: "inertiajs/inertia-rails",
          previous_version: "3.17.0",
          version: "3.18.0",
          status: "updated",
        },
      ],
    });

    const remove = await invoke(
      [
        "--registry", registry.baseUrl,
        "--cache-dir", cacheDir,
        "--json",
        "libraries", "remove", "inertiajs/inertia-rails",
        "--version", "3.18.0",
      ],
      process.env,
    );

    expect(remove.exitCode).toBe(0);
    expect(JSON.parse(remove.stdout)).toEqual({
      library: "inertiajs/inertia-rails",
      removed_versions: ["3.18.0"],
    });

    const list = await invoke(
      ["--registry", registry.baseUrl, "--cache-dir", cacheDir, "--json", "libraries", "list"],
      process.env,
    );

    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual({ results: [] });
  });
});
