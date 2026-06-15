import {
  AetherError,
  AetherApiError,
  AetherNetworkError,
  aetherApiErrorFromResponse,
} from "./errors.js";
import type {
  BatchInsertItem,
  BatchSearchQuery,
  BatchSearchResponse,
  ChunkingConfig,
  DocumentRecord,
  EntityBackfillReport,
  NodeStatus,
  RetrievalResult,
  SearchResult,
} from "./models.js";
/**
 * Read an environment variable if available (Node.js).
 * Returns undefined in browsers where `process` does not exist.
 */
function getEnv(key: string): string | undefined {
  if (typeof process !== "undefined" && process?.env) {
    return process.env[key];
  }
  return undefined;
}

/** Keep in sync with the version field in package.json. */
const SDK_VERSION = "0.1.0-rc.1";

/**
 * User-Agent string for outgoing requests, so the server can attribute
 * traffic by SDK + version. Returns undefined in browsers, where User-Agent
 * is a forbidden header and cannot be set.
 */
function userAgent(): string | undefined {
  if (typeof process !== "undefined" && process?.versions?.node) {
    return `aether-sdk-typescript/${SDK_VERSION} (node/${process.versions.node})`;
  }
  return undefined;
}

/** RFC 4122 v4 UUID, using Web Crypto when available with a safe fallback. */
function randomUUID(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Throw if an API key would be sent over cleartext HTTP to a non-loopback
 * host. Loopback addresses are allowed so local development against a
 * non-TLS node still works.
 */
function enforceSecureBaseUrl(baseUrl: string, apiKey: string | undefined): void {
  if (!apiKey) return;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return; // malformed URLs surface later at request time
  }
  if (url.protocol !== "http:") return;
  const host = url.hostname;
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return;
  throw new AetherError(
    `Refusing to send API key over insecure HTTP to "${host}". ` +
      `Use an https:// base URL, or omit the API key for local non-TLS endpoints.`,
  );
}

export interface AetherClientOptions {
  /**
   * Base URL of the Aether API.
   * Resolved in order: explicit value > AETHER_BASE_URL env var > "https://api.aetherdb.ai"
   */
  baseUrl?: string;
  /**
   * API key for authentication. Sent as Bearer token.
   * Resolved in order: explicit value > AETHER_API_KEY env var > undefined
   */
  apiKey?: string;
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number;
  /** Maximum number of retries for transient errors (429, 502, 503, 504, network). Default: 2 */
  maxRetries?: number;
  /** Base backoff delay in seconds. Delays double each retry (e.g. 0.5s, 1.0s). Default: 0.5 */
  retryBaseDelay?: number;
}

/** Guess MIME type from a filename extension. */
function guessContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    csv: "text/csv",
    html: "text/html",
    htm: "text/html",
    json: "application/json",
    xml: "application/xml",
    md: "text/markdown",
    txt: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}

