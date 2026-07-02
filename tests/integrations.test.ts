import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Document } from "@langchain/core/documents";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { TextNode } from "@llamaindex/core/schema";
import { VectorStoreQueryMode } from "@llamaindex/core/vector-store";

import { AetherClient } from "../src/client.js";
import { AetherVectorStore as LangChainStore } from "../src/integrations/langchain.js";
import { AetherVectorStore as LlamaIndexStore } from "../src/integrations/llamaindex.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

function docRecord(doc_id: string) {
  return {
    doc_id,
    cid: `cid_${doc_id}`,
    content_type: "text/plain",
    size_bytes: 0,
    chunks: 1,
    vectors: 1,
    version: 1,
  };
}

function searchResult(doc_id: string, score: number, content: string) {
  return { doc_id, score, content_type: "text/plain", content, title: doc_id };
}

function lastCall(): [string, RequestInit] {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const client = new AetherClient({ baseUrl: "http://localhost:9000", apiKey: "aether_testkey" });

describe("LangChain AetherVectorStore", () => {
  it("reports its vector store type", () => {
    expect(new LangChainStore(client)._vectorstoreType()).toBe("aether");
  });

  it("addDocuments uses server-side batch ingestion when no embeddings model is set", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [docRecord("d1"), docRecord("d2")] }),
    );
    const store = new LangChainStore(client);
    const ids = await store.addDocuments([
      new Document({ pageContent: "hello", metadata: { tags: ["a", "b"] } }),
      new Document({ pageContent: "world" }),
    ]);

    expect(ids).toEqual(["d1", "d2"]);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:9000/v1/documents/batch");
    const body = bodyOf(init);
    const documents = body.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(2);
    expect(documents[0].content).toBe("hello");
    expect(documents[0].tags).toBe("a,b"); // batch wire encodes tags as CSV
    expect(documents[1].content).toBe("world");
  });

  it("addDocuments embeds client-side and stores vectors when an embeddings model is set", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(docRecord("d1")));
    const embeddings: EmbeddingsInterface = {
      embedDocuments: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
      embedQuery: async () => [0.1, 0.2],
    };
    const store = new LangChainStore(client, embeddings);
    const ids = await store.addDocuments([new Document({ pageContent: "hi" })]);

    expect(ids).toEqual(["d1"]);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:9000/v1/documents/embed");
    const body = bodyOf(init);
    expect(body.content).toBe("hi");
    expect(body.embedding).toEqual([0.1, 0.2]);
  });

  it("similaritySearch runs a server-side text search and maps hits to Documents", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ query: "q", results: [searchResult("d1", 75, "passage one")] }),
    );
    const store = new LangChainStore(client);
    const docs = await store.similaritySearch("find me", 3, { tags: ["x"] });

    expect(docs).toHaveLength(1);
    expect(docs[0]).toBeInstanceOf(Document);
    expect(docs[0].pageContent).toBe("passage one");
    expect(docs[0].metadata.doc_id).toBe("d1");
    const [url] = lastCall();
    expect(url).toContain("/v1/search?");
    expect(url).toContain("q=find+me");
    expect(url).toContain("tags=x");
    expect(url).toContain("include_content=true");
  });

  it("similaritySearchWithScore normalizes the 0-100 score to a [0, 1] similarity", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ query: "q", results: [searchResult("d1", 75, "p")] }),
    );
    const store = new LangChainStore(client);
    const [[, score]] = await store.similaritySearchWithScore("q", 1);
    expect(score).toBeCloseTo(0.75);
  });

  it("similaritySearchVectorWithScore uses the bring-your-own-embeddings search", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ query: "", results: [searchResult("d1", 90, "p")] }),
    );
    const store = new LangChainStore(client);
    const out = await store.similaritySearchVectorWithScore([0.1, 0.2], 2);
    expect(out[0][1]).toBeCloseTo(0.9);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:9000/v1/search/embed");
    expect(bodyOf(init).embedding).toEqual([0.1, 0.2]);
  });

  it("fromTexts builds a store and ingests the texts", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [docRecord("d1")] }));
    const store = await LangChainStore.fromTexts(
      ["only text"],
      [{ tags: ["t"] }],
      undefined,
      { client },
    );
    expect(store).toBeInstanceOf(LangChainStore);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:9000/v1/documents/batch");
    expect((bodyOf(init).documents as Array<Record<string, unknown>>)[0].content).toBe("only text");
  });
});

describe("LlamaIndex AetherVectorStore", () => {
  it("exposes the expected store flags and client", () => {
    const store = new LlamaIndexStore(client);
    expect(store.storesText).toBe(true);
    expect(store.isEmbeddingQuery).toBe(false);
    expect(store.client()).toBe(client);
  });

  it("add ingests nodes via a single batch request", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ results: [docRecord("d1"), docRecord("d2")] }),
    );
    const store = new LlamaIndexStore(client);
    const ids = await store.add([
      new TextNode({ id_: "n1", text: "alpha", metadata: { tags: ["k"] } }),
      new TextNode({ id_: "n2", text: "beta" }),
    ]);

    expect(ids).toEqual(["d1", "d2"]);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:9000/v1/documents/batch");
    const documents = bodyOf(init).documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(2);
    expect(documents[0].content).toContain("alpha");
    expect(documents[0].tags).toBe("k");
    expect(documents[1].content).toContain("beta");
  });

  it("query runs a server-side text search and returns nodes + similarities", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ query: "q", results: [searchResult("d1", 80, "match text")] }),
    );
    const store = new LlamaIndexStore(client);
    const result = await store.query({
      queryStr: "needle",
      similarityTopK: 5,
      mode: VectorStoreQueryMode.DEFAULT,
    });

    expect(result.ids).toEqual(["d1"]);
    expect(result.similarities[0]).toBeCloseTo(0.8);
    expect(result.nodes?.[0]).toBeInstanceOf(TextNode);
    expect((result.nodes?.[0] as TextNode).text).toBe("match text");
    const [url] = lastCall();
    expect(url).toContain("/v1/search?");
    expect(url).toContain("q=needle");
  });

  it("query honors a precomputed queryEmbedding via the BYOE search", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ query: "", results: [searchResult("d1", 100, "p")] }),
    );
    const store = new LlamaIndexStore(client);
    const result = await store.query({
      queryEmbedding: [0.3, 0.4],
      similarityTopK: 1,
      mode: VectorStoreQueryMode.DEFAULT,
    });
    expect(result.similarities[0]).toBeCloseTo(1.0);
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:9000/v1/search/embed");
    expect(bodyOf(init).embedding).toEqual([0.3, 0.4]);
  });

  it("delete removes a document by id", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const store = new LlamaIndexStore(client);
    await store.delete("d1");
    const [url, init] = lastCall();
    expect(url).toBe("http://localhost:9000/v1/documents/d1");
    expect(init.method).toBe("DELETE");
  });
});
