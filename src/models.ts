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
  /** Conversation identity when this document is a thread turn. */
  thread_id?: string | null;
  /** Zero-based, server-assigned position within `thread_id`. */
  turn_index?: number | null;
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
  /**
   * The partition this document lives in, or `null` for the default
   * partition. Echoed on every document response — mirrors the
   * `entity_id`/`source` convention.
   */
  partition: string | null;
  /** `image` or `audio` for a multimodal memory. */
  modality?: "image" | "audio";
  /** Indexed caption/transcript for a multimodal memory. */
  derived_text?: string;
}

export interface MediaMemoryRecord {
  doc_id: string;
  cid: string;
  modality: "image" | "audio";
  content_type: string;
  derived_text: string;
  derived_by: string;
  created_at?: string;
  entity_id?: string;
  partition: string | null;
  metadata: Metadata;
}

export interface SearchResult {
  doc_id: string;
  /**
   * Calibrated relevance, 0–100 (higher = better); ~100 for a near-exact
   * match. Results are ordered by descending `score`.
   */
  score: number;
  title?: string;
  /** Entity the matched document belongs to (e.g. a user or customer id), if any. */
  entity_id?: string;
  /** Conversation identity when this hit is a thread turn. */
  thread_id?: string | null;
  /** Zero-based, server-assigned position within `thread_id`. */
  turn_index?: number | null;
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
   * The partition the matched document lives in, or `null` for the default
   * partition. Echoed on every hit — mirrors the `entity_id`/`source`
   * convention.
   */
  partition: string | null;
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
  /** `image` or `audio` when this hit is a multimodal memory. */
  modality?: "image" | "audio";
  /**
   * Feedback handle for the search that returned this hit. Present only when
   * usage-feedback capture is enabled for your tenant (`undefined` otherwise);
   * pass it to {@link AetherClient.sendSearchFeedback} together with this
   * hit's `doc_id`.
   */
  queryId?: string;
}

/** Input for {@link AetherClient.appendThread}. */
export interface ThreadAppendInput {
  /** Non-empty turn text. */
  text: string;
  metadata?: Metadata;
  tags?: string[];
  entityId?: string;
  source?: string;
  aclReaders?: string[];
  filename?: string;
  /**
   * Stable caller key for retry-safe append. Omit to let the SDK mint one
   * stable key for this logical call and all of its transport retries.
   */
  idempotencyKey?: string;
}

/** Options for {@link AetherClient.getThread}. */
export interface ThreadReadOptions {
  /** Return 1-1000 newest turns, still in chronological order by default. */
  lastNTurns?: number;
  /** Return selected turns newest-first. Defaults to `false`. */
  recentFirst?: boolean;
}

