import { AetherClient, type AetherClientOptions } from "./client.js";
import { AetherError } from "./errors.js";
import type {
  DocumentRecord,
  Metadata,
  MetadataFilter,
} from "./models.js";

/**
 * A single remembered item, the shared result type for {@link Memory.remember},
 * {@link Memory.recall}, and {@link Memory.list}.
 *
 * `metadata` is the structured document metadata written by
 * {@link Memory.remember} and echoed by the raw document API.
 */
export interface MemoryItem {
  /** The underlying document id (`doc_id`). Always populated. */
  id: string;
  /** The remembered text. */
  text: string;
  /**
   * RFC 3339 creation timestamp, left **unparsed** (mirrors the raw models).
   * Populated by `remember` and `list`; by `recall` only when `recencyWeight > 0`,
   * otherwise `undefined`.
   */
  createdAt?: string;
  /** The owning entity id (always equal to the Memory's `entityId`). */
  entityId?: string;
  /** Structured metadata attached to the memory. */
  metadata: Metadata;
  /**
   * Relevance signal, higher = more relevant. Populated by `recall` only.
   * **Relative within a single `recall` call; not comparable across calls.**
   */
  score?: number;
}

/**
 * Construction options for {@link Memory}. Extends {@link AetherClientOptions}
 * (so connection settings like `apiKey`/`baseUrl` flow straight through to the
 * owned raw client) plus a few Memory-specific knobs.
 */
export type MemoryOptions = AetherClientOptions & {
  /**
   * Half-life (in days) for the recency-decay curve used by
   * {@link Memory.recall} when `recencyWeight > 0`. At one half-life the recency
   * contribution is 0.5. Default: `30`.
   */
  halfLifeDays?: number;
  /**
   * Default for {@link Memory.remember}'s server-side fact extraction.
   * When `true`, `remember` distills the text into atomic facts stored as
   * sibling `kind:fact` memories (overridable per call via `remember`'s
   * `options.extract`). Requires fact extraction to be configured on the node.
   * Default: `false`.
   */
  extractFacts?: boolean;
  /**
   * Injectable clock returning "now", used by the recency-decay path so tests
   * are deterministic. Defaults to `() => new Date()` (system UTC time).
   */
  now?: () => Date;
  /**
   * Dependency-injection construction path: an already-configured raw client to
   * use instead of building one from the connection options. Used by tests and
   * by apps that share a single client across many entities.
   */
  client?: AetherClient;
};

/** Options for {@link Memory.recall}. */
export interface RecallOptions {
  /** Maximum number of memories to return. Default: `5`. */
  k?: number;
  /**
   * Recency weight in `[0, 1]` blending semantic similarity with recency decay.
   * `0` (default) is a pure-similarity, single-call search; `> 0` enables the
   * recency re-rank (which costs N+1 calls — see the README). Clamped to `[0, 1]`.
   */
  recencyWeight?: number;
  /** Only recall memories created at or after this RFC 3339 timestamp (inclusive). */
  since?: string;
  /** Only recall memories created at or before this RFC 3339 timestamp (inclusive). */
  until?: string;
  /** Structured metadata filter with equality or operator predicates. */
  filter?: MetadataFilter;
}

/** Options for {@link Memory.list}. */
export interface MemoryListOptions {
  /** Only list memories created at or after this RFC 3339 timestamp (inclusive). */
  since?: string;
  /** Only list memories created at or before this RFC 3339 timestamp (inclusive). */
  until?: string;
  /** Structured metadata filter with equality or operator predicates. */
  filter?: MetadataFilter;
  /** Maximum number of memories to return, newest first. Default: `50`. */
  limit?: number;
}

// ── Memory graph (Part II, ADR-019) ─────────────────

/**
 * A scalar memory value: `attributes` entries and a fact `value`. The engine
 * rejects nested objects/arrays (scalars only).
 */
export type ScalarValue = string | number | boolean | null;