export class AetherClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelay: number;

  constructor(options: AetherClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      getEnv("AETHER_BASE_URL") ??
      "https://api.aetherdb.ai"
    ).replace(/\/+$/, "");
    const apiKey = options.apiKey ?? getEnv("AETHER_API_KEY");
    enforceSecureBaseUrl(this.baseUrl, apiKey);
    this.headers = {};
    const ua = userAgent();
    if (ua) {
      this.headers["User-Agent"] = ua;
    }
    if (apiKey) {
      this.headers["Authorization"] = `Bearer ${apiKey}`;
    }
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelay = options.retryBaseDelay ?? 0.5;
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Apply the entity/time-window filter options to a URLSearchParams,
   * mapping the camelCase SDK options to their snake_case wire names
   * (`entity_id`, `since`, `until`, `last_n_days`).
   */
  private static applyFilterParams(
    params: URLSearchParams,
    filters?: { entityId?: string; since?: string; until?: string; lastNDays?: number },
  ): void {
    if (!filters) return;
    if (filters.entityId) {
      params.set("entity_id", filters.entityId);
    }
    if (filters.since) {
      params.set("since", filters.since);
    }
    if (filters.until) {
      params.set("until", filters.until);
    }
    if (filters.lastNDays != null) {
      params.set("last_n_days", String(filters.lastNDays));
    }
  }

  private static readonly RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

  /** Low-level fetch with exponential backoff retry for transient errors (429, 502, 503, 504, network). */
  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    const maxAttempts = 1 + this.maxRetries; // initial + retries
    let lastError: Error | undefined;

    // Attach a stable idempotency key to non-idempotent writes so the server
    // can deduplicate a retry whose original response was lost in transit.
    // Computed once here so every attempt of this call reuses the same key.
    const baseHeaders: Record<string, string> = { ...this.headers };
    if ((init.method ?? "GET").toUpperCase() === "POST") {
      baseHeaders["Idempotency-Key"] = randomUUID();
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response: Response | undefined;
      try {
        response = await fetch(url, {
          ...init,
          headers: { ...baseHeaders, ...init?.headers },
          signal: AbortSignal.timeout(this.timeout),
        });

        // Success or non-retryable status -- return immediately
        if (response.ok || !AetherClient.RETRYABLE_STATUS_CODES.has(response.status)) {
          return response;
        }

        lastError = new AetherApiError(response.status, response.statusText, {
          error: response.statusText,
        });
      } catch (err) {
        // Retry on TypeError (network failure) and timeout DOMException
        if (!(err instanceof TypeError) && !(err instanceof DOMException && err.name === "TimeoutError")) {
          throw err;
        }
        const msg =
          err instanceof DOMException && err.name === "TimeoutError"
            ? `Request timed out after ${this.timeout}ms`
            : `Failed to connect to ${this.baseUrl}`;
        lastError = new AetherNetworkError(`${msg}: ${(err as Error).message}`, {
          cause: err,
        });
      }

      // If we have retries left, wait with exponential backoff
      if (attempt < maxAttempts - 1) {
        let delayMs: number;

        // Respect Retry-After header on 429 responses
        if (response?.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          if (retryAfter != null) {
            const parsed = Number(retryAfter);
            delayMs = Number.isNaN(parsed)
              ? // Retry-After may be an HTTP-date; fall back to default backoff
                this.retryBaseDelay * 2 ** attempt * 1000
              : parsed * 1000;
          } else {
            delayMs = this.retryBaseDelay * 2 ** attempt * 1000;
          }
        } else {
          delayMs = this.retryBaseDelay * 2 ** attempt * 1000;
        }

        // Add jitter: random 0-50% of the computed delay
        delayMs += Math.random() * 0.5 * delayMs;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw lastError!;
  }

  private async _request<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.requestWithRetry(url, init ?? {});

    if (!response.ok) {
      let body: { error: string; code?: string };
      try {
        body = (await response.json()) as { error: string; code?: string };
      } catch {
        body = { error: response.statusText };
      }
      throw aetherApiErrorFromResponse(response.status, response.statusText, body);
    }

    return (await response.json()) as T;
  }

  private async _requestRaw(
    path: string,
    init?: RequestInit,
  ): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.requestWithRetry(url, init ?? {});

    if (!response.ok) {
      let body: { error: string; code?: string };
      try {
        body = (await response.json()) as { error: string; code?: string };
      } catch {
        body = { error: response.statusText };
      }
      throw aetherApiErrorFromResponse(response.status, response.statusText, body);
    }

    return response.arrayBuffer();
  }

  /** Low-level fetch without retries. Used for streaming uploads where the body is not re-readable. */
  private async _requestNoRetry<T>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const baseHeaders: Record<string, string> = { ...this.headers };
    if ((init.method ?? "GET").toUpperCase() === "POST") {
      baseHeaders["Idempotency-Key"] = randomUUID();
    }
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...baseHeaders, ...init?.headers },
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new AetherNetworkError(
          `Request timed out after ${this.timeout}ms: ${(err as Error).message}`,
          { cause: err },
        );
      }
      if (err instanceof TypeError) {
        throw new AetherNetworkError(
          `Failed to connect to ${this.baseUrl}: ${(err as Error).message}`,
          { cause: err },
        );
      }
      throw err;
    }

    if (!response.ok) {
      let body: { error: string; code?: string };
      try {
        body = (await response.json()) as { error: string; code?: string };
      } catch {
        body = { error: response.statusText };
      }
      throw aetherApiErrorFromResponse(response.status, response.statusText, body);
    }

    return (await response.json()) as T;
  }

  // ── Documents ─────────────────────────────────────────────────────

  /**
   * Insert a document from raw bytes.
   * If `contentType` is omitted it is guessed from the filename extension.
   *
   * @param data - Raw document bytes.
   * @param options - Insert options.
   * @param options.filename - Filename for the document (required).
   * @param options.contentType - MIME type. Guessed from filename if omitted.
   * @param options.tags - Metadata tags for filtering.
   * @param options.entityId - Caller-supplied entity to associate the document with.
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns The created document record.
   * @throws {AetherError} If filename is empty or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insert(
    data: Uint8Array,
    options: { filename: string; contentType?: string; tags?: string[]; entityId?: string; chunking?: ChunkingConfig },
  ): Promise<DocumentRecord> {
    if (!options.filename) throw new AetherError("filename is required");
    if (options.chunking?.chunkSize !== undefined && options.chunking.chunkSize < 1) {
      throw new AetherError("chunkSize must be at least 1");
    }
    if (options.chunking?.overlap !== undefined && options.chunking.overlap < 0) {
      throw new AetherError("overlap must be non-negative");
    }
    const params = new URLSearchParams({
      filename: options.filename,
      content_type:
        options.contentType ?? guessContentType(options.filename),
    });
    if (options.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options.entityId) {
      params.set("entity_id", options.entityId);
    }
    if (options.chunking?.chunkSize) {
      params.set("chunk_size", options.chunking.chunkSize.toString());
    }
    if (options.chunking?.overlap !== undefined) {
      params.set("overlap", options.chunking.overlap.toString());
    }
    return this._request<DocumentRecord>(`/documents?${params}`, {
      method: "POST",
      body: data as unknown as BodyInit,
    });
  }

  /**
   * Insert a document from a ReadableStream without buffering the entire body in memory.
   * Unlike {@link insert}, this method does **not** retry on transient errors because
   * the stream may not be re-readable.
   *
   * @param stream - Readable byte stream of document content.
   * @param options - Insert options.
   * @param options.filename - Filename for the document. Defaults to `"upload.bin"`.
   * @param options.contentType - MIME type. Defaults to `"application/octet-stream"`.
   * @param options.tags - Metadata tags for filtering.
   * @param options.entityId - Caller-supplied entity to associate the document with.
   * @returns The created document record.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insertStream(
    stream: ReadableStream<Uint8Array>,
    options?: { filename?: string; contentType?: string; tags?: string[]; entityId?: string },
  ): Promise<DocumentRecord> {
    const filename = options?.filename ?? "upload.bin";
    const contentType = options?.contentType ?? "application/octet-stream";
    const params = new URLSearchParams({
      filename,
      content_type: contentType,
    });
    if (options?.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options?.entityId) {
      params.set("entity_id", options.entityId);
    }
    return this._requestNoRetry<DocumentRecord>(`/documents?${params}`, {
      method: "POST",
      body: stream,
      // @ts-expect-error -- duplex is required by Node.js fetch for streaming bodies
      duplex: "half",
    });
  }

  /**
   * Insert a document from a raw text string.
   * Content type is always `text/plain`; filename defaults to `"text.txt"`.
   *
   * @param text - The text content to insert (must be non-empty).
   * @param options - Insert options.
   * @param options.filename - Filename for the document. Defaults to `"text.txt"`.
   * @param options.tags - Metadata tags for filtering.
   * @param options.entityId - Caller-supplied entity to associate the document with.
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns The created document record.
   * @throws {AetherError} If text is empty or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insertText(
    text: string,
    options?: { filename?: string; tags?: string[]; entityId?: string; chunking?: ChunkingConfig },
  ): Promise<DocumentRecord> {
    if (!text) throw new AetherError("text is required");
    if (options?.chunking?.chunkSize !== undefined && options.chunking.chunkSize < 1) {
      throw new AetherError("chunkSize must be at least 1");
    }
    if (options?.chunking?.overlap !== undefined && options.chunking.overlap < 0) {
      throw new AetherError("overlap must be non-negative");
    }
    const filename = options?.filename ?? "text.txt";
    const params = new URLSearchParams({
      filename,
      content_type: "text/plain",
    });
    if (options?.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options?.entityId) {
      params.set("entity_id", options.entityId);
    }
    if (options?.chunking?.chunkSize) {
      params.set("chunk_size", options.chunking.chunkSize.toString());
    }
    if (options?.chunking?.overlap !== undefined) {
      params.set("overlap", options.chunking.overlap.toString());
    }
    return this._request<DocumentRecord>(`/documents?${params}`, {
      method: "POST",
      body: new TextEncoder().encode(text) as unknown as BodyInit,
    });
  }

  /**
   * Replace an existing document with new content.
   * The document retains its ID but all chunks and vectors are regenerated.
   *
   * @param docId - ID of the document to replace.
   * @param data - Raw replacement bytes.
   * @param options - Update options.
   * @param options.filename - New filename for the document (required).
   * @param options.contentType - MIME type. Guessed from filename if omitted.
   * @param options.tags - Metadata tags for filtering (replaces existing tags).
   * @param options.entityId - Caller-supplied entity to associate the document with.
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns The updated document record.
   * @throws {AetherError} If docId or filename is empty, or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async update(
    docId: string,
    data: Uint8Array,
    options: { filename: string; contentType?: string; tags?: string[]; entityId?: string; chunking?: ChunkingConfig },
  ): Promise<DocumentRecord> {
    if (!docId) throw new AetherError("docId is required");
    if (!options.filename) throw new AetherError("filename is required");
    if (options.chunking?.chunkSize !== undefined && options.chunking.chunkSize < 1) {
      throw new AetherError("chunkSize must be at least 1");
    }
    if (options.chunking?.overlap !== undefined && options.chunking.overlap < 0) {
      throw new AetherError("overlap must be non-negative");
    }
    const params = new URLSearchParams({
      filename: options.filename,
      content_type:
        options.contentType ?? guessContentType(options.filename),
    });
    if (options.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options.entityId) {
      params.set("entity_id", options.entityId);
    }
    if (options.chunking?.chunkSize) {
      params.set("chunk_size", options.chunking.chunkSize.toString());
    }
    if (options.chunking?.overlap !== undefined) {
      params.set("overlap", options.chunking.overlap.toString());
    }
    return this._request<DocumentRecord>(
      `/documents/${encodeURIComponent(docId)}?${params}`,
      { method: "PUT", body: data as unknown as BodyInit },
    );
  }

  /**
   * Get document metadata by ID.
   *
   * @param docId - ID of the document to retrieve.
   * @returns The document metadata record.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async get(docId: string): Promise<DocumentRecord> {
    if (!docId) throw new AetherError("docId is required");
    return this._request<DocumentRecord>(
      `/documents/${encodeURIComponent(docId)}`,
    );
  }

  /**
   * Download the raw bytes of a document.
   *
   * @param docId - ID of the document to download.
   * @returns The document content as an ArrayBuffer.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async download(docId: string): Promise<ArrayBuffer> {
    if (!docId) throw new AetherError("docId is required");
    return this._requestRaw(
      `/documents/${encodeURIComponent(docId)}/download`,
    );
  }

  /**
   * Download a document and decode its content as a UTF-8 string.
   *
   * @param docId - ID of the document to download.
   * @returns The document content as a string.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async downloadText(docId: string): Promise<string> {
    if (!docId) throw new AetherError("docId is required");
    const buf = await this.download(docId);
    return new TextDecoder().decode(buf);
  }

  /**
   * Search and return results with document content included.
   *
   * Combines {@link search} + {@link downloadText} into a single call for RAG workflows.
   * Results are deduplicated by `doc_id` (closest match wins).
   * Uses server-side `include_content` when available, falling back to per-doc downloads.
   *
   * @param query - Natural-language search query.
   * @param k - Maximum number of results to return. Defaults to `5`.
   * @param options - Retrieval options.
   * @param options.tags - Filter results to documents matching these tags.
   * @param options.maxDistance - Optional cosine-distance ceiling. Results with
   *   `distance > maxDistance` are dropped server-side, after reranking. Omit to
   *   return the top-k regardless of distance (the historical behavior).
   * @param options.entityId - Restrict results to documents belonging to this entity.
   * @param options.since - Only match documents created at or after this RFC3339 timestamp.
   * @param options.until - Only match documents created at or before this RFC3339 timestamp.
   * @param options.lastNDays - Convenience window: only match documents from the last N days.
   * @returns Deduplicated search results with full document content attached.
   * @throws {AetherError} If query is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async retrieve(
    query: string,
    k: number = 5,
    options?: { tags?: string[]; maxDistance?: number; entityId?: string; since?: string; until?: string; lastNDays?: number },
  ): Promise<RetrievalResult[]> {
    if (!query) throw new AetherError("query is required");
    if (k < 1) throw new AetherError("k must be at least 1");
    const results = await this.search(query, k, {
      includeContent: true,
      tags: options?.tags,
      maxDistance: options?.maxDistance,
      entityId: options?.entityId,
      since: options?.since,
      until: options?.until,
      lastNDays: options?.lastNDays,
    });

    // Deduplicate by doc_id, keeping the closest match
    const seen = new Map<string, SearchResult>();
    for (const r of results) {
      if (!seen.has(r.doc_id)) {
        seen.set(r.doc_id, r);
      }
    }

    const unique = Array.from(seen.values());

    // Use inline content if server provided it, otherwise download
    const needsDownload = unique.filter((r) => r.content == null);
    if (needsDownload.length > 0) {
      const downloaded = await Promise.all(
        needsDownload.map((r) => this.downloadText(r.doc_id)),
      );
      const contentMap = new Map<string, string>();
      needsDownload.forEach((r, i) => contentMap.set(r.doc_id, downloaded[i]));
      return unique.map((r) => ({
        ...r,
        content: r.content ?? contentMap.get(r.doc_id)!,
      }));
    }

    return unique.map((r) => ({
      ...r,
      content: r.content!,
    }));
  }

  /**
   * List active (non-tombstoned) documents with pagination.
   *
   * @param options - Pagination options.
   * @param options.offset - Number of documents to skip. Defaults to `0`.
   * @param options.limit - Maximum number of documents to return.
   * @param options.entityId - Restrict the listing to documents belonging to this entity.
   * @param options.since - Only list documents created at or after this RFC3339 timestamp.
   * @param options.until - Only list documents created at or before this RFC3339 timestamp.
   * @param options.lastNDays - Convenience window: only list documents from the last N days.
   * @returns An object containing the document list, total count, and whether more pages exist.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async list(options?: {
    offset?: number;
    limit?: number;
    entityId?: string;
    since?: string;
    until?: string;
    lastNDays?: number;
  }): Promise<{ documents: DocumentRecord[]; total: number; has_more: boolean }> {
    const params = new URLSearchParams();
    if (options?.offset != null) params.set("offset", String(options.offset));
    if (options?.limit != null) params.set("limit", String(options.limit));
    AetherClient.applyFilterParams(params, options);
    const query = params.toString();
    const body = await this._request<{
      documents: DocumentRecord[];
      count: number;
      total: number;
      offset: number;
      limit: number;
      has_more: boolean;
    }>(`/documents${query ? `?${query}` : ""}`);
    return { documents: body.documents, total: body.total, has_more: body.has_more };
  }

  /**
   * Soft-delete (tombstone) a document.
   * The document is hidden from searches and listings but can be restored with {@link restore}.
   *
   * @param docId - ID of the document to delete.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async delete(docId: string): Promise<void> {
    if (!docId) throw new AetherError("docId is required");
    await this._request(`/documents/${encodeURIComponent(docId)}`, {
      method: "DELETE",
    });
  }

  /**
   * Restore a previously tombstoned document, making it visible in searches and listings again.
   *
   * @param docId - ID of the document to restore.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async restore(docId: string): Promise<void> {
    if (!docId) throw new AetherError("docId is required");
    await this._request(
      `/documents/${encodeURIComponent(docId)}/restore`,
      { method: "POST" },
    );
  }

  /**
   * Backfill `entity_id` on existing documents by deriving it from a tag prefix.
   * For every document carrying a tag like `"<tagPrefix><value>"`, the server
   * sets `entity_id` to `<value>`. Use this to migrate a tag-based grouping
   * convention onto the first-class entity field.
   *
   * By default documents that already have an `entity_id` are left untouched;
   * pass `overwrite: true` to replace existing values.
   *
   * @param tagPrefix - The tag prefix identifying the entity (e.g. `"user:"`). Required.
   * @param opts - Backfill options.
   * @param opts.overwrite - When `true`, overwrite documents that already have an `entity_id`. Defaults to `false`.
   * @returns A report of how many documents were scanned, matched, updated, skipped, ambiguous, or errored.
   * @throws {AetherError} If tagPrefix is empty.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async backfillEntityFromTags(
    tagPrefix: string,
    opts?: { overwrite?: boolean },
  ): Promise<EntityBackfillReport> {
    if (!tagPrefix) throw new AetherError("tagPrefix is required");
    return this._request<EntityBackfillReport>("/documents/backfill-entity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_prefix: tagPrefix,
        overwrite: opts?.overwrite ?? false,
      }),
    });
  }

  // ── Search ────────────────────────────────────────────────────────

  /**
   * Perform similarity search across all active documents.
   *
   * @param query - Natural-language search query.
   * @param k - Maximum number of results to return. Defaults to `10`.
   * @param options - Search options.
   * @param options.includeContent - When `true`, include document/passage content in results.
   * @param options.tags - Filter results to documents matching these tags.
   * @param options.maxDistance - Optional cosine-distance ceiling. Results with
   *   `distance > maxDistance` are dropped server-side, after reranking. Smaller
   *   = stricter (0.0 = exact match, ~1.0 = unrelated). Omit to return the
   *   top-k regardless of distance (the historical behavior).
   * @param options.entityId - Restrict results to documents belonging to this entity.
   * @param options.since - Only match documents created at or after this RFC3339 timestamp.
   * @param options.until - Only match documents created at or before this RFC3339 timestamp.
   * @param options.lastNDays - Convenience window: only match documents from the last N days.
   * @returns Array of search results ordered by similarity (closest first).
   * @throws {AetherError} If query is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async search(
    query: string,
    k: number = 10,
    options?: { includeContent?: boolean; tags?: string[]; maxDistance?: number; entityId?: string; since?: string; until?: string; lastNDays?: number },
  ): Promise<SearchResult[]> {
    if (!query) throw new AetherError("query is required");
    if (k < 1) throw new AetherError("k must be at least 1");
    const params = new URLSearchParams({ q: query, k: String(k) });
    if (options?.includeContent) {
      params.set("include_content", "true");
    }
    if (options?.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options?.maxDistance != null) {
      params.set("max_distance", String(options.maxDistance));
    }
    AetherClient.applyFilterParams(params, options);
    const body = await this._request<{
      query: string;
      results: SearchResult[];
    }>(`/search?${params}`);
    return body.results;
  }

  // ── BYOE (Bring Your Own Embeddings) ────────────────────────────

  /**
   * Insert a document with caller-provided embeddings (BYOE -- Bring Your Own Embeddings).
   * Use this when you generate embeddings externally and want Aether to store them as-is.
   *
   * @param options - Insert options.
   * @param options.content - The full text content of the document.
   * @param options.passages - Array of passages, each with its text and pre-computed embedding vector.
   * @param options.embedding - Single embedding vector for the entire document (alternative to passages).
   * @param options.filename - Filename for the document. Defaults to `"text.txt"`.
   * @param options.contentType - MIME type. Defaults to `"text/plain"`.
   * @param options.tags - Metadata tags for filtering.
   * @param options.entityId - Caller-supplied entity to associate the document with.
   * @returns The created document record.
   * @throws {AetherError} If content is empty, or neither passages nor embedding is provided.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insertWithEmbeddings(options: {
    content: string;
    passages?: Array<{ text: string; embedding: number[] }>;
    embedding?: number[];
    filename?: string;
    contentType?: string;
    tags?: string[];
    entityId?: string;
  }): Promise<DocumentRecord> {
    if (!options.content) throw new AetherError("content is required");
    if (!options.passages?.length && !options.embedding?.length) {
      throw new AetherError("either passages or embedding must be provided and non-empty");
    }
    return this._request<DocumentRecord>("/documents/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: options.content,
        passages: options.passages,
        embedding: options.embedding,
        filename: options.filename ?? "text.txt",
        content_type: options.contentType ?? "text/plain",
        tags: options.tags,
        entity_id: options.entityId,
      }),
    });
  }

  /**
   * Search using a pre-computed query embedding vector (BYOE -- Bring Your Own Embeddings).
   * Use this when you generate query embeddings externally instead of relying on server-side embedding.
   *
   * @param embedding - Pre-computed query embedding vector (must be non-empty).
   * @param k - Maximum number of results to return. Defaults to `10`.
   * @param options - Search options.
   * @param options.includeContent - When `true`, include document/passage content in results.
   * @param options.tags - Filter results to documents matching these tags.
   * @param options.maxDistance - Optional cosine-distance ceiling. See {@link search}.
   * @param options.entityId - Restrict results to documents belonging to this entity.
   * @param options.since - Only match documents created at or after this RFC3339 timestamp.
   * @param options.until - Only match documents created at or before this RFC3339 timestamp.
   * @param options.lastNDays - Convenience window: only match documents from the last N days.
   * @returns Array of search results ordered by similarity (closest first).
   * @throws {AetherError} If embedding is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async searchByVector(
    embedding: number[],
    k: number = 10,
    options?: { includeContent?: boolean; tags?: string[]; maxDistance?: number; entityId?: string; since?: string; until?: string; lastNDays?: number },
  ): Promise<SearchResult[]> {
    if (!embedding || embedding.length === 0) throw new AetherError("embedding must be a non-empty array");
    if (k < 1) throw new AetherError("k must be at least 1");
    const body = await this._request<{
      query: string;
      results: SearchResult[];
    }>("/search/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embedding,
        k,
        include_content: options?.includeContent ?? false,
        tags: options?.tags,
        max_distance: options?.maxDistance,
        entity_id: options?.entityId,
        since: options?.since,
        until: options?.until,
        last_n_days: options?.lastNDays,
      }),
    });
    return body.results;
  }

  // ── Async Processing ──────────────────────────────────────────────

  /**
   * Enqueue a document for asynchronous processing.
   * Useful for large documents where synchronous insertion would exceed timeout limits.
   * Poll the returned `poll_url` or use {@link waitForJob} to track completion.
   *
   * @param data - Raw document bytes.
   * @param options - Insert options.
   * @param options.filename - Filename for the document (required).
   * @param options.contentType - MIME type. Guessed from filename if omitted.
   * @param options.tags - Metadata tags for filtering.
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns An object with the `job_id`, current `status`, and `poll_url` for tracking progress.
   * @throws {AetherError} If filename is empty or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insertAsync(
    data: Uint8Array,
    options: { filename: string; contentType?: string; tags?: string[]; chunking?: ChunkingConfig },
  ): Promise<{ job_id: string; status: string; poll_url: string }> {
    if (!options.filename) throw new AetherError("filename is required");
    if (options.chunking?.chunkSize !== undefined && options.chunking.chunkSize < 1) {
      throw new AetherError("chunkSize must be at least 1");
    }
    if (options.chunking?.overlap !== undefined && options.chunking.overlap < 0) {
      throw new AetherError("overlap must be non-negative");
    }
    const params = new URLSearchParams({
      filename: options.filename,
      content_type: options.contentType ?? guessContentType(options.filename),
    });
    if (options.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options.chunking?.chunkSize) {
      params.set("chunk_size", options.chunking.chunkSize.toString());
    }
    if (options.chunking?.overlap !== undefined) {
      params.set("overlap", options.chunking.overlap.toString());
    }
    return this._request<{ job_id: string; status: string; poll_url: string }>(`/documents/async?${params}`, {
      method: "POST",
      body: data as unknown as BodyInit,
    });
  }

  /**
   * Poll a background document job until it reaches a terminal state (`"completed"` or `"failed"`).
   *
   * @param jobId - ID of the async job returned by {@link insertAsync}.
   * @param options - Polling options.
   * @param options.timeoutMs - Maximum time to wait in milliseconds. Defaults to `60000` (60 s).
   * @param options.pollIntervalMs - Delay between polls in milliseconds. Defaults to `1000` (1 s).
   * @returns The final job status, including `doc_id` on success or `error` on failure.
   * @throws {AetherError} If jobId is empty.
   * @throws {AetherApiError} With status 408 if polling times out, or on non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async waitForJob(
    jobId: string,
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<{ status: string; doc_id?: string; error?: string }> {
    if (!jobId) throw new AetherError("jobId is required");
    const timeout = options?.timeoutMs ?? 60000;
    const interval = options?.pollIntervalMs ?? 1000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const job = await this._request<{ status: string; doc_id?: string; error?: string }>(`/documents/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === "completed" || job.status === "failed") {
        return job;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new AetherApiError(408, "Job Timeout", { error: "Job polling timed out" });
  }

  // ── Cluster ───────────────────────────────────────────────────────

  /**
   * Get the current node's status, including document/vector counts and version.
   *
   * @returns The node status object.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async status(): Promise<NodeStatus> {
    return this._request<NodeStatus>("/status");
  }

  /**
   * Fetch the live $/GiB price for permanent archive uploads (Arweave/Irys).
   * Mirrors the gateway's 5-minute cached upstream price. Useful for showing
   * customers their archive cost before flipping the `permanentArchive`
   * toggle. Returns 404 from the server when the gateway is configured
   * without an upstream URL — surfaces here as `AetherApiError`.
   *
   * @returns Provider, price per GiB in cents, and the cache window.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async getArchivePrice(): Promise<{
    provider: string;
    unit_price_cents_per_gib: number;
    fetched_at: string;
    cache_ttl_seconds: number;
  }> {
    return this._request("/archive/price");
  }

  // Note: Cluster operations (sync, snapshot, checkpoint, recover, validate)
  // are admin-only and not exposed in the public SDK. Use the REST API
  // directly with an admin API key for operational tasks.

  /**
   * Insert multiple text documents in a single batch request.
   * More efficient than calling {@link insertText} in a loop because the server
   * processes all documents in one round-trip.
   *
   * @param documents - Array of documents to insert, each with `filename`, `content`, and optional `tags`.
   * @param options - Batch options.
   * @param options.chunking - Chunking configuration applied to all documents in the batch.
   * @returns Array of created document records, one per input document.
   * @throws {AetherError} If documents array is empty or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async batchInsert(
    documents: BatchInsertItem[],
    options?: { chunking?: ChunkingConfig },
  ): Promise<DocumentRecord[]> {
    if (!documents || documents.length === 0) throw new AetherError("documents must be a non-empty array");
    if (options?.chunking?.chunkSize !== undefined && options.chunking.chunkSize < 1) {
      throw new AetherError("chunkSize must be at least 1");
    }
    if (options?.chunking?.overlap !== undefined && options.chunking.overlap < 0) {
      throw new AetherError("overlap must be non-negative");
    }
    const payload = {
      documents: documents.map(({ entityId, ...doc }) => ({
        ...doc,
        tags: doc.tags && doc.tags.length > 0 ? doc.tags.join(",") : undefined,
        entity_id: entityId,
      })),
      chunk_size: options?.chunking?.chunkSize,
      overlap: options?.chunking?.overlap,
    };
    const res = await this._request<{ results: DocumentRecord[] }>(
      "/documents/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    return res.results;
  }


  /**
   * Run multiple search queries in a single batch request.
   * More efficient than calling {@link search} in a loop because the server
   * processes all queries in one round-trip.
   *
   * @param queries - Array of search queries, each with `q`, optional `k`, `tags`, and `include_content`.
   * @returns Array of batch search responses, one per input query, each containing its results.
   * @throws {AetherError} If queries array is empty.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async batchSearch(queries: BatchSearchQuery[]): Promise<BatchSearchResponse[]> {
    if (!queries || queries.length === 0) throw new AetherError("queries must be a non-empty array");
    const res = await this._request<{ results: BatchSearchResponse[] }>(
      "/search/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: queries.map(({ entityId, lastNDays, ...query }) => ({
            ...query,
            tags: query.tags && query.tags.length > 0 ? query.tags.join(",") : undefined,
            entity_id: entityId,
            last_n_days: lastNDays,
          })),
        }),
      },
    );
    return res.results;
  }
}
