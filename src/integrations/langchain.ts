/**
 * Aether VectorStore integration for LangChain (TypeScript).
 *
 * Mirrors the Python `aether.integrations.langchain.AetherVectorStore`: a
 * drop-in LangChain {@link VectorStore} backed by Aether. Aether parses text
 * and computes embeddings natively, so an embeddings model is **optional** — if
 * you don't pass one, Aether generates embeddings server-side and you can use
 * the store without ever running an embedding model locally. Pass a LangChain
 * `Embeddings` instance to embed client-side instead.
 *
 * `@langchain/core` is an optional peer dependency: install it only if you use
 * this adapter (`npm i @langchain/core`).
 *
 * @example Server-side embeddings (no local model)
 * ```ts
 * import { AetherClient } from "@aether-ai/sdk";
 * import { AetherVectorStore } from "@aether-ai/sdk/integrations/langchain";
 *
 * const client = new AetherClient({ apiKey: process.env.AETHER_API_KEY });
 * const store = new AetherVectorStore(client);
 * await store.addDocuments([
 *   { pageContent: "Aether is a memory layer for agents.", metadata: { tags: ["docs"] } },
 * ]);
 * const hits = await store.similaritySearch("what is aether?", 3);
 * ```
 */
import { Document, type DocumentInterface } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { VectorStore } from "@langchain/core/vectorstores";

import { AetherClient } from "../client.js";
import { AetherError } from "../errors.js";
import type { BatchInsertItem, SearchResult } from "../models.js";

/** Filter accepted by the Aether LangChain store: restrict to documents carrying ALL of these tags. */
export type AetherFilter = { tags?: string[] };

/**
 * Placeholder embeddings used when Aether computes embeddings server-side. The
 * store overrides every path that would touch the embeddings model, so these
 * reject only if a caller bypasses the store and calls them directly.
 */
const SERVER_SIDE_EMBEDDINGS: EmbeddingsInterface = {
  embedDocuments(): Promise<number[][]> {
    return Promise.reject(
      new AetherError(
        "This AetherVectorStore has no local embeddings model; Aether computes " +
          "embeddings server-side. Pass an Embeddings instance to embed client-side.",
      ),
    );
  },
  embedQuery(): Promise<number[]> {
    return Promise.reject(
      new AetherError(
        "This AetherVectorStore has no local embeddings model; Aether computes " +
          "embeddings server-side.",
      ),
    );
  },
};

/** Coerce a metadata `tags` value (string or string[]) into a clean string[] or undefined. */
function normalizeTags(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  const arr = Array.isArray(value) ? value : [value];
  const tags = arr.filter((t): t is string => typeof t === "string" && t.length > 0);
  return tags.length > 0 ? tags : undefined;
}

/** Build a LangChain {@link Document} from an Aether search hit. */
function toDocument(r: SearchResult): Document {
  const metadata: Record<string, unknown> = { doc_id: r.doc_id, distance: r.distance };
  if (r.title !== undefined) metadata.title = r.title;
  if (r.content_type) metadata.content_type = r.content_type;
  if (r.source != null) metadata.source = r.source;
  if (r.tags && r.tags.length > 0) metadata.tags = r.tags;
  return new Document({ pageContent: r.content ?? r.passage ?? "", metadata });
}

/**
 * A LangChain {@link VectorStore} backed by Aether.
 *
 * When constructed without an `Embeddings` instance, every write goes through
 * Aether's native batch ingestion and every query through Aether's server-side
 * search — no embedding model runs locally. When constructed with one, documents
 * and queries are embedded client-side and stored/searched via Aether's
 * bring-your-own-embeddings paths.
 */
export class AetherVectorStore extends VectorStore {
  declare FilterType: AetherFilter;

  /** The underlying Aether client (or a partition-scoped handle). */
  private readonly aether: AetherClient;
  /** True when an `Embeddings` model was supplied; false for server-side embedding. */
  private readonly hasLocalEmbeddings: boolean;
  /** Monotonic counter so generated filenames are unique within a process. */
  private static counter = 0;

  /**
   * @param client - An authenticated {@link AetherClient} (or `client.partition(id)` handle).
   * @param embedding - Optional LangChain embeddings model. Omit to let Aether
   *   compute embeddings server-side.
   */
  constructor(client: AetherClient, embedding?: EmbeddingsInterface) {
    super(embedding ?? SERVER_SIDE_EMBEDDINGS, {});
    this.aether = client;
    this.hasLocalEmbeddings = embedding != null;
  }