/** Canonical, tenant-scoped conversation returned by `GET /threads/{thread_id}`. */
export interface ConversationThread {
  thread_id: string;
  documents: DocumentRecord[];
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
  /**
   * Read-ACL for this document: `user:` / `group:` labels naming who may read
   * it (sent comma-separated on the wire). Omit to leave it unlabeled /
   * tenant-visible; an explicit empty array quarantines it to admin-role keys
   * only. Mirrors the `aclReaders` insert option.
   */
  acl_readers?: string[];
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
  /** Restrict results to one canonical conversation thread. */
  threadId?: string;
  /** Only match documents created at or after this RFC 3339 timestamp (inclusive). */
  since?: string;
  /** Only match documents created at or before this RFC 3339 timestamp (inclusive). */
  until?: string;
  /** Only match documents created in the last N days. Cannot be combined with `since`. */
  last_n_days?: number;
  /**
   * Drop results whose raw relevance distance exceeds this threshold. Kept in
   * raw-distance terms (0 = identical); it is not rescaled to the 0–100 `score`.
   */
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

// ── Batch / directory ingestion ──────────────────────────────────────

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

// ── Signed provenance / lineage ──────────────────────────────────────

/**
 * Cryptographic proof attached to an audit record, letting a caller verify the
 * event was produced (and signed) by the node that committed it. Fields are the
 * wire values verbatim (snake_case), mirroring {@link DocumentRecord}.
 */
export interface AuditProof {
  /**
   * Content address of the document at the time of the event (e.g.
   * `"blake3:..."`). Omitted for events that do not reference document
   * content, such as a tombstone/deletion.
   */
  content_id?: string;
  /** Lamport clock value at which the event was recorded. */
  lamport: number;
  /** Id of the node that produced the event (64-char hex). */
  node_id: string;
  /** The node's public key (hex) — verify `signature` against it. */
  public_key: string;
  /** Signature (hex) over the record, produced by `node_id`. */
  signature: string;
  /** Whether the engine verified `signature` against `public_key`. */
  verified: boolean;
}

/**
 * One audit record in the shared envelope used by both audit surfaces:
 * the signed provenance/lineage trail returned by {@link AetherClient.lineage}
 * (`source: "ledger"`, always carrying a cryptographic `proof`) and the
 * access-audit log returned by `client.audit.access(...)` (`source: "access"`,
 * no proof). Fields are the wire values verbatim (snake_case), mirroring
 * {@link DocumentRecord}.
 */
export interface AuditRecord {
  /** RFC 3339 timestamp of when the event occurred. */
  at: string;
  /**
   * Who performed the action. Ledger records name the signing node
   * (`"node:<hex>"`); access records name the asserted acting principal
   * (e.g. `"user:alice"`), or `"key:<prefix>"` when none was asserted.
   */
  actor: string;
  /**
   * The action recorded (e.g. `"document.inserted"`; access records use
   * `"read"` / `"search_hit"` / `"denied"` / `"admin_bypass"`).
   */
  action: string;
  /** The resource the action was performed on (e.g. `"document:<uuid>"`). */
  resource: string;
  /**
   * The outcome of the action (`"committed"` for ledger records; `"ok"` /
   * `"denied"` / `"admin_bypass"` for access records).
   */
  outcome: string;
  /** Which audit surface produced the record: `"ledger"` or `"access"`. */
  source: string;
  /**
   * Cryptographic proof for this record. Present on ledger-sourced records;
   * absent on access records (an operational log carries no proof).
   */
  proof?: AuditProof;
}

// ── Access audit ─────────────────────────────────────────────────────

/**
 * Filters for `client.audit.access(...)`. All optional; omitted → unfiltered.
 * Filters compose with AND.
 */
export interface AccessAuditQuery {
  /**
   * Only events by this actor — an asserted acting principal (e.g.
   * `"user:alice"`), or `"key:<prefix>"` for requests that asserted none.
   */
  actor?: string;
  /**
   * Only events on this resource (a document id, or a query id for
   * `search_hit` events).
   */
  resource?: string;
  /** Only this action: `"read"` | `"search_hit"` | `"denied"` | `"admin_bypass"`. */
  action?: string;
  /** Inclusive lower time bound (RFC 3339). */
  since?: string;
  /** Inclusive upper time bound (RFC 3339). */
  until?: string;
  /** Page size (server default 100, max 1000). */
  limit?: number;
  /** Page offset. */
  offset?: number;
}

/** A page of access-audit records returned by `client.audit.access(...)`. */
export interface AccessAuditPage {
  /**
   * The matching access events, newest first, in the shared {@link AuditRecord}
   * envelope with `source: "access"` and no `proof`.
   */
  records: AuditRecord[];
  /** Total events matching the filter across all pages (ignores pagination). */
  total: number;
}

/** The `client.audit` facade — query the tenant's access-audit log. */
export interface AuditOps {
  access(query?: AccessAuditQuery): Promise<AccessAuditPage>;
}

/** One tenant-private source in an answer's declared grounding set. This type
 * is returned only by the authenticated receipt-creation call. */
export interface GroundingSource {
  document_id: string;
  content_id: string;
  rank: number;
  retained_signed_event_count: number;
  current_content_verified: boolean;
  /** Existing engine-verified lineage evidence for the CID; not a standalone
   * LedgerEvent signing transcript. */
  proof?: AuditProof;
}

/**
 * Integrity state for an answer's declared grounding set. `verified` means
 * retained signed source evidence was valid when the receipt was created. It
 * does not rate factual correctness or prove an external model's reasoning.
 */
export interface GroundingTrustSignal {
  status: string;
  sources_requested: number;
  sources_verified: number;
  answer_bound: boolean;
}

/**
 * Authenticated-only verification material for the opaque public binding.
 * `verification_salt` is never stored or emitted from a public receipt URL;
 * retain it with your answer/source result if you need to recompute the binding.
 */
export interface GroundingBinding {
  algorithm: string;
  source_set_commitment: string;
  source_evidence_commitment: string;
  binding_commitment: string;
  verification_salt: string;
}

/** Ed25519 node attestation over a public-safe receipt payload. */
export interface ReceiptAttestation {
  signer_node_id: string;
  signer_public_key: string;
  signature: string;
  verified: boolean;
}

/** Ed25519 attestation over every authenticated grounding result. */
export interface GroundingSetAttestation {
  version: string;
  issued_at: string;
  binding_algorithm: string;
  signer_node_id: string;
  signer_public_key: string;
  signature: string;
  verified: boolean;
}

/**
 * Aggregate-only share metadata returned after an explicit `share: true` opt
 * in. Its public URL never exposes answer text/digest, tenant id, document ids,
 * CIDs, titles, passages, or raw ledger events.
 */
export interface ShareableReceipt {
  version: string;
  receipt_id: string;
  issued_at: string;
  expires_at: string;
  source_count: number;
  verified_source_count: number;
  status: string;
  /** Opaque keyed commitment; it contains no raw answer or answer digest. */
  binding_commitment: string;
  /** Signed BLAKE3 commitment to the decoded 256-bit public capability. */
  capability_commitment: string;
  /** Opaque signed owner binding; it cannot be recomputed from public data. */
  owner_commitment: string;
  attestation: ReceiptAttestation;
  share_url: string;
  badge_url: string;
}

/** Authenticated response binding one answer to its declared sources. */
export interface GroundingReceipt {
  answer_digest: string;
  sources: GroundingSource[];
  trust: GroundingTrustSignal;
  binding: GroundingBinding;
  attestation: GroundingSetAttestation;
  receipt?: ShareableReceipt;
}

// ── Structured query & field schema ─────────────────────────────────

/** A declared typed field for the structured-query layer. Field values are
 * extracted from document metadata (or passage text via a regex) at ingest time
 * and become filterable / sortable / aggregatable through `client.query`. */
export interface FieldSchema {
  name: string;
  /** One of `string`, `int`, `float`, `bool`, `datetime`, `string_list`. */
  type: string;
  /** Where the value comes from: `{ metadata: "<key>" }` or `{ regex: "<pattern>" }`. */
  source: Record<string, string>;
  /** Hard-partition scope; omitted for a tenant-wide field. */
  partition_scope?: string;
  /** Active documents whose source value coerced to the declared type. */
  coverage: number;
  /** Active documents whose source value was present but failed to coerce. */
  mismatch_count: number;
  /** Backfill state; `"complete"` in v1 (synchronous on declare). */
  backfill: string;
}

/** Input to `client.schema.declareFields`. */
export interface FieldSchemaInput {
  name: string;
  type: string;
  source: Record<string, string>;
  partition_scope?: string;
}

/** A page of documents from a Mode A `client.query` (mirrors `list`). */
export interface QueryPage {
  documents: DocumentRecord[];
  total: number;
  has_more: boolean;
}

/** One group in a Mode B aggregation result. */
export interface QueryGroup {
  /** Group-key values by `group_by` field name; empty for a whole-population aggregate. */
  keys: Record<string, unknown>;
  /** Computed aggregates by output name (the `as` alias or a default). */
  aggregates: Record<string, unknown>;
}

/** The result of a Mode B (aggregation) `client.query`. */
export interface AggregateResult {
  groups: QueryGroup[];
  /** Distinct group count before `limit`. */
  total_groups: number;
  /** Documents folded into the aggregation (post-filter). */
  scanned: number;
}

/** The `client.schema` facade — declare / list / delete typed fields. */
export interface SchemaOps {
  declareFields(fields: FieldSchemaInput[]): Promise<FieldSchema[]>;
  listFields(): Promise<FieldSchema[]>;
  deleteField(name: string): Promise<FieldSchema[]>;
}