/** The subject a fact is about. */
export type FactSubjectType = "owner" | "entity" | "relationship";

/** A typed node in the owner's memory graph (`/v1/memory/entities`). */
export interface MemoryEntity {
  memoryEntityId: string;
  /** The owner scope (= the Memory's `entityId`). */
  entityId: string;
  partition: string | null;
  entityType: string;
  displayName: string | null;
  aliases: string[];
  attributes: Record<string, ScalarValue>;
  createdAt: string;
  updatedAt: string;
}

/** A directed, typed edge between two entity nodes (`/v1/memory/relationships`). */
export interface MemoryRelationship {
  relationshipId: string;
  entityId: string;
  partition: string | null;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  attributes: Record<string, ScalarValue>;
  /** When the relationship became true, if known (RFC 3339). */
  validFrom: string | null;
  /** When Aether ingested it (RFC 3339). */
  observedAt: string;
  /** Null while active; set when retracted/superseded. */
  invalidFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A temporal fact with contradiction-resolution history (`/v1/memory/facts`). */
export interface MemoryFact {
  factId: string;
  entityId: string;
  partition: string | null;
  subjectType: FactSubjectType;
  subjectId: string | null;
  predicate: string;
  value: ScalarValue;
  cardinality: "single" | "multi";
  validFrom: string | null;
  observedAt: string;
  /** Null while active; set when superseded/retracted. */
  invalidFrom: string | null;
  supersedesFactId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Report returned by {@link Memory.consolidate} (`POST /v1/memory/consolidate`). */
export interface ConsolidationReport {
  activeFactsBefore: number;
  activeFactsAfter: number;
  retracted: number;
}

/** Options for {@link Memory.upsertEntity}. */
export interface UpsertEntityOptions {
  /** Existing id to update, or omit to mint a new entity. */
  memoryEntityId?: string;
  displayName?: string;
  aliases?: string[];
  attributes?: Record<string, ScalarValue>;
}

/** Options for {@link Memory.listEntities}. */
export interface ListEntitiesOptions {
  entityType?: string;
  limit?: number;
}

/** Options for {@link Memory.relate}. */
export interface RelateOptions {
  relationshipId?: string;
  attributes?: Record<string, ScalarValue>;
  validFrom?: string;
}

/** Options for {@link Memory.listRelationships}. */
export interface ListRelationshipsOptions {
  fromEntityId?: string;
  toEntityId?: string;
  relationshipType?: string;
  /** Include superseded/retracted edges. Default: `false`. */
  includeInactive?: boolean;
  /** RFC 3339 instant — return edges active as of this time. */
  asOf?: string;
  limit?: number;
}

/** Options for {@link Memory.rememberFact}. */
export interface RememberFactOptions {
  /** Default `"owner"`. */
  subjectType?: FactSubjectType;
  /** Required when `subjectType` is `entity` or `relationship`. */
  subjectId?: string;
  cardinality?: "single" | "multi";
  validFrom?: string;
  observedAt?: string;
  supersedesFactId?: string;
}

/** Options for {@link Memory.listFacts}. */
export interface ListFactsOptions {
  subjectType?: FactSubjectType;
  subjectId?: string;
  predicate?: string;
  includeInactive?: boolean;
  asOf?: string;
  limit?: number;
}

/** Options for {@link Memory.factHistory}. */
export interface FactHistoryOptions {
  /** Default `"owner"`. */
  subjectType?: FactSubjectType;
  /** Required when `subjectType` is `entity` or `relationship`. */
  subjectId?: string;
}

// Wire shapes (snake_case, as the engine serializes them) → parsed to the
// camelCase facade types above.
interface EntityWire {
  memory_entity_id: string;
  entity_id: string;
  partition: string | null;
  entity_type: string;
  display_name: string | null;
  aliases: string[];
  attributes: Record<string, ScalarValue>;
  created_at: string;
  updated_at: string;
}
interface RelationshipWire {
  relationship_id: string;
  entity_id: string;
  partition: string | null;
  from_entity_id: string;
  to_entity_id: string;
  relationship_type: string;
  attributes: Record<string, ScalarValue>;
  valid_from: string | null;
  observed_at: string;
  invalid_from: string | null;
  created_at: string;
  updated_at: string;
}
interface FactWire {
  fact_id: string;
  entity_id: string;
  partition: string | null;
  subject_type: FactSubjectType;
  subject_id: string | null;
  predicate: string;
  value: ScalarValue;
  cardinality: "single" | "multi";
  valid_from: string | null;
  observed_at: string;
  invalid_from: string | null;
  supersedes_fact_id: string | null;
  created_at: string;
  updated_at: string;
}

function parseEntity(d: EntityWire): MemoryEntity {
  return {
    memoryEntityId: d.memory_entity_id,
    entityId: d.entity_id,
    partition: d.partition ?? null,
    entityType: d.entity_type,
    displayName: d.display_name ?? null,
    aliases: d.aliases ?? [],
    attributes: d.attributes ?? {},
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}
function parseRelationship(d: RelationshipWire): MemoryRelationship {
  return {
    relationshipId: d.relationship_id,
    entityId: d.entity_id,
    partition: d.partition ?? null,
    fromEntityId: d.from_entity_id,
    toEntityId: d.to_entity_id,
    relationshipType: d.relationship_type,
    attributes: d.attributes ?? {},
    validFrom: d.valid_from ?? null,
    observedAt: d.observed_at,
    invalidFrom: d.invalid_from ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}
function parseFact(d: FactWire): MemoryFact {
  return {
    factId: d.fact_id,
    entityId: d.entity_id,
    partition: d.partition ?? null,
    subjectType: d.subject_type,
    subjectId: d.subject_id ?? null,
    predicate: d.predicate,
    value: d.value ?? null,
    cardinality: d.cardinality,
    validFrom: d.valid_from ?? null,
    observedAt: d.observed_at,
    invalidFrom: d.invalid_from ?? null,
    supersedesFactId: d.supersedes_fact_id ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

const VALID_SUBJECT_TYPES: FactSubjectType[] = ["owner", "entity", "relationship"];

/** Validate a (subjectType, subjectId) pair client-side (contract §13). */
function validateSubject(
  subjectType: FactSubjectType,
  subjectId?: string,
): [FactSubjectType, string | undefined] {
  if (!VALID_SUBJECT_TYPES.includes(subjectType)) {
    throw new AetherError(
      "subjectType must be 'owner', 'entity', or 'relationship'",
    );
  }
  if (subjectType === "owner") return ["owner", undefined];
  if (!subjectId) {
    throw new AetherError(
      `subjectId is required when subjectType is '${subjectType}'`,
    );
  }
  return [subjectType, subjectId];
}

function requireNonEmpty(name: string, value: string): void {
  if (!value || value.trim().length === 0) {
    throw new AetherError(`${name} is required`);
  }
}

// ── Recency re-rank tuning (contract §4 Mode B) ───────────────────────
const OVERFETCH = 4;
const MAX_CANDIDATES = 100;

/** Maximum `entity_id` length accepted by the server. */
const MAX_ENTITY_ID_LEN = 256;

/**
 * Parse an RFC 3339 timestamp to epoch milliseconds. A naive (no-offset) value
 * is treated as UTC. Returns `NaN` for an unparseable value (caller guards).
 */
function parseRfc3339(value: string): number {
  // `Date.parse` handles a trailing `Z` and explicit offsets natively. For a
  // naive timestamp (no `Z`/offset), treat it as UTC by appending `Z`.
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value);
  return Date.parse(hasZone ? value : `${value}Z`);
}

/**
 * Exponential half-life recency score in `[0, 1]`. `0.5 ** (age_days / half_life)`.
 * A `null`/missing or unparseable `createdAt` scores `0`; a future timestamp
 * (negative age, clamped to `0`) scores `1`.
 */
function recencyScore(
  createdAt: string | undefined,
  nowMs: number,
  halfLifeDays: number,
): number {
  if (createdAt == null) return 0;
  const createdMs = parseRfc3339(createdAt);
  if (Number.isNaN(createdMs)) return 0;
  const ageDays = Math.max(0, (nowMs - createdMs) / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Entity-scoped, ergonomic facade over {@link AetherClient}.
 *
 * `Memory` **owns** a raw client (composition, not inheritance) and scopes every
 * operation to a single `entityId` fixed at construction. It adds no HTTP routes,
 * no new error types, and changes no raw-client behavior — all transport, retry,
 * timeout, and error semantics are inherited unchanged.
 *
 * @example
 * ```typescript
 * const mem = new Memory("patient-john", { apiKey: "aether_..." });
 * await mem.remember("Anxious about flying; uses 4-7-8 breathing");
 * const hits = await mem.recall("anxiety coping");
 * ```
 */
export class Memory {
  /** The entity every operation is scoped to. Fixed at construction. */
  readonly entityId: string;

  private readonly client: AetherClient;
  private readonly halfLifeDays: number;
  private readonly extractFacts: boolean;
  private readonly now: () => Date;

  /**
   * @param entityId - The entity to scope all memories to (1–256 chars, non-empty).
   * @param options - Connection + Memory options. Pass `client` to inject a
   *   pre-built raw client (DI path); otherwise one is built from the options.
   * @throws {AetherError} If `entityId` is empty or longer than 256 chars
   *   (client-side — never a network round-trip).
   */
  constructor(entityId: string, options: MemoryOptions = {}) {
    if (!entityId || entityId.trim().length === 0) {
      throw new AetherError("entityId is required");
    }
    if (entityId.length > MAX_ENTITY_ID_LEN) {
      throw new AetherError(
        `entityId must be at most ${MAX_ENTITY_ID_LEN} characters`,
      );
    }
    this.entityId = entityId;
    this.client = options.client ?? new AetherClient(options);
    this.halfLifeDays = options.halfLifeDays ?? 30;
    this.extractFacts = options.extractFacts ?? false;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Store one memory for the entity. **One HTTP call.**
   *
   * The text is inserted via `insertText`, scoped to this Memory's entity via the
   * first-class `entity_id` field. `metadata` is sent as structured typed
   * document metadata. For older tag-based callers, string-safe metadata is also
   * mirrored into `key:value` tags where doing so is lossless.
   *
   * Pass `options.extract` (or set `extractFacts` on the Memory) to also distill
   * the text into atomic facts server-side; each fact is stored as a
   * sibling `kind:fact` memory and is recallable like any other. The returned
   * item is the raw memory, not the facts.
   *
   * @param text - The text to remember (must be non-empty / non-whitespace).
   * @param metadata - Optional structured metadata. Values must be strings,
   *   numbers, or booleans.
   * @param options - Optional per-call settings. `options.extract` overrides the
   *   Memory's `extractFacts` default for this call.
   * @returns A {@link MemoryItem} built from the returned document record.
   * @throws {AetherError} If `text` is empty/whitespace, or a metadata key is
   *   empty / contains `:` or `,`, or a value contains a comma (no HTTP call is
   *   made).
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async remember(
    text: string,
    metadata?: Metadata,
    options?: { extract?: boolean },
  ): Promise<MemoryItem> {
    if (!text || text.trim().length === 0) {
      throw new AetherError("text is required");
    }
    const tags = this.encodeLegacyMetadataTags(metadata);
    // Per-call `extract` wins, else the Memory's `extractFacts` default.
    const extract = options?.extract ?? this.extractFacts;
    const record = await this.client.insertText(text, {
      entityId: this.entityId,
      tags: tags.length > 0 ? tags : undefined,
      metadata,
      extractFacts: extract || undefined,
    });
    return {
      id: record.doc_id,
      text,
      createdAt: record.created_at,
      entityId: this.entityId,
      metadata: record.metadata ?? metadata ?? {},
    };
  }

  /**
   * Semantic search scoped to the entity, with optional client-side recency decay.
   *
   * - **`recencyWeight === 0` (default):** one `retrieve` call; `createdAt` is
   *   `undefined`, order is server order (closest first).
   * - **`recencyWeight > 0`:** overfetches candidates, resolves each candidate's
   *   `createdAt` via `get` (parallelized), and re-ranks by a deterministic blend
   *   of similarity and recency. Costs N+1 calls.
   *
   * @param query - Natural-language query (must be non-empty / non-whitespace).
   * @param options - Recall options.
   * @returns Up to `k` {@link MemoryItem}s. `score` is populated and relative
   *   within this call only.
   * @throws {AetherError} If `query` is empty/whitespace-only or `k < 1` (no HTTP
   *   call is made).
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async recall(query: string, options?: RecallOptions): Promise<MemoryItem[]> {
    if (!query || query.trim().length === 0) {
      throw new AetherError("query is required");
    }
    const k = options?.k ?? 5;
    if (k < 1) throw new AetherError("k must be at least 1");
    const recencyWeight = Math.min(1, Math.max(0, options?.recencyWeight ?? 0));
    const since = options?.since;
    const until = options?.until;
    const filter = options?.filter;

    // ── Mode A: pure similarity (1 call) ──────────────────────────────
    if (recencyWeight === 0) {
      const hits = await this.client.retrieve(query, k, {
        entityId: this.entityId,
        since,
        until,
        filter,
      });
      return hits.map((h) => ({
        id: h.doc_id,
        text: h.content,
        createdAt: undefined,
        entityId: this.entityId,
        metadata: h.metadata ?? {},
        score: 1 / (1 + h.distance),
      }));
    }

    // ── Mode B: recency decay (N+1 calls) ─────────────────────────────
    const candidates = await this.client.retrieve(
      query,
      Math.min(k * OVERFETCH, MAX_CANDIDATES),
      { entityId: this.entityId, since, until, filter },
    );
    if (candidates.length === 0) return [];

    // Resolve created_at per unique doc_id via get(), parallelized.
    const uniqueIds = Array.from(new Set(candidates.map((c) => c.doc_id)));
    const records = await Promise.all(
      uniqueIds.map((id) => this.client.get(id)),
    );
    const createdById = new Map<string, string | undefined>();
    uniqueIds.forEach((id, i) => createdById.set(id, records[i].created_at));

    const nowMs = this.now().getTime();
    const w = recencyWeight;
    const scored = candidates.map((c) => {
      const similarity = 1 / (1 + c.distance);
      const createdAt = createdById.get(c.doc_id);
      const recency = recencyScore(createdAt, nowMs, this.halfLifeDays);
      const blended = (1 - w) * similarity + w * recency;
      return { c, createdAt, blended };
    });

    // Total order → deterministic: blended DESC, distance ASC, doc_id ASC.
    scored.sort((a, b) => {
      if (b.blended !== a.blended) return b.blended - a.blended;
      if (a.c.distance !== b.c.distance) return a.c.distance - b.c.distance;
      return a.c.doc_id < b.c.doc_id ? -1 : a.c.doc_id > b.c.doc_id ? 1 : 0;
    });

    return scored.slice(0, k).map((s) => ({
      id: s.c.doc_id,
      text: s.c.content,
      createdAt: s.createdAt,
      entityId: this.entityId,
      metadata: s.c.metadata ?? {},
      score: s.blended,
    }));
  }

  /**
   * Chronological view of the entity's memories, **newest first**.
   *
   * Lists the entity's documents (1 call), then downloads each memory's text
   * (parallelized) to populate {@link MemoryItem.text}.
   *
   * > **Cost note:** `list` is **1 + N** calls (one listing + one content download
   * > per item). `limit` bounds N. Callers who only need metadata can drop to the
   * > raw `client.list({ entityId })`.
   *
   * @param options - List options.
   * @returns Up to `limit` {@link MemoryItem}s, newest first, with text populated.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async list(options?: MemoryListOptions): Promise<MemoryItem[]> {
    const limit = options?.limit ?? 50;
    const { documents } = await this.client.list({
      entityId: this.entityId,
      since: options?.since,
      until: options?.until,
      filter: options?.filter,
      limit,
    });
    const capped = documents.slice(0, limit);
    const texts = await Promise.all(
      capped.map((r) => this.client.downloadText(r.doc_id)),
    );
    return capped.map((r, i) => ({
      id: r.doc_id,
      text: texts[i],
      createdAt: r.created_at,
      entityId: r.entity_id ?? this.entityId,
      metadata: r.metadata ?? {},
    }));
  }

  /**
   * Return this entity's consolidated **extracted** facts (`kind:fact` memories),
   * highest corroborated confidence first.
   *
   * These are the free-text facts produced by `remember(text, metadata, {
   * extract: true })` and deduped server-side — distinct from the structured
   * memory-graph facts returned by {@link listFacts}. This is the clean,
   * high-signal view of what's known about the entity: one entry per distinct
   * fact, most-corroborated (then most-recent) first. Cost is 1 + N (one listing
   * plus a content download per fact).
   *
   * @param options - `limit` caps the number of facts (default 50).
   */
  async listExtractedFacts(options?: { limit?: number }): Promise<MemoryItem[]> {
    const limit = options?.limit ?? 50;
    const { documents } = await this.client.list({
      entityId: this.entityId,
      tags: ["kind:fact"],
      limit,
    });
    const sorted = [...documents].sort((a, b) => {
      const dc = Memory.factConfidence(b.tags) - Memory.factConfidence(a.tags);
      if (dc !== 0) return dc;
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    const capped = sorted.slice(0, limit);
    const texts = await Promise.all(
      capped.map((r) => this.client.downloadText(r.doc_id)),
    );
    return capped.map((r, i) => ({
      id: r.doc_id,
      text: texts[i],
      createdAt: r.created_at,
      entityId: r.entity_id ?? this.entityId,
      metadata: r.metadata ?? {},
    }));
  }

  /** Confidence (corroborating-source count) from a fact's `conf:` tag; 1 default. */
  private static factConfidence(tags: string[] | undefined): number {
    for (const t of tags ?? []) {
      if (t.startsWith("conf:")) {
        const n = parseInt(t.slice("conf:".length), 10);
        return Number.isFinite(n) && n > 0 ? n : 1;
      }
    }
    return 1;
  }

  /**
   * Delete one memory (soft tombstone; restorable via the raw `client.restore`).
   *
   * @param memoryId - The memory (document) id to forget. Must be non-empty.
   * @throws {AetherError} If `memoryId` is empty.
   * @throws {AetherApiError} On non-2xx API response (e.g. 404 if not found).
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async forget(memoryId: string): Promise<void> {
    if (!memoryId) throw new AetherError("memoryId is required");
    await this.client.delete(memoryId);
  }

  /**
   * Delete **every** memory for this entity. Pages the entity's listing and
   * deletes each document id until the listing is exhausted (deletes are
   * tombstones, so re-listing excludes already-deleted docs).
   *
   * @returns The number of memories deleted.
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async forgetAll(): Promise<number> {
    let deleted = 0;
    for (;;) {
      const { documents } = await this.client.list({
        entityId: this.entityId,
        limit: 1000,
      });
      if (documents.length === 0) break;
      await Promise.all(
        documents.map((d: DocumentRecord) => this.client.delete(d.doc_id)),
      );
      deleted += documents.length;
    }
    return deleted;
  }

  // ── Memory graph (Part II) ──────────────────────

  /** Scoped `/v1/memory/*` request: stamps the owner `entity_id` (partition is
   * injected by the client). */
  private graphRequest<T>(
    method: string,
    path: string,
    query: Record<string, string | number | boolean>,
    body?: unknown,
  ): Promise<T> {
    return this.client.memoryRequest<T>(
      method,
      path,
      { ...query, entity_id: this.entityId },
      body,
    );
  }

  /**
   * Create or update a typed entity node in this owner's graph. Omit
   * `memoryEntityId` to mint a new node; pass one (or an idempotency key) to
   * update. `attributes` values must be scalar.
   */
  async upsertEntity(
    entityType: string,
    options: UpsertEntityOptions = {},
  ): Promise<MemoryEntity> {
    requireNonEmpty("entityType", entityType);
    const body: Record<string, unknown> = { entity_type: entityType };
    if (options.memoryEntityId) body.memory_entity_id = options.memoryEntityId;
    if (options.displayName !== undefined) body.display_name = options.displayName;
    if (options.aliases !== undefined) body.aliases = options.aliases;
    if (options.attributes !== undefined) body.attributes = options.attributes;
    return parseEntity(
      await this.graphRequest<EntityWire>("POST", "/memory/entities", {}, body),
    );
  }

  /** Fetch one entity node by id. */
  async getEntity(memoryEntityId: string): Promise<MemoryEntity> {
    requireNonEmpty("memoryEntityId", memoryEntityId);
    return parseEntity(
      await this.graphRequest<EntityWire>(
        "GET",
        `/v1/memory/entities/${encodeURIComponent(memoryEntityId)}`,
        {},
      ),
    );
  }

  /** List this owner's entity nodes, optionally filtered by `entityType`. */
  async listEntities(options: ListEntitiesOptions = {}): Promise<MemoryEntity[]> {
    const query: Record<string, string | number | boolean> = {};
    if (options.entityType) query.entity_type = options.entityType;
    if (options.limit !== undefined) query.limit = options.limit;
    const r = await this.graphRequest<{ entities: EntityWire[]; count: number }>(
      "GET",
      "/memory/entities",
      query,
    );
    return r.entities.map(parseEntity);
  }

  /** Create or update a directed edge between two entity nodes. */
  async relate(
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
    options: RelateOptions = {},
  ): Promise<MemoryRelationship> {
    requireNonEmpty("fromEntityId", fromEntityId);
    requireNonEmpty("toEntityId", toEntityId);
    requireNonEmpty("relationshipType", relationshipType);
    const body: Record<string, unknown> = {
      from_entity_id: fromEntityId,
      to_entity_id: toEntityId,
      relationship_type: relationshipType,
    };
    if (options.relationshipId) body.relationship_id = options.relationshipId;
    if (options.attributes !== undefined) body.attributes = options.attributes;
    if (options.validFrom !== undefined) body.valid_from = options.validFrom;
    return parseRelationship(
      await this.graphRequest<RelationshipWire>(
        "POST",
        "/memory/relationships",
        {},
        body,
      ),
    );
  }

  /** List edges, optionally filtered. `asOf` returns edges active at that instant. */
  async listRelationships(
    options: ListRelationshipsOptions = {},
  ): Promise<MemoryRelationship[]> {
    const query: Record<string, string | number | boolean> = {};
    if (options.fromEntityId) query.from_entity_id = options.fromEntityId;
    if (options.toEntityId) query.to_entity_id = options.toEntityId;
    if (options.relationshipType) query.relationship_type = options.relationshipType;
    if (options.includeInactive) query.include_inactive = "true";
    if (options.asOf) query.as_of = options.asOf;
    if (options.limit !== undefined) query.limit = options.limit;
    const r = await this.graphRequest<{
      relationships: RelationshipWire[];
      count: number;
    }>("GET", "/memory/relationships", query);
    return r.relationships.map(parseRelationship);
  }

  /**
   * Assert a temporal fact about the owner (default), an entity, or a
   * relationship. A newer single-valued fact with the same (subject, predicate)
   * supersedes the prior one server-side, keeping it in history. `value` must be
   * scalar.
   */
  async rememberFact(
    predicate: string,
    value: ScalarValue,
    options: RememberFactOptions = {},
  ): Promise<MemoryFact> {
    requireNonEmpty("predicate", predicate);
    const [subjectType, subjectId] = validateSubject(
      options.subjectType ?? "owner",
      options.subjectId,
    );
    const body: Record<string, unknown> = {
      subject_type: subjectType,
      predicate,
      value,
    };
    if (subjectId !== undefined) body.subject_id = subjectId;
    if (options.cardinality !== undefined) body.cardinality = options.cardinality;
    if (options.validFrom !== undefined) body.valid_from = options.validFrom;
    if (options.observedAt !== undefined) body.observed_at = options.observedAt;
    if (options.supersedesFactId) body.supersedes_fact_id = options.supersedesFactId;
    return parseFact(
      await this.graphRequest<FactWire>("POST", "/memory/facts", {}, body),
    );
  }

  /** List active facts (default), or include superseded/retracted with `includeInactive`. */
  async listFacts(options: ListFactsOptions = {}): Promise<MemoryFact[]> {
    const query: Record<string, string | number | boolean> = {};
    if (options.subjectType !== undefined) {
      const [subjectType, subjectId] = validateSubject(
        options.subjectType,
        options.subjectId,
      );
      query.subject_type = subjectType;
      if (subjectId !== undefined) query.subject_id = subjectId;
    }
    if (options.predicate) query.predicate = options.predicate;
    if (options.includeInactive) query.include_inactive = "true";
    if (options.asOf) query.as_of = options.asOf;
    if (options.limit !== undefined) query.limit = options.limit;
    const r = await this.graphRequest<{ facts: FactWire[]; count: number }>(
      "GET",
      "/memory/facts",
      query,
    );
    return r.facts.map(parseFact);
  }

  /** Full assertion chain (active + superseded) for one (subject, predicate). */
  async factHistory(
    predicate: string,
    options: FactHistoryOptions = {},
  ): Promise<MemoryFact[]> {
    requireNonEmpty("predicate", predicate);
    const [subjectType, subjectId] = validateSubject(
      options.subjectType ?? "owner",
      options.subjectId,
    );
    const query: Record<string, string | number | boolean> = {
      history: "true",
      subject_type: subjectType,
      predicate,
    };
    if (subjectId !== undefined) query.subject_id = subjectId;
    const r = await this.graphRequest<{ facts: FactWire[]; count: number }>(
      "GET",
      "/memory/facts",
      query,
    );
    return r.facts.map(parseFact);
  }

  /** Soft-retract redundant facts in this scope; returns a report. */
  async consolidate(): Promise<ConsolidationReport> {
    const r = await this.graphRequest<{
      active_facts_before: number;
      active_facts_after: number;
      retracted: number;
    }>("POST", "/memory/consolidate", {});
    return {
      activeFactsBefore: r.active_facts_before,
      activeFactsAfter: r.active_facts_after,
      retracted: r.retracted,
    };
  }

  /**
   * Best-effort legacy tag mirror for old `Memory.remember(..., metadata)`
   * callers. Structured metadata is authoritative; tags are emitted only when
   * the old comma-joined `key:value` format can represent the pair losslessly.
   */
  private encodeLegacyMetadataTags(metadata?: Metadata): string[] {
    if (!metadata) return [];
    const tags: string[] = [];
    for (const key of Object.keys(metadata).sort()) {
      if (key.length === 0) {
        throw new AetherError("metadata key must not be empty");
      }
      const value = metadata[key];
      if (key.includes(":") || key.includes(",")) {
        throw new AetherError(
          `metadata key "${key}" must not contain ':' or ','`,
        );
      }
      if (String(value).includes(",")) {
        throw new AetherError(
          `metadata value for "${key}" must not contain a comma`,
        );
      }
      tags.push(`${key}:${value}`);
    }
    return tags;
  }
}
