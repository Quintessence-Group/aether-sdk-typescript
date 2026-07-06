import * as fs from "node:fs";
import * as path from "node:path";
import {
  AetherError,
  AetherApiError,
  AetherNetworkError,
  aetherApiErrorFromResponse,
} from "./errors.js";
import type {
  AggregateResult,
  AuditRecord,
  BatchInsertItem,
  BatchSearchQuery,
  BatchSearchResponse,
  ChunkingConfig,
  DocumentRecord,
  EntityBackfillReport,
  FieldSchema,
  FieldSchemaInput,
  QueryGroup,
  QueryPage,
  SchemaOps,
  IngestResult,
  IsolationCheck,
  Metadata,
  MetadataFilter,
  NodeStatus,
  PartitionInfo,
  PartitionList,
  PartitionWarning,
  RetrievalResult,
  SearchFeedbackSignal,
  SearchResult,
  SearchTrace,
  TracedSearch,
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

/**
 * SDK version, injected at build time from package.json (see the `define`
 * blocks in tsup.config.ts and vitest.config.ts) so it can never drift from
 * the package metadata. Falls back to a neutral placeholder when compiled
 * without the injection (e.g. a raw `tsc` build).
 */
declare const __AETHER_SDK_VERSION__: string | undefined;
const SDK_VERSION: string =
  typeof __AETHER_SDK_VERSION__ === "string" ? __AETHER_SDK_VERSION__ : "0.0.0";

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

/**
 * Extension → content type for batch ingestion. Explicit so common
 * document types resolve the same way on every machine regardless of any local
 * mime database, and so an unknown extension can fall back to `undefined`
 * (letting the engine guess) rather than always being forced to a wrong type.
 * Keys are lowercase and include the leading dot. Mirrors the Python SDK's
 * `INGEST_CONTENT_TYPES`.
 */
export const INGEST_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".text": "text/plain",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
};

/**
 * Best-effort content type for a file path used by {@link AetherClient.ingestFiles}
 * / {@link AetherClient.ingestDirectory}: the explicit {@link INGEST_CONTENT_TYPES}
 * map first, then a broader extension lookup ({@link guessContentType}). Returns
 * `undefined` for an extension that maps to nothing recognizable, which lets the
 * insert path fall back to the engine's own guess. Mirrors the Python SDK's
 * `resolve_content_type`.
 */
export function resolveContentType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (ext in INGEST_CONTENT_TYPES) {
    return INGEST_CONTENT_TYPES[ext];
  }
  const guessed = guessContentType(filePath);
  return guessed === "application/octet-stream" ? undefined : guessed;
}

/** Maximum partition id length accepted by the server. */
const MAX_PARTITION_LEN = 256;

/**
 * Strip trailing slashes from a base URL. A single reverse scan is used rather
 * than the natural `/\/+$/` regex: that regex is unanchored at the start and
 * backtracks quadratically on adversarial input (e.g. a host followed by many
 * slashes and a trailing non-slash), a polynomial-ReDoS footgun. This runs in
 * guaranteed linear time.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return url.slice(0, end);
}

/**
 * Canonical public API version prefix. Every data route (documents, search,
 * memory, partitions, archive) is served under this prefix. The public probe
 * route `GET /status` is intentionally unversioned.
 */
const API_VERSION_PREFIX = "/v1";
const UNVERSIONED_PATHS = new Set(["/status"]);

/**
 * Prefix a relative request path with the public API version. The prefix
 * always goes before the path itself, never into the query string.
 * Unversioned probe routes (`/status`) pass through untouched.
 */
function versionedPath(path: string): string {
  const bare = path.split("?", 1)[0];
  return UNVERSIONED_PATHS.has(bare) ? path : `${API_VERSION_PREFIX}${path}`;
}