  _vectorstoreType(): string {
    return "aether";
  }

  /** Generate a stable, unique filename for a text payload (Aether mints the real doc id). */
  private nextFilename(): string {
    return `langchain_${AetherVectorStore.counter++}.txt`;
  }

  /**
   * Store precomputed vectors with their documents (bring-your-own-embeddings).
   * @returns The Aether document ids, one per input document.
   */
  async addVectors(
    vectors: number[][],
    documents: DocumentInterface[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const record = await this.aether.insertWithEmbeddings({
        content: doc.pageContent,
        embedding: vectors[i],
        filename: this.nextFilename(),
        tags: normalizeTags(doc.metadata?.tags),
      });
      ids.push(record.doc_id);
    }
    return ids;
  }

  /**
   * Add documents to the store. With a local embeddings model the texts are
   * embedded client-side; otherwise they are sent to Aether for native
   * embedding via a single batch request.
   * @returns The Aether document ids, one per input document.
   */
  async addDocuments(documents: DocumentInterface[]): Promise<string[]> {
    if (documents.length === 0) return [];

    if (this.hasLocalEmbeddings) {
      const vectors = await this.embeddings.embedDocuments(
        documents.map((d) => d.pageContent),
      );
      return this.addVectors(vectors, documents);
    }

    const items: BatchInsertItem[] = documents.map((doc) => ({
      filename: this.nextFilename(),
      content: doc.pageContent,
      tags: normalizeTags(doc.metadata?.tags),
    }));
    const results = await this.aether.batchInsert(items);
    return results.map((r) => r.doc_id);
  }

  /**
   * Similarity search by a precomputed query vector.
   * @returns `[document, similarity]` tuples, closest first.
   */
  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: AetherFilter,
  ): Promise<[Document, number][]> {
    const results = await this.aether.searchByVector(query, k, {
      includeContent: true,
      tags: filter?.tags,
    });
    // Aether returns a relevance distance (smaller = closer); LangChain expects
    // a similarity score where higher is more similar.
    return results.map((r) => [toDocument(r), 1 - r.distance]);
  }

  /**
   * Similarity search by text, returning documents with similarity scores.
   * Routes through Aether's server-side search unless a local embeddings model
   * was supplied (then the query is embedded client-side first).
   */
  async similaritySearchWithScore(
    query: string,
    k = 4,
    filter?: AetherFilter,
  ): Promise<[Document, number][]> {
    if (this.hasLocalEmbeddings) {
      const embedding = await this.embeddings.embedQuery(query);
      return this.similaritySearchVectorWithScore(embedding, k, filter);
    }
    const results = await this.aether.search(query, k, {
      includeContent: true,
      tags: filter?.tags,
    });
    return results.map((r) => [toDocument(r), 1 - r.distance]);
  }

  /** Similarity search by text, returning just the documents. */
  async similaritySearch(
    query: string,
    k = 4,
    filter?: AetherFilter,
  ): Promise<Document[]> {
    const withScore = await this.similaritySearchWithScore(query, k, filter);
    return withScore.map(([doc]) => doc);
  }

  /**
   * Build a store from raw texts. Mirrors LangChain's `fromTexts` factory; the
   * Aether client is supplied via `dbConfig.client`.
   */
  static async fromTexts(
    texts: string[],
    metadatas: object[] | object,
    embeddings: EmbeddingsInterface | undefined,
    dbConfig: { client: AetherClient },
  ): Promise<AetherVectorStore> {
    const docs = texts.map((text, i) => {
      const metadata = Array.isArray(metadatas) ? metadatas[i] : metadatas;
      return new Document({ pageContent: text, metadata: (metadata ?? {}) as Record<string, unknown> });
    });
    return AetherVectorStore.fromDocuments(docs, embeddings, dbConfig);
  }

  /**
   * Build a store from existing documents. Mirrors LangChain's `fromDocuments`
   * factory; the Aether client is supplied via `dbConfig.client`.
   */
  static async fromDocuments(
    docs: DocumentInterface[],
    embeddings: EmbeddingsInterface | undefined,
    dbConfig: { client: AetherClient },
  ): Promise<AetherVectorStore> {
    const store = new AetherVectorStore(dbConfig.client, embeddings);
    await store.addDocuments(docs);
    return store;
  }
}
