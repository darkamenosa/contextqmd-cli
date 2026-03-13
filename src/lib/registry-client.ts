import type {
  ApiResponse,
  Library,
  LibrarySearchResult,
  Manifest,
  PageRecord,
  RegistryCapabilities,
  ResolveRequest,
  ResolveResponse,
  Version,
} from "./types.js";

export class RegistryClient {
  private registryUrl: string;
  private baseUrl: string;
  private token?: string;

  constructor(registryUrl: string, token?: string) {
    this.registryUrl = registryUrl.replace(/\/$/, "");
    this.baseUrl = `${this.registryUrl}/api/v1`;
    this.token = token;
  }

  async health(): Promise<ApiResponse<{ status: string; version: string }>> {
    return this.get("health");
  }

  async capabilities(): Promise<ApiResponse<RegistryCapabilities>> {
    return this.get("capabilities");
  }

  async searchLibraries(query: string, cursor?: string): Promise<ApiResponse<LibrarySearchResult[]>> {
    const params = new URLSearchParams({ query });
    if (cursor) params.set("cursor", cursor);
    return this.get(`libraries?${params}`);
  }

  async getLibrary(namespace: string, name: string): Promise<ApiResponse<Library>> {
    return this.get(`libraries/${namespace}/${name}`);
  }

  async getVersions(namespace: string, name: string, cursor?: string): Promise<ApiResponse<Version[]>> {
    const params = cursor ? `?cursor=${cursor}` : "";
    return this.get(`libraries/${namespace}/${name}/versions${params}`);
  }

  async getManifest(namespace: string, name: string, version: string): Promise<ApiResponse<Manifest>> {
    return this.get(`libraries/${namespace}/${name}/versions/${version}/manifest`);
  }

  async getPageIndex(
    namespace: string,
    name: string,
    version: string,
    cursor?: string,
  ): Promise<ApiResponse<PageRecord[]>> {
    const params = cursor ? `?cursor=${cursor}` : "";
    return this.get(`libraries/${namespace}/${name}/versions/${version}/page-index${params}`);
  }

  async getAllPageIndex(namespace: string, name: string, version: string): Promise<PageRecord[]> {
    const maxFetches = 100;
    const allPages: PageRecord[] = [];
    let cursor: string | undefined;
    let iterations = 0;

    do {
      if (++iterations > maxFetches) {
        break;
      }
      const response = await this.getPageIndex(namespace, name, version, cursor);
      allPages.push(...response.data);
      cursor = response.meta.cursor ?? undefined;
    } while (cursor);

    return allPages;
  }

  async getPageContent(
    namespace: string,
    name: string,
    version: string,
    pageUid: string,
  ): Promise<ApiResponse<{ page_uid: string; path: string; title: string; url: string; content_md: string }>> {
    return this.get(`libraries/${namespace}/${name}/versions/${version}/pages/${pageUid}`);
  }

  async resolve(request: ResolveRequest): Promise<ApiResponse<ResolveResponse>> {
    return this.post("resolve", request);
  }

  async downloadBundle(bundleUrl: string): Promise<Buffer> {
    const res = await fetch(this.resolveUrl(bundleUrl), { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`Registry error ${res.status}: ${await res.text()}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(this.resolveUrl(path), { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Registry error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.resolveUrl(path), {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Registry error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private resolveUrl(pathOrUrl: string): string {
    if (/^https?:\/\//.test(pathOrUrl)) {
      return pathOrUrl;
    }

    if (pathOrUrl.startsWith("/")) {
      return new URL(pathOrUrl, `${this.registryUrl}/`).toString();
    }

    return `${this.baseUrl}/${pathOrUrl.replace(/^\/+/, "")}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Token ${this.token}`;
    return headers;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Token ${this.token}` } : {};
  }
}
