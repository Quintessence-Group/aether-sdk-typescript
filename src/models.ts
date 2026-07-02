export type MetadataValue = string | number | boolean;
export type Metadata = Record<string, MetadataValue>;
export interface MetadataFilterOperators {
  eq?: MetadataValue;
  ne?: MetadataValue;
  gt?: MetadataValue;
  lt?: MetadataValue;
  gte?: MetadataValue;
  lte?: MetadataValue;
  in?: MetadataValue[];
}
export type MetadataFilterValue = MetadataValue | MetadataFilterOperators;
export type MetadataFilter = Record<string, MetadataFilterValue>;

export interface DocumentRecord {
  doc_id: string;
  cid: string;
  title?: string;
  /** Entity this document belongs to (e.g. a user or customer id), if any. */
  entity_id?: string;
  content_type: string;
  size_bytes: number;
  chunks: number;
  vectors: number;
  version: number;
  created_at?: string;
  updated_at?: string;
  /**
   * Metadata tags for this document. Echoed on read so tags written at insert
   * time round-trip back. Defaults to `[]` when the server omits the field.
   */
  tags: string[];
  /** Origin/source of this document (e.g. `"slack"`, `"notion"`), or `null` if none. */
  source: string | null;
  /** Structured metadata values attached to this document. Defaults to `{}`. */
  metadata: Metadata;
}

export interface SearchResult {
  doc_id: string;
  distance: number;
  title?: string;
  /** Entity the matched document belongs to (e.g. a user or customer id), if any. */
  entity_id?: string;
  content_type: string;
  content?: string;
  /** The specific passage that matched the query vector, if available. */
  passage?: string;
  /**
   * Metadata tags on the matched document. Echoed on every hit. Defaults to
   * `[]` when the server omits the field.
   */
  tags: string[];
  /** Origin/source of the matched document, or `null` if none was declared. */
  source: string | null;
  /** Structured metadata values attached to the matched document. Defaults to `{}`. */
  metadata: Metadata;
  /**
   * RFC 3339 timestamp of when the matched document was created, if reported by
   * the server. Kept as the wire string (not parsed to a `Date`), matching how
   * other timestamps are surfaced.
   */
  created_at?: string;
  /**
   * RFC 3339 timestamp of when the matched document was last updated, or `null`
   * if it has never been updated since insert (and `undefined` when the server
   * omits the field on older payloads). Kept as the wire string, mirroring
   * `created_at`. Lets a caller spot a freshly-superseded hit without a second
   * `get` round-trip.
   */
  updated_at?: string | null;
  /**
   * Feedback handle for the search that returned this hit. Present only when
   * usage-feedback capture is enabled for your tenant (`undefined` otherwise);
   * pass it to {@link AetherClient.sendSearchFeedback} together with this
   * hit's `doc_id`.
   */
  queryId?: string;
}

/**
 * How a search result was actually used, reported via
 * {@link AetherClient.sendSearchFeedback}: `"used"` (informed the answer),
 * `"cited"` (quoted/referenced directly), or `"ignored"` (retrieved but unused).
 */
export type SearchFeedbackSignal = "used" | "cited" | "ignored";

export interface RetrievalResult extends SearchResult {
  /** Full document content as text, for use in RAG prompts. */
  content: string;
}

export interface NodeStatus {
  node_id: number;
  documents: number;
  vectors: number;
  version?: string;
}

export interface ChunkingConfig {
  chunkSize?: number;
  overlap?: number;
}

export interface BatchInsertItem {
  filename: string;
  content: string;
  tags?: string[];
  /** Entity this document belongs to (e.g. a user or customer id). */
  entity_id?: string;
  /** Origin/source of this document (e.g. `"slack"`, `"notion"`). */
  source?: string;
  /** Structured metadata for filtering. Values must be strings, numbers, or booleans. */
  metadata?: Metadata;
}

export interface BatchSearchQuery {
  q: string;
  k?: number;
  /** Require ALL of these tags (AND). Sent comma-separated on the wire. */
  tags?: string[];
  /**
   * Require AT LEAST ONE of these tags (OR). Composes with `tags` (AND) across
   * the two facets. Sent comma-separated on the wire.
   */
  any_tags?: string[];
  /** Restrict to documents of any of these content types (OR). Sent comma-separated on the wire. */
  content_type?: string[];
  /** Restrict to documents from any of these sources (OR). Sent comma-separated on the wire. */
  source?: string[];
  include_content?: boolean;
  /** Filter results to documents with this entity id. */
  entity_id?: string;
  /** Only match documents created at or after this RFC 3339 timestamp (inclusive). */
  since?: string;
  /** Only match documents created at or before this RFC 3339 timestamp (inclusive). */
  until?: string;
  /** Only match documents created in the last N days. Cannot be combined with `since`. */
  last_n_days?: number;
  /** Drop results whose distance exceeds this threshold. */
  max_distance?: number;
  /**
   * Blend recency into ranking, in `[0, 1]`. `0` (or omitted) leaves results in
   * pure-similarity order; higher values weight more recent documents up.
   */
  recency_weight?: number;
  /** Recency decay half-life in days (must be > 0). Server default is 30. */
  half_life_days?: number;
  /**
   * Blend freshness into ranking, in `[0, 1]`: boosts recently updated documents
   * (`updated_at`, falling back to `created_at`). Composes with `recency_weight`;
   * the server rejects a combined weight above 1. May require a Scale plan or higher.
   */
  freshness_weight?: number;
  /** Freshness decay half-life in days (must be > 0). Server default is 14. */
  freshness_half_life_days?: number;
  /** Structured metadata filter. Keys may be `metadata.<key>` or bare keys. */
  filter?: MetadataFilter;
}