export class AetherClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelay: number;
  /**
   * The partition every read and write on this instance is scoped to, or
   * `undefined` for the default (unscoped) client. Immutable, set only by
   * {@link partition}. Never a method parameter — it is read off the instance
   * so a scope can never be forgotten or overridden per call.
   */
  private readonly partitionId?: string;

  constructor(options: AetherClientOptions = {}) {
    this.baseUrl = stripTrailingSlashes(
      options.baseUrl ??
        getEnv("AETHER_BASE_URL") ??
        "https://api.aetherdb.ai",
    );
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

  // ── Partition scoping ─────────────────────────────────────────────

  /**
   * Return a partition-scoped clone of this client.
   *
   * Every partition-aware read and write on the returned handle is automatically
   * scoped to `partitionId` on the wire — there is no per-call partition argument
   * anywhere, so the scope cannot be forgotten. Cross-partition access requires
   * obtaining a separate handle (`client.partition("a")` vs `client.partition("b")`),
   * never omitting or adding an argument.
   *
   * The clone **shares** this client's transport and all configuration (base URL,
   * auth header, timeout, retries, backoff); it does not own them, so there is no
   * separate resource to dispose. Re-scoping is last-wins:
   * `client.partition("a").partition("b")` is scoped to `"b"`.
   *
   * Behavior: under a multi-tenant key every read and write must name a partition,
   * and an unscoped call fails with the server's normal API error; under a
   * single-tenant key, unscoped calls operate on the default partition. The handle
   * is the ergonomic way to always send it.
   *
   * ID-addressed calls (`get`, `download` / `downloadText`, `delete`, `restore`,
   * `update`) send the partition as a **guard**: a doc id that lives in another
   * partition returns the same 404 as a nonexistent id, so a scoped handle can
   * never reach across the boundary via a bare doc id.
   *
   * @param partitionId - The partition to scope every operation to (1–256 chars,
   *   non-empty / non-whitespace).
   * @returns A scoped clone of this client sharing the same transport and config.
   * @throws {AetherError} If `partitionId` is empty/whitespace or longer than 256
   *   characters (client-side — never a network round-trip).
   */
  partition(partitionId: string): AetherClient {
    if (!partitionId || partitionId.trim().length === 0) {
      throw new AetherError("partitionId is required");
    }
    if (partitionId.length > MAX_PARTITION_LEN) {
      throw new AetherError(
        `partitionId must be at most ${MAX_PARTITION_LEN} characters`,
      );
    }
    // Scoped clone: shares transport (fetch config) and ALL config/headers with
    // an immutable partitionId set. Does NOT own the transport — there is nothing
    // to dispose. Mirrors the Memory facade's `ownsClient: false` borrow.
    return Object.assign(
      Object.create(AetherClient.prototype) as AetherClient,
      this,
      { partitionId },
    );
  }

  /**
   * Add the instance's partition to a query-route param set, if scoped. Mirrors
   * the `entity_id` encoding (URLSearchParams URL-encodes the value).
   */
  private applyPartitionParam(params: URLSearchParams): void {
    if (this.partitionId) {
      params.set("partition", this.partitionId);
    }
  }

  /**
   * Transport hook for the {@link Memory} memory-graph facade (`/v1/memory/*`).
   *
   * Builds a request from a query-param record (the caller supplies `entity_id`
   * plus any filters), auto-injects this client's partition, and reuses the
   * standard retry/error/timeout transport. **Not part of the public API** — it
   * is `@internal` (stripped from the published `.d.ts`); use {@link Memory}.
   *
   * @internal
   */
  async memoryRequest<T>(
    method: string,
    path: string,
    query: Record<string, string | number | boolean>,
    body?: unknown,
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) params.set(k, String(v));
    this.applyPartitionParam(params);
    const qs = params.toString();
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return this._request<T>(`${path}${qs ? `?${qs}` : ""}`, init);
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Normalize a raw document record so the metadata fields are always present:
   * `tags` defaults to `[]` and `source` and `partition` default to `null`
   * when the server omits them (older payloads; a `null` partition means the
   * default partition). Other fields pass through unchanged.
   */
  private static normalizeDocument(d: DocumentRecord): DocumentRecord {
    return {
      ...d,
      tags: d.tags ?? [],
      source: d.source ?? null,
      metadata: d.metadata ?? {},
      partition: d.partition ?? null,
    };
  }

  /**
   * Normalize a raw search hit so `tags` defaults to `[]` and `source` and
   * `partition` default to `null` when the server omits them (older payloads;
   * a `null` partition means the default partition). The engine's
   * calibrated `score` (0–100, higher = better) is surfaced verbatim.
   * `created_at` is left as-is (the wire string, or `undefined` when absent);
   * `updated_at` follows the same convention but defaults to `null` when the
   * server omits it (the document has never been updated since insert).
   *
   * `queryId` is the response-level feedback handle (present only when
   * usage-feedback capture is enabled for the tenant); it is stamped onto every
   * hit so a caller can pass it straight to {@link sendSearchFeedback}. Absent
   * -> `undefined`, like the other optional fields.
   */
  private static normalizeResult(r: SearchResult, queryId?: string): SearchResult {
    return {
      ...r,
      tags: r.tags ?? [],
      source: r.source ?? null,
      metadata: r.metadata ?? {},
      partition: r.partition ?? null,
      updated_at: r.updated_at ?? null,
      queryId,
    };
  }

  private static setJsonParam(
    params: URLSearchParams,
    key: string,
    value: unknown,
  ): void {
    if (value !== undefined) {
      params.set(key, JSON.stringify(value));
    }
  }

  /**
   * Encode an array filter as a comma-separated string on a wire object, in
   * place: sets `obj[key]` to the joined value when the array is non-empty,
   * otherwise removes the key so empty filters drop out of the request. Mirrors
   * the `.join(",")` convention used by the GET query-param routes.
   */
  private static csvField(
    obj: Record<string, unknown>,
    key: string,
    value: string[] | undefined,
  ): void {
    if (value && value.length > 0) {
      obj[key] = value.join(",");
    } else {
      delete obj[key];
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
    // Data routes are rewritten under the /v1 API version prefix here, at the
    // transport boundary, so every caller (including the Memory facade)
    // versions its paths in one place.
    const url = `${this.baseUrl}${versionedPath(path)}`;
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
    const url = `${this.baseUrl}${versionedPath(path)}`;
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
    const url = `${this.baseUrl}${versionedPath(path)}`;
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
   * @param options.metadata - Structured metadata for filtering.
   * @param options.entityId - Entity this document belongs to (e.g. a user or customer id), for filtering.
   * @param options.source - Origin/source of this document (e.g. `"slack"`, `"notion"`), for filtering.
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns The created document record.
   * @throws {AetherError} If filename is empty or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insert(
    data: Uint8Array,
    options: {
      filename: string;
      contentType?: string;
      tags?: string[];
      metadata?: Metadata;
      entityId?: string;
      source?: string;
      chunking?: ChunkingConfig;
    },
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
    if (options.source) {
      params.set("source", options.source);
    }
    AetherClient.setJsonParam(params, "metadata", options.metadata);
    this.applyPartitionParam(params);
    if (options.chunking?.chunkSize) {
      params.set("chunk_size", options.chunking.chunkSize.toString());
    }
    if (options.chunking?.overlap !== undefined) {
      params.set("overlap", options.chunking.overlap.toString());
    }
    const record = await this._request<DocumentRecord>(`/documents?${params}`, {
      method: "POST",
      body: data as unknown as BodyInit,
    });
    return AetherClient.normalizeDocument(record);
  }

  // ── Batch / directory ingestion ───────────────────────────────────

  /**
   * Per-file rejections the caller can't fix by retrying the same request:
   * 413 (too large), 415 (unsupported media), 422 (unprocessable — an unknown
   * or binary type the parser can't handle). These are reported as
   * `status:"skipped"`; any other API error is a `status:"error"`.
   */
  private static readonly INGEST_SKIP_STATUS_CODES = new Set([413, 415, 422]);

  /**
   * Ingest many files in one call.
   *
   * Each file is read from disk (Node `fs`) and inserted independently via
   * {@link insert}; the content type is resolved from the extension
   * ({@link resolveContentType} — `.md` → `text/markdown`, `.pdf` →
   * `application/pdf`, and friends), falling back to the engine's guess for an
   * unknown extension. Chunking uses the server defaults unless `chunking` is
   * given. `tags`, `entityId`, and `source` are forwarded to every insert.
   *
   * A file the engine **rejects** — an API error with HTTP status 413, 415, or
   * 422 (an unsupported or binary type, one needing the server-side document
   * parser when it is not configured, or a file over the size limit) — is
   * **reported** in the returned results (`status:"skipped"`) rather than
   * aborting the batch or being silently dropped. Any other API error, or a
   * file-read failure, is reported as `status:"error"`. Set
   * `options.raiseOnError` to `true` to re-throw instead of collecting.
   *
   * @param paths - File paths to ingest.
   * @param options - Ingest options.
   * @param options.tags - Metadata tags applied to every file.
   * @param options.metadata - Structured metadata applied to every file.
   * @param options.chunking - Chunking configuration applied to every file.
   * @param options.entityId - Entity id applied to every file.
   * @param options.source - Origin/source applied to every file.
   * @param options.raiseOnError - When `true`, re-throw on the first failure
   *   instead of collecting it as a result. Defaults to `false`.
   * @returns One {@link IngestResult} per input path, in order.
   * @throws {AetherApiError} Only when `options.raiseOnError` is `true`.
   * @throws {AetherNetworkError} Only when `options.raiseOnError` is `true`.
   */
  async ingestFiles(
    paths: string[],
    options?: {
      tags?: string[];
      metadata?: Metadata;
      chunking?: ChunkingConfig;
      entityId?: string;
      source?: string;
      raiseOnError?: boolean;
    },
  ): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for (const filePath of paths) {
      const contentType = resolveContentType(filePath);
      let data: Uint8Array;
      try {
        data = fs.readFileSync(filePath);
      } catch (err) {
        if (options?.raiseOnError) throw err;
        results.push({
          path: filePath,
          status: "error",
          contentType,
          error: (err as Error).message,
        });
        continue;
      }
      try {
        const record = await this.insert(data, {
          filename: path.basename(filePath),
          contentType,
          tags: options?.tags,
          metadata: options?.metadata,
          entityId: options?.entityId,
          source: options?.source,
          chunking: options?.chunking,
        });
        results.push({
          path: filePath,
          status: "ingested",
          docId: record.doc_id,
          contentType,
        });
      } catch (err) {
        if (options?.raiseOnError) throw err;
        // 413 / 415 / 422 are per-file rejections the caller can't fix by
        // retrying: report as skipped, don't abort. Anything else is an error.
        const status =
          err instanceof AetherApiError &&
          AetherClient.INGEST_SKIP_STATUS_CODES.has(err.status)
            ? "skipped"
            : "error";
        results.push({
          path: filePath,
          status,
          contentType,
          error: (err as Error).message,
        });
      }
    }
    return results;
  }

  /**
   * Ingest every file under a directory.
   *
   * Walks `dir` (recursively by default; pass `options.recursive === false` for
   * top-level only) and ingests each matched file via {@link ingestFiles}. Pass
   * `options.extensions` (e.g. `[".md", ".txt", ".pdf"]`) to restrict which
   * files are loaded; leading dots and case are optional. See {@link ingestFiles}
   * for how rejected files are reported and how options are forwarded.
   *
   * @param dir - Directory to walk.
   * @param options - Ingest options.
   * @param options.extensions - Restrict to these extensions (leading dot and case optional).
   * @param options.recursive - Walk subdirectories. Defaults to `true`.
   * @param options.tags - Metadata tags applied to every file.
   * @param options.metadata - Structured metadata applied to every file.
   * @param options.chunking - Chunking configuration applied to every file.
   * @param options.entityId - Entity id applied to every file.
   * @param options.source - Origin/source applied to every file.
   * @param options.raiseOnError - Re-throw on the first failure. Defaults to `false`.
   * @returns One {@link IngestResult} per matched file, sorted by path.
   * @throws {AetherError} If `dir` is not a directory.
   */
  async ingestDirectory(
    dir: string,
    options?: {
      extensions?: string[];
      recursive?: boolean;
      tags?: string[];
      metadata?: Metadata;
      chunking?: ChunkingConfig;
      entityId?: string;
      source?: string;
      raiseOnError?: boolean;
    },
  ): Promise<IngestResult[]> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      throw new AetherError(`not a directory: ${dir}`);
    }
    if (!stat.isDirectory()) {
      throw new AetherError(`not a directory: ${dir}`);
    }

    let allowed: Set<string> | undefined;
    if (options?.extensions) {
      allowed = new Set(
        options.extensions.map((e) =>
          (e.startsWith(".") ? e : `.${e}`).toLowerCase(),
        ),
      );
    }

    const recursive = options?.recursive ?? true;
    const files: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive) walk(full);
        } else if (entry.isFile()) {
          if (allowed && !allowed.has(path.extname(full).toLowerCase())) continue;
          files.push(full);
        }
      }
    };
    walk(dir);
    files.sort();

    return this.ingestFiles(files, {
      tags: options?.tags,
      metadata: options?.metadata,
      chunking: options?.chunking,
      entityId: options?.entityId,
      source: options?.source,
      raiseOnError: options?.raiseOnError,
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
   * @param options.metadata - Structured metadata for filtering.
   * @param options.entityId - Entity this document belongs to (e.g. a user or customer id), for filtering.
   * @param options.source - Origin/source of this document (e.g. `"slack"`, `"notion"`), for filtering.
   * @returns The created document record.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insertStream(
    stream: ReadableStream<Uint8Array>,
    options?: {
      filename?: string;
      contentType?: string;
      tags?: string[];
      metadata?: Metadata;
      entityId?: string;
      source?: string;
    },
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
    if (options?.source) {
      params.set("source", options.source);
    }
    AetherClient.setJsonParam(params, "metadata", options?.metadata);
    this.applyPartitionParam(params);
    const record = await this._requestNoRetry<DocumentRecord>(`/documents?${params}`, {
      method: "POST",
      body: stream,
      // @ts-expect-error -- duplex is required by Node.js fetch for streaming bodies
      duplex: "half",
    });
    return AetherClient.normalizeDocument(record);
  }

  /**
   * Insert a document from a raw text string.
   * Content type is always `text/plain`; filename defaults to `"text.txt"`.
   *
   * @param text - The text content to insert (must be non-empty).
   * @param options - Insert options.
   * @param options.filename - Filename for the document. Defaults to `"text.txt"`.
   * @param options.tags - Metadata tags for filtering.
   * @param options.metadata - Structured metadata for filtering.
   * @param options.entityId - Entity this document belongs to (e.g. a user or customer id), for filtering.
   * @param options.source - Origin/source of this document (e.g. `"slack"`, `"notion"`), for filtering.
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns The created document record.
   * @throws {AetherError} If text is empty or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insertText(
    text: string,
    options?: {
      filename?: string;
      tags?: string[];
      metadata?: Metadata;
      entityId?: string;
      source?: string;
      chunking?: ChunkingConfig;
      extractFacts?: boolean;
    },
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
    if (options?.source) {
      params.set("source", options.source);
    }
    AetherClient.setJsonParam(params, "metadata", options?.metadata);
    if (options?.extractFacts) {
      params.set("extract_facts", "true");
    }
    this.applyPartitionParam(params);
    if (options?.chunking?.chunkSize) {
      params.set("chunk_size", options.chunking.chunkSize.toString());
    }
    if (options?.chunking?.overlap !== undefined) {
      params.set("overlap", options.chunking.overlap.toString());
    }
    const record = await this._request<DocumentRecord>(`/documents?${params}`, {
      method: "POST",
      body: new TextEncoder().encode(text) as unknown as BodyInit,
    });
    return AetherClient.normalizeDocument(record);
  }

  /**
   * Replace an existing document with new content.
   * The document retains its ID but all chunks and vectors are regenerated.
   *
   * The document's partition is **preserved** when none is in play — an
   * unscoped update never re-homes the document. On a partition handle the
   * injected partition must match where the document lives (a mismatch across
   * named partitions is the same 404 as a nonexistent id); use
   * {@link moveDocument} to change partitions.
   *
   * @param docId - ID of the document to replace.
   * @param data - Raw replacement bytes.
   * @param options - Update options.
   * @param options.filename - New filename for the document (required).
   * @param options.contentType - MIME type. Guessed from filename if omitted.
   * @param options.tags - Metadata tags for filtering (replaces existing tags).
   * @param options.metadata - Structured metadata for filtering (replaces existing structured metadata).
   * @param options.entityId - Entity this document belongs to (replaces the existing entity id; omitting it clears the binding).
   * @param options.source - Origin/source of this document (replaces the existing source; omitting it clears it).
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns The updated document record.
   * @throws {AetherError} If docId or filename is empty, or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async update(
    docId: string,
    data: Uint8Array,
    options: {
      filename: string;
      contentType?: string;
      tags?: string[];
      metadata?: Metadata;
      entityId?: string;
      source?: string;
      chunking?: ChunkingConfig;
    },
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
    if (options.source) {
      params.set("source", options.source);
    }
    AetherClient.setJsonParam(params, "metadata", options.metadata);
    this.applyPartitionParam(params);
    if (options.chunking?.chunkSize) {
      params.set("chunk_size", options.chunking.chunkSize.toString());
    }
    if (options.chunking?.overlap !== undefined) {
      params.set("overlap", options.chunking.overlap.toString());
    }
    const record = await this._request<DocumentRecord>(
      `/documents/${encodeURIComponent(docId)}?${params}`,
      { method: "PUT", body: data as unknown as BodyInit },
    );
    return AetherClient.normalizeDocument(record);
  }

  /**
   * Get document metadata by ID.
   *
   * On a partition handle the partition is sent as a guard: a doc id that
   * lives in a different partition returns the same 404 as a nonexistent id.
   *
   * @param docId - ID of the document to retrieve.
   * @returns The document metadata record.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async get(docId: string): Promise<DocumentRecord> {
    if (!docId) throw new AetherError("docId is required");
    const params = new URLSearchParams();
    this.applyPartitionParam(params);
    const query = params.toString();
    const record = await this._request<DocumentRecord>(
      `/documents/${encodeURIComponent(docId)}${query ? `?${query}` : ""}`,
    );
    return AetherClient.normalizeDocument(record);
  }

  /**
   * Fetch the signed provenance/lineage trail for a document.
   *
   * Returns the ordered audit records for `docId` — each event (insert,
   * tombstone, …) carries a cryptographic {@link AuditProof} so the caller can
   * verify it was signed by the node that committed it. The endpoint is
   * tenant-scoped by the API key; no partition guard is sent.
   *
   * @param docId - ID of the document whose lineage to retrieve.
   * @returns The document's audit records, in the order the engine reports them.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async lineage(docId: string): Promise<AuditRecord[]> {
    if (!docId) throw new AetherError("docId is required");
    const body = await this._request<{ doc_id: string; records: AuditRecord[] }>(
      `/audit/records/${encodeURIComponent(docId)}`,
    );
    return body.records;
  }

  /**
   * Download the raw bytes of a document.
   *
   * On a partition handle the partition is sent as a guard: a doc id that
   * lives in a different partition returns the same 404 as a nonexistent id.
   *
   * @param docId - ID of the document to download.
   * @returns The document content as an ArrayBuffer.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async download(docId: string): Promise<ArrayBuffer> {
    if (!docId) throw new AetherError("docId is required");
    const params = new URLSearchParams();
    this.applyPartitionParam(params);
    const query = params.toString();
    return this._requestRaw(
      `/documents/${encodeURIComponent(docId)}/download${query ? `?${query}` : ""}`,
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
   * @param options.tags - Filter results to documents matching ALL of these tags (AND).
   * @param options.anyTags - Filter results to documents matching AT LEAST ONE of these tags (OR). Composes with `tags` (AND) across the two facets.
   * @param options.contentTypes - Filter results to documents of ANY of these content types (OR).
   * @param options.sources - Filter results to documents from ANY of these sources (OR).
   * @param options.filter - Structured metadata filter with equality or operator predicates.
   * @param options.entityId - Filter results to documents with this entity id.
   * @param options.since - Only match documents created at or after this RFC 3339 timestamp (inclusive), e.g. `"2026-06-01T00:00:00Z"`.
   * @param options.until - Only match documents created at or before this RFC 3339 timestamp (inclusive).
   * @param options.lastNDays - Only match documents created in the last N days. Cannot be combined with `since`.
   * @param options.maxDistance - Drop results whose distance exceeds this threshold.
   * @param options.recencyWeight - Blend recency into ranking, in `[0, 1]`. `0` (or omitted) leaves results in pure-similarity order; higher values weight more recent documents up.
   * @param options.halfLifeDays - Recency decay half-life in days (must be > 0). Server default is 30.
   * @param options.freshnessWeight - Blend freshness into ranking, in `[0, 1]`: boosts recently updated documents (`updated_at`, falling back to `created_at`). Composes with `recencyWeight`; the server rejects a combined weight above 1. May require a Scale plan or higher.
   * @param options.freshnessHalfLifeDays - Freshness decay half-life in days (must be > 0). Server default is 14.
   * @returns Deduplicated search results with full document content attached.
   * @throws {AetherError} If query is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async retrieve(
    query: string,
    k: number = 5,
    options?: {
      tags?: string[];
      anyTags?: string[];
      contentTypes?: string[];
      sources?: string[];
      filter?: MetadataFilter;
      entityId?: string;
      since?: string;
      until?: string;
      lastNDays?: number;
      maxDistance?: number;
      recencyWeight?: number;
      halfLifeDays?: number;
      freshnessWeight?: number;
      freshnessHalfLifeDays?: number;
    },
  ): Promise<RetrievalResult[]> {
    if (!query) throw new AetherError("query is required");
    if (k < 1) throw new AetherError("k must be at least 1");
    const results = await this.search(query, k, {
      includeContent: true,
      tags: options?.tags,
      anyTags: options?.anyTags,
      contentTypes: options?.contentTypes,
      sources: options?.sources,
      filter: options?.filter,
      entityId: options?.entityId,
      since: options?.since,
      until: options?.until,
      lastNDays: options?.lastNDays,
      maxDistance: options?.maxDistance,
      recencyWeight: options?.recencyWeight,
      halfLifeDays: options?.halfLifeDays,
      freshnessWeight: options?.freshnessWeight,
      freshnessHalfLifeDays: options?.freshnessHalfLifeDays,
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
   * @param options - Pagination and filter options.
   * @param options.offset - Number of documents to skip. Defaults to `0`.
   * @param options.limit - Maximum number of documents to return.
   * @param options.tags - Filter to documents matching ALL of these tags (AND).
   * @param options.anyTags - Filter to documents matching AT LEAST ONE of these tags (OR). Composes with `tags` (AND) across the two facets.
   * @param options.contentTypes - Filter to documents of ANY of these content types (OR).
   * @param options.sources - Filter to documents from ANY of these sources (OR).
   * @param options.filter - Structured metadata filter with equality or operator predicates.
   * @param options.entityId - Filter to documents with this entity id.
   * @param options.since - Only list documents created at or after this RFC 3339 timestamp (inclusive), e.g. `"2026-06-01T00:00:00Z"`.
   * @param options.until - Only list documents created at or before this RFC 3339 timestamp (inclusive).
   * @param options.lastNDays - Only list documents created in the last N days. Cannot be combined with `since`.
   * @returns An object containing the document list, total count, and whether more pages exist.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async list(options?: {
    offset?: number;
    limit?: number;
    tags?: string[];
    anyTags?: string[];
    contentTypes?: string[];
    sources?: string[];
    filter?: MetadataFilter;
    entityId?: string;
    since?: string;
    until?: string;
    lastNDays?: number;
  }): Promise<{ documents: DocumentRecord[]; total: number; has_more: boolean }> {
    const params = new URLSearchParams();
    if (options?.offset != null) params.set("offset", String(options.offset));
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    if (options?.anyTags && options.anyTags.length > 0) {
      params.set("any_tags", options.anyTags.join(","));
    }
    if (options?.contentTypes && options.contentTypes.length > 0) {
      params.set("content_type", options.contentTypes.join(","));
    }
    if (options?.sources && options.sources.length > 0) {
      params.set("source", options.sources.join(","));
    }
    AetherClient.setJsonParam(params, "filter", options?.filter);
    if (options?.entityId) params.set("entity_id", options.entityId);
    this.applyPartitionParam(params);
    if (options?.since) params.set("since", options.since);
    if (options?.until) params.set("until", options.until);
    if (options?.lastNDays != null) params.set("last_n_days", String(options.lastNDays));
    const query = params.toString();
    const body = await this._request<{
      documents: DocumentRecord[];
      count: number;
      total: number;
      offset: number;
      limit: number;
      has_more: boolean;
    }>(`/documents${query ? `?${query}` : ""}`);
    return {
      documents: body.documents.map(AetherClient.normalizeDocument),
      total: body.total,
      has_more: body.has_more,
    };
  }

  /**
   * Run a structured analytical query over declared typed fields + built-ins.
   * Exact and deterministic — the analytical read path never consults an
   * embedding.
   *
   * **Mode A** (no `aggregate`) resolves to a {@link QueryPage} of matching
   * documents, typed-sorted and paginated. **Mode B** (with `aggregate`)
   * resolves to an {@link AggregateResult} of groups.
   *
   * @param options.filter - The unified filter grammar: `{ and | or | not }`
   *   combinators over `{ field, op, value }` leaves (ops: eq, neq, in, gt, gte,
   *   lt, lte, between, exists, contains, prefix), or the shorthand metadata map.
   *   Omit to match every document in scope.
   * @param options.groupBy - Up to two declared/built-in fields to group by (Mode B).
   * @param options.aggregate - Aggregates per group, e.g.
   *   `[{ op: "sum", field: "amount", as: "total" }]`. Ops: count, count_distinct,
   *   sum, avg, min, max (the numeric ops require an int/float field). Passing this
   *   selects Mode B.
   * @param options.sort - Typed multi-key sort, `[{ by, dir }]`. Mode A sorts
   *   documents by field; Mode B sorts groups by an aggregate output or group key.
   * @param options.limit - Mode A page size (max 1000); Mode B max groups returned.
   * @param options.offset - Mode A page offset.
   * @param options.partition - Partition to scope to; ignored on a partition
   *   handle (the scope is already fixed).
   * @throws {AetherApiError} 400 for an unknown field, a type-mismatched literal,
   *   a non-numeric numeric-aggregate, or a guardrail breach (the scan or
   *   max-groups cap) — never a silently truncated result.
   */
  async query(options?: {
    filter?: MetadataFilter;
    groupBy?: string[];
    aggregate?: Array<Record<string, unknown>>;
    sort?: Array<{ by: string; dir?: "asc" | "desc" }>;
    limit?: number;
    offset?: number;
    partition?: string;
  }): Promise<QueryPage | AggregateResult> {
    const body: Record<string, unknown> = {};
    if (options?.filter != null) body.filter = options.filter;
    if (options?.groupBy && options.groupBy.length > 0) body.group_by = options.groupBy;
    if (options?.aggregate && options.aggregate.length > 0) {
      body.aggregate = options.aggregate;
    }
    if (options?.sort && options.sort.length > 0) body.sort = options.sort;
    if (options?.limit != null) body.limit = options.limit;
    if (options?.offset != null && options.offset !== 0) body.offset = options.offset;
    const scope = this.partitionId ?? options?.partition;
    if (scope) body.partition = scope;

    const isAggregate = !!(options?.aggregate && options.aggregate.length > 0);
    const data = await this._request<{
      documents?: DocumentRecord[];
      total?: number;
      has_more?: boolean;
      groups?: QueryGroup[];
      total_groups?: number;
      scanned?: number;
    }>("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (isAggregate) {
      const groups = (data.groups ?? []).map((g) => ({
        keys: g.keys ?? {},
        aggregates: g.aggregates ?? {},
      }));
      return {
        groups,
        total_groups: data.total_groups ?? groups.length,
        scanned: data.scanned ?? 0,
      };
    }
    const documents = (data.documents ?? []).map(AetherClient.normalizeDocument);
    return {
      documents,
      total: data.total ?? documents.length,
      has_more: data.has_more ?? false,
    };
  }

  /**
   * Field-schema facade — declare / list / delete the typed fields that
   * {@link query} filters, sorts, and aggregates over. On a partition handle
   * every call is pinned to that partition.
   */
  get schema(): SchemaOps {
    const withPartition = (path: string): string => {
      const params = new URLSearchParams();
      this.applyPartitionParam(params);
      const qs = params.toString();
      return `${path}${qs ? `?${qs}` : ""}`;
    };
    return {
      declareFields: async (fields: FieldSchemaInput[]): Promise<FieldSchema[]> => {
        const body = await this._request<{ fields: FieldSchema[] }>(
          withPartition("/schema/fields"),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields }),
          },
        );
        return body.fields;
      },
      listFields: async (): Promise<FieldSchema[]> => {
        const body = await this._request<{ fields: FieldSchema[] }>(
          withPartition("/schema/fields"),
        );
        return body.fields;
      },
      deleteField: async (name: string): Promise<FieldSchema[]> => {
        const body = await this._request<{ fields: FieldSchema[] }>(
          withPartition(`/schema/fields/${encodeURIComponent(name)}`),
          { method: "DELETE" },
        );
        return body.fields;
      },
    };
  }

  /**
   * Soft-delete (tombstone) a document.
   * The document is hidden from searches and listings but can be restored with {@link restore}.
   *
   * On a partition handle the partition is sent as a guard (for both soft and
   * hard deletes): a doc id that lives in a different partition returns the
   * same 404 as a nonexistent id.
   *
   * @param docId - ID of the document to delete.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async delete(docId: string, options?: { hard?: boolean }): Promise<void> {
    if (!docId) throw new AetherError("docId is required");
    // `hard` purges the document permanently (removed from the primary
    // store and both indexes, encryption key shredded — irreversible). The
    // default is a recoverable tombstone.
    const params = new URLSearchParams();
    if (options?.hard) params.set("hard", "true");
    this.applyPartitionParam(params);
    const query = params.toString();
    await this._request(
      `/documents/${encodeURIComponent(docId)}${query ? `?${query}` : ""}`,
      { method: "DELETE" },
    );
  }

  /**
   * Restore a previously tombstoned document, making it visible in searches and listings again.
   *
   * On a partition handle the partition is sent as a guard: a doc id that
   * lives in a different partition returns the same 404 as a nonexistent id.
   *
   * @param docId - ID of the document to restore.
   * @throws {AetherError} If docId is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if document not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async restore(docId: string): Promise<void> {
    if (!docId) throw new AetherError("docId is required");
    const params = new URLSearchParams();
    this.applyPartitionParam(params);
    const query = params.toString();
    await this._request(
      `/documents/${encodeURIComponent(docId)}/restore${query ? `?${query}` : ""}`,
      { method: "POST" },
    );
  }

  /**
   * Move a document to another partition (metadata-only).
   *
   * The only way to move a document between named partitions. `from` asserts
   * where the document lives **now** and `to` names the destination; `null`
   * is meaningful for either — the default partition — not an omission.
   * Content, `cid`, chunks, and vectors are unchanged (no re-embed);
   * `version` increments. A wrong `from` assertion, a missing id, or a
   * tombstoned id all return the same 404 as a nonexistent document (never a
   * partition-existence oracle), and `to === from` is an idempotent no-op.
   *
   * Like {@link deletePartition}, this is deliberately **not** scoped by a
   * partition handle: a call that crosses the boundary must always name both
   * partitions explicitly, never inherit one from an implicit scope.
   *
   * @param docId - ID of the document to move.
   * @param options - Move options. Both fields are required.
   * @param options.from - The partition the document currently lives in, or
   *   `null` for the default partition.
   * @param options.to - The destination partition, or `null` for the default
   *   partition.
   * @returns The updated document record (with the new `partition` echoed).
   * @throws {AetherError} If docId is empty, a field is omitted, or a non-null
   *   partition is empty/whitespace or longer than 256 characters.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if the document
   *   is missing or `from` does not match where it lives).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async moveDocument(
    docId: string,
    options: { from: string | null; to: string | null },
  ): Promise<DocumentRecord> {
    if (!docId) throw new AetherError("docId is required");
    // Both fields must be present on the wire (an explicit `null` names the
    // default partition), so reject `undefined` — JSON.stringify would drop
    // the key — and validate non-null ids like a partition handle id.
    const fields: Array<["from" | "to", string | null | undefined]> = [
      ["from", options.from],
      ["to", options.to],
    ];
    for (const [name, value] of fields) {
      if (value === undefined) {
        throw new AetherError(
          `${name} is required (use null for the default partition)`,
        );
      }
      if (value === null) continue;
      if (value.trim().length === 0) {
        throw new AetherError(
          `${name} must be null or a non-empty partition id`,
        );
      }
      if (value.length > MAX_PARTITION_LEN) {
        throw new AetherError(
          `${name} must be at most ${MAX_PARTITION_LEN} characters`,
        );
      }
    }
    const record = await this._request<DocumentRecord>(
      `/documents/${encodeURIComponent(docId)}/move`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to_partition: options.to,
          expect_partition: options.from,
        }),
      },
    );
    return AetherClient.normalizeDocument(record);
  }

  // ── Search ────────────────────────────────────────────────────────

  /**
   * Perform similarity search across all active documents.
   *
   * @param query - Natural-language search query.
   * @param k - Maximum number of results to return. Defaults to `10`.
   * @param options - Search options.
   * @param options.includeContent - When `true`, include document/passage content in results.
   * @param options.tags - Filter results to documents matching ALL of these tags (AND).
   * @param options.anyTags - Filter results to documents matching AT LEAST ONE of these tags (OR). Composes with `tags` (AND) across the two facets.
   * @param options.contentTypes - Filter results to documents of ANY of these content types (OR).
   * @param options.sources - Filter results to documents from ANY of these sources (OR).
   * @param options.filter - Structured metadata filter with equality or operator predicates.
   * @param options.entityId - Filter results to documents with this entity id.
   * @param options.since - Only match documents created at or after this RFC 3339 timestamp (inclusive), e.g. `"2026-06-01T00:00:00Z"`.
   * @param options.until - Only match documents created at or before this RFC 3339 timestamp (inclusive).
   * @param options.lastNDays - Only match documents created in the last N days. Cannot be combined with `since`.
   * @param options.maxDistance - Drop results whose distance exceeds this threshold.
   * @param options.recencyWeight - Blend recency into ranking, in `[0, 1]`. `0` (or omitted) leaves results in pure-similarity order; higher values weight more recent documents up.
   * @param options.halfLifeDays - Recency decay half-life in days (must be > 0). Server default is 30.
   * @param options.freshnessWeight - Blend freshness into ranking, in `[0, 1]`: boosts recently updated documents (`updated_at`, falling back to `created_at`). Composes with `recencyWeight`; the server rejects a combined weight above 1. May require a Scale plan or higher.
   * @param options.freshnessHalfLifeDays - Freshness decay half-life in days (must be > 0). Server default is 14.
   * @returns Array of search results ordered by similarity (closest first).
   * @throws {AetherError} If query is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async search(
    query: string,
    k: number = 10,
    options?: {
      includeContent?: boolean;
      tags?: string[];
      anyTags?: string[];
      contentTypes?: string[];
      sources?: string[];
      filter?: MetadataFilter;
      entityId?: string;
      since?: string;
      until?: string;
      lastNDays?: number;
      maxDistance?: number;
      recencyWeight?: number;
      halfLifeDays?: number;
      freshnessWeight?: number;
      freshnessHalfLifeDays?: number;
    },
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
    if (options?.anyTags && options.anyTags.length > 0) {
      params.set("any_tags", options.anyTags.join(","));
    }
    if (options?.contentTypes && options.contentTypes.length > 0) {
      params.set("content_type", options.contentTypes.join(","));
    }
    if (options?.sources && options.sources.length > 0) {
      params.set("source", options.sources.join(","));
    }
    AetherClient.setJsonParam(params, "filter", options?.filter);
    if (options?.entityId) {
      params.set("entity_id", options.entityId);
    }
    this.applyPartitionParam(params);
    if (options?.since) {
      params.set("since", options.since);
    }
    if (options?.until) {
      params.set("until", options.until);
    }
    if (options?.lastNDays != null) {
      params.set("last_n_days", String(options.lastNDays));
    }
    if (options?.maxDistance != null) {
      params.set("max_distance", String(options.maxDistance));
    }
    if (options?.recencyWeight != null) {
      params.set("recency_weight", String(options.recencyWeight));
    }
    if (options?.halfLifeDays != null) {
      params.set("half_life_days", String(options.halfLifeDays));
    }
    if (options?.freshnessWeight != null) {
      params.set("freshness_weight", String(options.freshnessWeight));
    }
    if (options?.freshnessHalfLifeDays != null) {
      params.set("freshness_half_life_days", String(options.freshnessHalfLifeDays));
    }
    const body = await this._request<{
      query: string;
      query_id?: string;
      results: SearchResult[];
    }>(`/search?${params}`);
    return body.results.map((r) => AetherClient.normalizeResult(r, body.query_id));
  }

  /**
   * Report how a search result was actually used, tying retrieval quality back
   * to real outcomes.
   *
   * Requires usage-feedback capture to be enabled for your tenant; search
   * results then carry a `queryId` to pass here (absent otherwise).
   *
   * @param queryId - The `queryId` carried by the search results.
   * @param docId - The `doc_id` of the hit the signal is about.
   * @param signal - `"used"`, `"cited"`, or `"ignored"`.
   * @throws {AetherError} If queryId, docId, or signal is empty.
   * @throws {AetherApiError} On non-2xx API response (404 for an unknown
   *   queryId, 400 for an invalid signal).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async sendSearchFeedback(
    queryId: string,
    docId: string,
    signal: SearchFeedbackSignal,
  ): Promise<void> {
    if (!queryId) throw new AetherError("queryId is required");
    if (!docId) throw new AetherError("docId is required");
    if (!signal) throw new AetherError("signal is required");
    await this._request<{ recorded: boolean }>("/search/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query_id: queryId, doc_id: docId, signal }),
    });
  }

  // ── Provable isolation ────────────────────────────────────────────

  /**
   * Like {@link search}, but also return an isolation {@link SearchTrace}.
   *
   * Takes the same query and options as {@link search}, and a partition handle
   * injects the partition identically. The trace is computed from the records
   * actually returned, so it is evidence — not intent — of which partition(s)
   * the query touched. Under a handle the trace proves the boundary held:
   * `partitionsTouched` is `[]` or exactly `[scopedTo]`, and `candidatesInScope`
   * is the partition's own size.
   *
   * @param query - Natural-language search query.
   * @param k - Maximum number of results to return. Defaults to `10`.
   * @param options - Search options (identical to {@link search}).
   * @returns The search results and the isolation trace that produced them.
   * @throws {AetherError} If query is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async searchTrace(
    query: string,
    k: number = 10,
    options?: {
      includeContent?: boolean;
      tags?: string[];
      filter?: MetadataFilter;
      entityId?: string;
      since?: string;
      until?: string;
      lastNDays?: number;
      maxDistance?: number;
    },
  ): Promise<TracedSearch> {
    if (!query) throw new AetherError("query is required");
    if (k < 1) throw new AetherError("k must be at least 1");
    const params = new URLSearchParams({ q: query, k: String(k), trace: "true" });
    if (options?.includeContent) {
      params.set("include_content", "true");
    }
    if (options?.tags && options.tags.length > 0) {
      params.set("tags", options.tags.join(","));
    }
    AetherClient.setJsonParam(params, "filter", options?.filter);
    if (options?.entityId) {
      params.set("entity_id", options.entityId);
    }
    this.applyPartitionParam(params);
    if (options?.since) {
      params.set("since", options.since);
    }
    if (options?.until) {
      params.set("until", options.until);
    }
    if (options?.lastNDays != null) {
      params.set("last_n_days", String(options.lastNDays));
    }
    if (options?.maxDistance != null) {
      params.set("max_distance", String(options.maxDistance));
    }
    const body = await this._request<{
      query: string;
      query_id?: string;
      results: SearchResult[];
      trace?: Partial<{
        scoped_to: string | null;
        partitions_touched: string[];
        default_partition_touched: boolean;
        results: number;
        candidates_in_scope: number | null;
        boundary: string;
      }>;
    }>(`/search?${params}`);
    return {
      results: body.results.map((r) => AetherClient.normalizeResult(r, body.query_id)),
      trace: AetherClient.parseTrace(body.trace ?? {}),
    };
  }

  /**
   * Map the snake_case wire trace to the camelCase {@link SearchTrace} shape.
   */
  private static parseTrace(
    t: Partial<{
      scoped_to: string | null;
      partitions_touched: string[];
      default_partition_touched: boolean;
      results: number;
      candidates_in_scope: number | null;
      boundary: string;
    }>,
  ): SearchTrace {
    return {
      scopedTo: t.scoped_to ?? null,
      partitionsTouched: t.partitions_touched ?? [],
      defaultPartitionTouched: t.default_partition_touched ?? false,
      results: t.results ?? 0,
      candidatesInScope: t.candidates_in_scope ?? null,
      boundary: t.boundary ?? "",
    };
  }

  /**
   * Self-test that a scoped search never leaks out of this partition.
   *
   * Runs {@link searchTrace} under this handle's partition and checks that every
   * returned record stayed in scope. `ok` is true iff nothing leaked. Only valid
   * on a partition handle, and only meaningful for a query that returns results —
   * a 0-result query passes vacuously.
   *
   * Drop one line into your own tests to prove isolation against your data:
   *
   * ```ts
   * const check = await client.partition("client_42").verifyIsolation("returns policy");
   * expect(check.ok).toBe(true);
   * ```
   *
   * @param query - Natural-language search query.
   * @param k - Maximum number of results to consider. Defaults to `10`.
   * @returns The isolation check, including any leaked partitions.
   * @throws {AetherError} If this client is not scoped to a partition, or if
   *   query is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async verifyIsolation(query: string, k: number = 10): Promise<IsolationCheck> {
    if (this.partitionId == null) {
      throw new AetherError(
        "verifyIsolation requires a partition handle — call " +
          "client.partition(id).verifyIsolation(...)",
      );
    }
    const traced = await this.searchTrace(query, k);
    const scoped = this.partitionId;
    const leaked = traced.trace.partitionsTouched.filter((p) => p !== scoped);
    const ok = leaked.length === 0 && !traced.trace.defaultPartitionTouched;
    return {
      ok,
      scopedTo: scoped,
      partitionsTouched: traced.trace.partitionsTouched,
      results: traced.trace.results,
      candidatesInScope: traced.trace.candidatesInScope,
      leaked,
    };
  }

  // ── Partitions ────────────────────────────────────────────────────

  /**
   * List this tenant's partitions with active document counts.
   *
   * Tenant-level — this does **not** use a partition handle. The result includes
   * advisory `warnings` flagging likely-mistyped or ghost partitions; the default
   * (unkeyed) partition is not listed.
   *
   * @returns The tenant's partitions and any advisory warnings.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async listPartitions(): Promise<PartitionList> {
    const body = await this._request<{
      partitions?: Array<{ id: string; document_count?: number }>;
      count?: number;
      warnings?: Array<{ kind: string; partitions?: string[]; detail?: string }>;
    }>("/partitions");
    const partitions: PartitionInfo[] = (body.partitions ?? []).map((p) => ({
      id: p.id,
      documentCount: p.document_count ?? 0,
    }));
    const warnings: PartitionWarning[] = (body.warnings ?? []).map((w) => ({
      kind: w.kind,
      partitions: w.partitions ?? [],
      detail: w.detail ?? "",
    }));
    return { partitions, warnings };
  }

  /**
   * Delete a partition and shred **every** document in it (active and previously
   * deleted). A one-call teardown for offboarding an end-client.
   *
   * The id is validated client-side exactly like a partition handle id (1–256
   * chars, non-empty / non-whitespace) and URL-encoded — including any slashes —
   * into the request path. Idempotent: deleting an unknown or empty partition
   * returns `0` and is never an error.
   *
   * @param partitionId - The partition to delete (1–256 chars, non-empty / non-whitespace).
   * @returns The number of documents deleted.
   * @throws {AetherError} If `partitionId` is empty/whitespace or longer than 256 characters.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async deletePartition(partitionId: string): Promise<number> {
    if (!partitionId || partitionId.trim().length === 0) {
      throw new AetherError("partitionId is required");
    }
    if (partitionId.length > MAX_PARTITION_LEN) {
      throw new AetherError(
        `partitionId must be at most ${MAX_PARTITION_LEN} characters`,
      );
    }
    const body = await this._request<{ documents_deleted?: number }>(
      `/partitions/${encodeURIComponent(partitionId)}`,
      { method: "DELETE" },
    );
    return body.documents_deleted ?? 0;
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
   * @param options.metadata - Structured metadata for filtering.
   * @param options.entityId - Entity this document belongs to (e.g. a user or customer id), for filtering.
   * @param options.source - Origin/source of this document (e.g. `"slack"`, `"notion"`), for filtering.
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
    metadata?: Metadata;
    entityId?: string;
    source?: string;
  }): Promise<DocumentRecord> {
    if (!options.content) throw new AetherError("content is required");
    if (!options.passages?.length && !options.embedding?.length) {
      throw new AetherError("either passages or embedding must be provided and non-empty");
    }
    const payload: Record<string, unknown> = {
      content: options.content,
      passages: options.passages,
      embedding: options.embedding,
      filename: options.filename ?? "text.txt",
      content_type: options.contentType ?? "text/plain",
      tags: options.tags,
      metadata: options.metadata,
      entity_id: options.entityId,
      source: options.source,
    };
    if (this.partitionId) {
      payload.partition = this.partitionId;
    }
    const record = await this._request<DocumentRecord>("/documents/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return AetherClient.normalizeDocument(record);
  }

  /**
   * Search using a pre-computed query embedding vector (BYOE -- Bring Your Own Embeddings).
   * Use this when you generate query embeddings externally instead of relying on server-side embedding.
   *
   * @param embedding - Pre-computed query embedding vector (must be non-empty).
   * @param k - Maximum number of results to return. Defaults to `10`.
   * @param options - Search options.
   * @param options.includeContent - When `true`, include document/passage content in results.
   * @param options.tags - Filter results to documents matching ALL of these tags (AND).
   * @param options.anyTags - Filter results to documents matching AT LEAST ONE of these tags (OR). Composes with `tags` (AND) across the two facets.
   * @param options.contentTypes - Filter results to documents of ANY of these content types (OR).
   * @param options.sources - Filter results to documents from ANY of these sources (OR).
   * @param options.filter - Structured metadata filter with equality or operator predicates.
   * @param options.entityId - Filter results to documents with this entity id.
   * @param options.since - Only match documents created at or after this RFC 3339 timestamp (inclusive), e.g. `"2026-06-01T00:00:00Z"`.
   * @param options.until - Only match documents created at or before this RFC 3339 timestamp (inclusive).
   * @param options.lastNDays - Only match documents created in the last N days. Cannot be combined with `since`.
   * @param options.maxDistance - Drop results whose distance exceeds this threshold.
   * @param options.recencyWeight - Blend recency into ranking, in `[0, 1]`. `0` (or omitted) leaves results in pure-similarity order; higher values weight more recent documents up.
   * @param options.halfLifeDays - Recency decay half-life in days (must be > 0). Server default is 30.
   * @param options.freshnessWeight - Blend freshness into ranking, in `[0, 1]`: boosts recently updated documents (`updated_at`, falling back to `created_at`). Composes with `recencyWeight`; the server rejects a combined weight above 1. May require a Scale plan or higher.
   * @param options.freshnessHalfLifeDays - Freshness decay half-life in days (must be > 0). Server default is 14.
   * @returns Array of search results ordered by similarity (closest first).
   * @throws {AetherError} If embedding is empty or k is less than 1.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async searchByVector(
    embedding: number[],
    k: number = 10,
    options?: {
      includeContent?: boolean;
      tags?: string[];
      anyTags?: string[];
      contentTypes?: string[];
      sources?: string[];
      filter?: MetadataFilter;
      entityId?: string;
      since?: string;
      until?: string;
      lastNDays?: number;
      maxDistance?: number;
      recencyWeight?: number;
      halfLifeDays?: number;
      freshnessWeight?: number;
      freshnessHalfLifeDays?: number;
    },
  ): Promise<SearchResult[]> {
    if (!embedding || embedding.length === 0) throw new AetherError("embedding must be a non-empty array");
    if (k < 1) throw new AetherError("k must be at least 1");
    const payload: Record<string, unknown> = {
      embedding,
      k,
      include_content: options?.includeContent ?? false,
      tags: options?.tags,
      any_tags: options?.anyTags,
      content_type: options?.contentTypes,
      source: options?.sources,
      filter: options?.filter,
      entity_id: options?.entityId,
      since: options?.since,
      until: options?.until,
      last_n_days: options?.lastNDays,
      max_distance: options?.maxDistance,
      recency_weight: options?.recencyWeight,
      half_life_days: options?.halfLifeDays,
      freshness_weight: options?.freshnessWeight,
      freshness_half_life_days: options?.freshnessHalfLifeDays,
    };
    if (this.partitionId) {
      payload.partition = this.partitionId;
    }
    const body = await this._request<{
      query: string;
      query_id?: string;
      results: SearchResult[];
    }>("/search/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return body.results.map((r) => AetherClient.normalizeResult(r, body.query_id));
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
   * @param options.metadata - Structured metadata for filtering.
   * @param options.entityId - Entity this document belongs to (e.g. a user or customer id), for filtering.
   * @param options.source - Origin/source of this document (e.g. `"slack"`, `"notion"`), for filtering.
   * @param options.chunking - Chunking configuration for document splitting.
   * @returns An object with the `job_id`, current `status`, and `poll_url` for tracking progress.
   * @throws {AetherError} If filename is empty or chunking config is invalid.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async insertAsync(
    data: Uint8Array,
    options: {
      filename: string;
      contentType?: string;
      tags?: string[];
      metadata?: Metadata;
      entityId?: string;
      source?: string;
      chunking?: ChunkingConfig;
    },
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
    if (options.entityId) {
      params.set("entity_id", options.entityId);
    }
    if (options.source) {
      params.set("source", options.source);
    }
    AetherClient.setJsonParam(params, "metadata", options.metadata);
    this.applyPartitionParam(params);
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
   * @param documents - Array of documents to insert, each with `filename`, `content`, and optional `tags` and `entity_id`.
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
    // Build each wire item without mutating the caller's array: comma-join the
    // `tags` list to a CSV string (the server item field is a string, not an
    // array) and, when scoped, stamp the partition on every item.
    const items = documents.map((d) => {
      const item: Record<string, unknown> = { ...d };
      AetherClient.csvField(item, "tags", d.tags);
      if (this.partitionId) item.partition = this.partitionId;
      return item;
    });
    const payload = {
      documents: items,
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
    return res.results.map(AetherClient.normalizeDocument);
  }


  /**
   * Run multiple search queries in a single batch request.
   * More efficient than calling {@link search} in a loop because the server
   * processes all queries in one round-trip.
   *
   * @param queries - Array of search queries, each with `q` and optional `k`, `tags`, `include_content`,
   *   filters (`entity_id`, `since`, `until`, `last_n_days`, `max_distance`), recency tuning
   *   (`recency_weight`, `half_life_days`), and freshness tuning
   *   (`freshness_weight`, `freshness_half_life_days`).
   * @returns Array of batch search responses, one per input query, each containing its results.
   * @throws {AetherError} If queries array is empty.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async batchSearch(queries: BatchSearchQuery[]): Promise<BatchSearchResponse[]> {
    if (!queries || queries.length === 0) throw new AetherError("queries must be a non-empty array");
    // Encode each query for the wire: the metadata facets are accepted as
    // comma-separated strings (the same CSV convention as the GET /search route),
    // so join the ergonomic array fields and drop empties. When scoped, stamp the
    // same partition on every query. Never mutates the caller's array.
    const wireQueries = queries.map((q) => {
      const wire: Record<string, unknown> = { ...q };
      AetherClient.csvField(wire, "tags", q.tags);
      AetherClient.csvField(wire, "any_tags", q.any_tags);
      AetherClient.csvField(wire, "content_type", q.content_type);
      AetherClient.csvField(wire, "source", q.source);
      if (this.partitionId) wire.partition = this.partitionId;
      return wire;
    });
    const res = await this._request<{
      results: Array<BatchSearchResponse & { query_id?: string }>;
    }>(
      "/search/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: wireQueries }),
      },
    );
    // The feedback handle arrives per query; stamp it onto that query's hits.
    return res.results.map((r) => ({
      query: r.query,
      results: r.results.map((sr) => AetherClient.normalizeResult(sr, r.query_id)),
    }));
  }

  // ── Entity backfill ───────────────────────────────────────────────

  /**
   * Backfill `entity_id` on the tenant's existing documents from a tag convention.
   *
   * For every active document, a tag starting with `tagPrefix` (e.g. `"patient:"`)
   * sets `entity_id` to the suffix after the prefix when exactly one such tag exists;
   * ambiguous (2+) or absent matches are skipped. Documents that already have an
   * `entity_id` are left alone unless `overwrite` is `true`. This is a metadata-only
   * operation — documents are not re-embedded.
   *
   * On a partition handle the scan is constrained to the handle's partition
   * (which also satisfies a multi-tenant key's requirement to name one).
   *
   * @param tagPrefix - Tag prefix that identifies the entity tag (e.g. `"patient:"`). Must be non-empty.
   * @param opts - Backfill options.
   * @param opts.overwrite - When `true`, replace existing entity ids too. Defaults to `false`.
   * @returns A report of how many documents were scanned, updated, and skipped (by reason).
   * @throws {AetherApiError} On non-2xx API response (e.g. 400 if tagPrefix is empty).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async backfillEntityFromTags(
    tagPrefix: string,
    opts?: { overwrite?: boolean },
  ): Promise<EntityBackfillReport> {
    const params = new URLSearchParams();
    this.applyPartitionParam(params);
    const query = params.toString();
    return this._request<EntityBackfillReport>(
      `/documents/backfill-entity${query ? `?${query}` : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_prefix: tagPrefix,
          overwrite: opts?.overwrite ?? false,
        }),
      },
    );
  }
}
