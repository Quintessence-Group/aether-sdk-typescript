import { AetherClient, type AetherClientOptions } from "./client.js";
import { AetherError } from "./errors.js";
import type { DocumentRecord } from "./models.js";

/**
 * A single remembered item, the shared result type for {@link Memory.remember},
 * {@link Memory.recall}, and {@link Memory.list}.
 *
 * > **`metadata` is intentionally not a field (write-only limitation).** The raw
 * > document API does not echo `tags` on any read model, so metadata written via
 * > {@link Memory.remember} cannot be read back in v1. See the README.
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
   * contribution is 0.5. Must be positive. Default: `30`.
   */
  halfLifeDays?: number;
  /**
   * Reserved flag for future server-side fact extraction. **No-op in v1** — when
   * `true`, `remember` behaves identically to `false` (stores the text as a
   * single memory). Kept so a future extractor can split one `remember` into N
   * fact-memories without a breaking change. Default: `false`.
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
}

/** Options for {@link Memory.list}. */
export interface MemoryListOptions {
  /** Only list memories created at or after this RFC 3339 timestamp (inclusive). */
  since?: string;
  /** Only list memories created at or before this RFC 3339 timestamp (inclusive). */
  until?: string;
  /** Maximum number of memories to return, newest first. Default: `50`. */
  limit?: number;
}

// ── Recency re-rank tuning (MEMORY_CONTRACT.md §4 Mode B) ─────────────
// Identical constants across all four SDKs so the contract test produces the
// same ordering everywhere.
const OVERFETCH = 4;
const MAX_CANDIDATES = 100;

/** Maximum `entity_id` length accepted by the server (AET-146). */
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
 * Normalize a 0–100 calibrated relevance `score` (higher = better) to `[0, 1]`.
 *
 * Search hits carry a calibrated `score` (0–100) since the 0.3.0 redesign;
 * dividing by 100 puts it on the same `[0, 1]` scale as the recency term so the
 * §4 Mode B blend stays well-defined.
 */
function similarity(score: number): number {
  return score / 100;
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
   * @throws {AetherError} If `entityId` is empty or longer than 256 chars, or
   *   `halfLifeDays` is not positive (client-side — never a network round-trip).
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
    const halfLifeDays = options.halfLifeDays ?? 30;
    if (halfLifeDays <= 0) {
      throw new AetherError("halfLifeDays must be positive");
    }
    this.entityId = entityId;
    this.client = options.client ?? new AetherClient(options);
    this.halfLifeDays = halfLifeDays;
    // `extractFacts` is a reserved no-op in v1: there is no server-side
    // fact-extraction endpoint and this SDK carries no LLM dependency, so `true`
    // behaves identically to `false`. The flag keeps the signature stable for a
    // future extractor.
    this.extractFacts = options.extractFacts ?? false;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Store one memory for the entity. **One HTTP call.**
   *
   * The text is inserted via `insertText`, scoped to this Memory's entity via the
   * first-class `entity_id` field. `metadata` is encoded as searchable `key:value`
   * tags (one per pair). Note this metadata is **write-only** in v1 — no read
   * model echoes tags, so it cannot be read back (see the README).
   *
   * `extractFacts` is a reserved no-op in v1: a future server-side extractor may
   * split one `remember` into N fact-memories without a breaking change.
   *
   * @param text - The text to remember (must be non-empty / non-whitespace).
   * @param metadata - Optional `{string: string}` map written as `key:value`
   *   tags, emitted sorted by key so the wire string is byte-identical across
   *   languages. **Values are strings only in v1.** A client-side argument error
   *   is raised (before any HTTP call) for an empty key, a key containing `:` or
   *   `,`, or a value containing `,` (the tag wire format is comma-joined and
   *   cannot escape commas).
   * @returns A {@link MemoryItem} built from the returned document record.
   * @throws {AetherError} If `text` is empty/whitespace, or a metadata key is
   *   empty / contains `:` or `,`, or a value contains a comma (no HTTP call is
   *   made).
   * @throws {AetherApiError} On non-2xx API response.
   * @throws {AetherNetworkError} On connection or timeout failure.
   */
  async remember(
    text: string,
    metadata?: Record<string, string>,
  ): Promise<MemoryItem> {
    if (!text || text.trim().length === 0) {
      throw new AetherError("text is required");
    }
    const tags = this.encodeMetadata(metadata);
    const record = await this.client.insertText(text, {
      entityId: this.entityId,
      tags: tags.length > 0 ? tags : undefined,
    });
    return {
      id: record.doc_id,
      text,
      createdAt: record.created_at,
      entityId: record.entity_id ?? this.entityId,
    };
  }

  /**
   * Semantic search scoped to the entity, with optional client-side recency decay.
   *
   * - **`recencyWeight === 0` (default):** one `retrieve` call; `createdAt` is
   *   `undefined`, order is server order (best score first).
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

    // ── Mode A: pure similarity (1 search + N downloads) ──────────────
    if (recencyWeight === 0) {
      const hits = await this.client.retrieve(query, k, {
        entityId: this.entityId,
        since,
        until,
      });
      return hits.map((h) => ({
        id: h.doc_id,
        text: h.content,
        createdAt: undefined,
        entityId: this.entityId,
        score: similarity(h.score),
      }));
    }

    // ── Mode B: recency decay (N+1 calls) ─────────────────────────────
    const candidates = await this.client.retrieve(
      query,
      Math.min(k * OVERFETCH, MAX_CANDIDATES),
      { entityId: this.entityId, since, until },
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
      const sim = similarity(c.score);
      const createdAt = createdById.get(c.doc_id);
      const recency = recencyScore(createdAt, nowMs, this.halfLifeDays);
      const blended = (1 - w) * sim + w * recency;
      return { c, createdAt, blended };
    });

    // Total order → deterministic: blended DESC, score DESC, doc_id ASC.
    scored.sort((a, b) => {
      if (b.blended !== a.blended) return b.blended - a.blended;
      if (a.c.score !== b.c.score) return b.c.score - a.c.score;
      return a.c.doc_id < b.c.doc_id ? -1 : a.c.doc_id > b.c.doc_id ? 1 : 0;
    });

    return scored.slice(0, k).map((s) => ({
      id: s.c.doc_id,
      text: s.c.content,
      createdAt: s.createdAt,
      entityId: this.entityId,
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
    }));
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

  /**
   * Encode a metadata map as `key:value` tag strings (one per pair), **sorted by
   * key ascending** so the wire string is byte-identical across languages. The
   * first `:` separates key from value, so values may contain `:` but **not** `,`.
   *
   * Raises a client-side argument error (before any HTTP call) for an empty key,
   * a key containing `:` or `,`, or a value containing `,`.
   */
  private encodeMetadata(metadata?: Record<string, string>): string[] {
    if (!metadata) return [];
    const tags: string[] = [];
    for (const key of Object.keys(metadata).sort()) {
      if (key.length === 0) {
        throw new AetherError("metadata key must not be empty");
      }
      if (key.includes(":") || key.includes(",")) {
        throw new AetherError(
          `metadata key "${key}" must not contain ':' or ','`,
        );
      }
      const value = metadata[key];
      if (value.includes(",")) {
        throw new AetherError(
          `metadata value for "${key}" must not contain a comma`,
        );
      }
      tags.push(`${key}:${value}`);
    }
    return tags;
  }
}