export interface BatchSearchResponse {
  query: string;
  results: SearchResult[];
}

export interface EntityBackfillReport {
  /** Number of active documents scanned. */
  scanned: number;
  /** Number of documents whose entity_id was set from a matching tag. */
  updated: number;
  /** Documents skipped because they already had an entity_id (and overwrite was false). */
  skipped_existing: number;
  /** Documents skipped because no tag matched the prefix. */
  skipped_no_match: number;
  /** Documents skipped because 2+ tags matched the prefix (ambiguous). */
  skipped_ambiguous: number;
  /** Documents skipped because the derived entity_id was invalid. */
  skipped_invalid: number;
}

// ── Batch / directory ingestion ────────────────────────────

/**
 * Outcome of ingesting a single file via {@link AetherClient.ingestFiles} /
 * {@link AetherClient.ingestDirectory}.
 *
 * `status` is one of:
 *
 * - `"ingested"` — stored and indexed; `docId` is set.
 * - `"skipped"` — the engine could not ingest this file (an unsupported or
 *   binary type, or one that needs the server-side document parser that is not
 *   configured, or a file over the size limit). `error` explains why. This is
 *   the graceful path: the batch continues.
 * - `"error"` — an unexpected failure (e.g. the file could not be read, or a
 *   transient API/network error). `error` carries the detail.
 */
export interface IngestResult {
  /** The input file path this result is for. */
  path: string;
  /** The ingest outcome: `"ingested"`, `"skipped"`, or `"error"`. */
  status: "ingested" | "skipped" | "error";
  /** The created document id, set only when `status` is `"ingested"`. */
  docId?: string;
  /** The content type resolved for the file, when known. */
  contentType?: string;
  /** A human-readable explanation, set when `status` is `"skipped"` or `"error"`. */
  error?: string;
}

// ── Partition lifecycle ──────────────────────────────────────────────

/** A partition and its active (non-tombstoned) document count. */
export interface PartitionInfo {
  /** The partition id. */
  id: string;
  /** Number of active documents stored under this partition. */
  documentCount: number;
}

/**
 * An advisory flag about a likely-mistyped or ghost partition.
 *
 * `kind` is `"single_document"` (a partition holding one document — often a
 * typo or abandoned ghost) or `"near_duplicate"` (two ids that differ only
 * cosmetically — likely the same end-client under two keys). Advisory only;
 * a write is never blocked.
 */
export interface PartitionWarning {
  /** The advisory category, e.g. `"single_document"` or `"near_duplicate"`. */
  kind: string;
  /** The partition ids this warning concerns. */
  partitions: string[];
  /** A human-readable description of the advisory. */
  detail: string;
}

/** Result of {@link AetherClient.listPartitions}. */
export interface PartitionList {
  /** The tenant's partitions, each with its active document count. */
  partitions: PartitionInfo[];
  /** Advisory flags about likely-mistyped or ghost partitions. */
  warnings: PartitionWarning[];
}

// ── Provable isolation ───────────────────────────────────────────────

/**
 * Evidence of which partition(s) a search actually touched.
 *
 * For a scoped query, `partitionsTouched` is always `[]` or exactly
 * `[scopedTo]`, and `candidatesInScope` is the partition's own size (proof the
 * scope bounded the search as a hard ceiling, not a post-filter). `boundary` is
 * `"partition"` (scoped) or `"tenant"` (unscoped).
 */
export interface SearchTrace {
  /** The partition the query was scoped to, or `null` when unscoped. */
  scopedTo: string | null;
  /** The partition ids the returned records actually came from. */
  partitionsTouched: string[];
  /** Whether any returned record came from the default (unkeyed) partition. */
  defaultPartitionTouched: boolean;
  /** The number of results returned. */
  results: number;
  /** The number of candidates the search considered in scope, or `null` when not reported. */
  candidatesInScope: number | null;
  /** `"partition"` (scoped) or `"tenant"` (unscoped). */
  boundary: string;
}

/** Search results plus the isolation {@link SearchTrace} that produced them. */
export interface TracedSearch {
  /** The normal search hits. */
  results: SearchResult[];
  /** The isolation trace computed from the returned records. */
  trace: SearchTrace;
}

/**
 * Outcome of {@link AetherClient.verifyIsolation} on a scoped handle.
 *
 * `ok` is true iff no returned record left the handle's partition. Only
 * meaningful for a query that returns results — a 0-result query passes
 * vacuously (`results === 0`).
 */
export interface IsolationCheck {
  /** True iff nothing left the handle's partition. */
  ok: boolean;
  /** The partition the query was scoped to, or `null` when unscoped. */
  scopedTo: string | null;
  /** The partition ids the returned records actually came from. */
  partitionsTouched: string[];
  /** The number of results returned. */
  results: number;
  /** The number of candidates the search considered in scope, or `null` when not reported. */
  candidatesInScope: number | null;
  /** Any touched partitions other than the handle's (empty when `ok`). */
  leaked: string[];
}
