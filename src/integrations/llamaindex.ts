/**
 * Aether VectorStore integration for LlamaIndex (TypeScript).
 *
 * Mirrors the Python `aether.integrations.llama_index.AetherVectorStore`: a
 * LlamaIndex {@link BaseVectorStore} backed by Aether. Aether parses text and
 * computes embeddings natively, so this store sets `isEmbeddingQuery = false` —
 * LlamaIndex passes the raw query string through and Aether embeds and searches
 * server-side. A precomputed `queryEmbedding` is still honored when present
 * (bring-your-own-embeddings).
 *
 * `@llamaindex/core` is an optional peer dependency: install it only if you use
 * this adapter (`npm i @llamaindex/core`).
 *
 * @example
 * ```ts
 * import { AetherClient } from "@aether-ai/sdk";
 * import { AetherVectorStore } from "@aether-ai/sdk/integrations/llamaindex";
 * import { TextNode } from "@llamaindex/core/schema";
 *
 * const client = new AetherClient({ apiKey: process.env.AETHER_API_KEY });
 * const store = new AetherVectorStore(client);
 * await store.add([new TextNode({ text: "Aether is a memory layer.", metadata: { tags: ["docs"] } })]);
 * ```
 */
import {
  BaseVectorStore,
  type MetadataFilters,
  type VectorStoreBaseParams,
  type VectorStoreQuery,
  type VectorStoreQueryResult,
} from "@llamaindex/core/vector-store";
import type { BaseEmbedding } from "@llamaindex/core/embeddings";
import { type BaseNode, MetadataMode, TextNode } from "@llamaindex/core/schema";

import { AetherClient } from "../client.js";
import { AetherError } from "../errors.js";
import type { BatchInsertItem } from "../models.js";

/**
 * Placeholder embed model. {@link BaseVectorStore}'s constructor eagerly resolves
 * an embed model from the global LlamaIndex `Settings` (which throws when none is
 * configured). Aether embeds server-side and `isEmbeddingQuery` is `false`, so
 * this is only stored, never invoked — it rejects with a clear message if a
 * caller bypasses the store and asks it to embed.
 */
const SERVER_SIDE_EMBED_MODEL = {
  embedBatchSize: 1,
  getTextEmbedding: () =>
    Promise.reject(
      new AetherError(
        "This AetherVectorStore has no local embed model; Aether computes " +
          "embeddings server-side. Pass an embedModel to embed client-side.",
      ),
    ),
  getQueryEmbedding: () =>
    Promise.reject(
      new AetherError(
        "This AetherVectorStore has no local embed model; Aether computes " +
          "embeddings server-side.",
      ),
    ),
} as unknown as BaseEmbedding;

/**
 * Best-effort extraction of tag filters from a LlamaIndex {@link MetadataFilters}.
 * Collects the values of any filter keyed `"tags"` (string or string[]), matching
 * the Python adapter's tag-mapping behavior. Other filter keys are ignored.
 */
function tagsFromFilters(filters: MetadataFilters | undefined): string[] | undefined {
  if (!filters?.filters) return undefined;
  const tags: string[] = [];
  for (const f of filters.filters) {
    if (f.key !== "tags") continue;
    const value: unknown = f.value;
    if (typeof value === "string") tags.push(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") tags.push(v);
    }
  }
  return tags.length > 0 ? tags : undefined;
}

/** Coerce a metadata `tags` value (string or string[]) into a clean string[] or undefined. */
function normalizeTags(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const tags = arr.filter((t): t is string => typeof t === "string" && t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/**
 * A LlamaIndex {@link BaseVectorStore} backed by Aether.
 *
 * Nodes are ingested via Aether's native batch ingestion (server-side parsing +
 * embedding). Queries run through Aether's server-side search by default; a
 * `queryEmbedding` on the {@link VectorStoreQuery} switches to the
 * bring-your-own-embeddings search path.
 */
export class AetherVectorStore extends BaseVectorStore<AetherClient> {
  storesText = true;
  /** Aether embeds server-side, so LlamaIndex should send the query string, not a vector. */
  isEmbeddingQuery = false;

  private readonly aether: AetherClient;
  private static counter = 0;

  /**
   * @param client - An authenticated {@link AetherClient} (or `client.partition(id)` handle).
   * @param params - Optional LlamaIndex vector-store params (e.g. an `embedModel`).
   */
  constructor(client: AetherClient, params?: VectorStoreBaseParams) {
    super({
      embedModel: params?.embedModel ?? params?.embeddingModel ?? SERVER_SIDE_EMBED_MODEL,
    });
    this.aether = client;
  }

  client(): AetherClient {
    return this.aether;
  }

  /**
   * Add nodes to the store via a single batch request.
   * @returns The Aether document ids, one per input node.
   */
  async add(nodes: BaseNode[]): Promise<string[]> {
    if (nodes.length === 0) return [];
    const items: BatchInsertItem[] = nodes.map((node) => ({
      filename: `llamaindex_${AetherVectorStore.counter++}.txt`,
      content: node.getContent(MetadataMode.ALL),
      tags: normalizeTags((node.metadata as Record<string, unknown> | undefined)?.tags),
    }));
    const results = await this.aether.batchInsert(items);
    return results.map((r) => r.doc_id);
  }

  /** Delete a document by its Aether id. */
  async delete(refDocId: string): Promise<void> {
    await this.aether.delete(refDocId);
  }

  /**
   * Query for the top-k most similar nodes. Uses Aether's server-side search for
   * a text query, or the bring-your-own-embeddings path when a `queryEmbedding`
   * is supplied.
   */
  async query(query: VectorStoreQuery): Promise<VectorStoreQueryResult> {
    const k = query.similarityTopK;
    const tags = tagsFromFilters(query.filters);

    const results = query.queryEmbedding
      ? await this.aether.searchByVector(query.queryEmbedding, k, { includeContent: true, tags })
      : await this.aether.search(query.queryStr ?? "", k, { includeContent: true, tags });

    const nodes: BaseNode[] = [];
    const similarities: number[] = [];
    const ids: string[] = [];
    for (const r of results) {
      nodes.push(
        new TextNode({
          id_: r.doc_id,
          text: r.content ?? r.passage ?? "",
          metadata: { title: r.title, content_type: r.content_type, distance: r.distance },
        }),
      );
      // Aether returns a relevance distance (smaller = closer); LlamaIndex
      // expects a similarity where higher is more similar.
      similarities.push(1 - r.distance);
      ids.push(r.doc_id);
    }
    return { nodes, similarities, ids };
  }
}
