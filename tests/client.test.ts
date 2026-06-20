import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { AetherApiError, AetherNetworkError } from "../src/errors.js";

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

function binaryResponse(data: Uint8Array): Response {
  return new Response(data, {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

describe("AetherClient", () => {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
  });

  // ── Auth ────────────────────────────────────────────────────────

  describe("authentication", () => {
    it("sends Authorization header when apiKey is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ node_id: 0, cluster_mode: false, documents: 0, tombstoned: 0, vectors: 0, shards: 0, events: 0, wal_size_bytes: 0, erasure_coding: true, token_balance: 0 }),
      );
      await client.status();
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer aether_testkey123");
    });

    it("omits Authorization header when no apiKey", async () => {
      const noAuthClient = new AetherClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ node_id: 0, cluster_mode: false, documents: 0, tombstoned: 0, vectors: 0, shards: 0, events: 0, wal_size_bytes: 0, erasure_coding: true, token_balance: 0 }),
      );
      await noAuthClient.status();
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers.Authorization).toBeUndefined();
    });
  });

  // ── Error handling ──────────────────────────────────────────────

  describe("error handling", () => {
    it("throws AetherApiError on 401", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Invalid API key" }, 401),
      );
      await expect(client.status()).rejects.toThrow(AetherApiError);
      await mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Invalid API key" }, 401),
      );
      try {
        await client.status();
      } catch (e) {
        expect(e).toBeInstanceOf(AetherApiError);
        expect((e as AetherApiError).status).toBe(401);
      }
    });

    it("throws AetherApiError on 404", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Document not found" }, 404),
      );
      await expect(client.get("nonexistent")).rejects.toThrow(AetherApiError);
    });

    it("throws AetherNetworkError on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
      await expect(client.status()).rejects.toThrow(AetherNetworkError);
    });
  });

  // ── Documents ───────────────────────────────────────────────────

  describe("insert", () => {
    it("POSTs binary data with filename and content_type params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          chunks: 3,
          vectors: 3,
          version: 1,
        }),
      );

      const data = new TextEncoder().encode("hello world");
      const result = await client.insert(data, {
        filename: "test.txt",
        contentType: "text/plain",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents?");
      expect(url).toContain("filename=test.txt");
      expect(url).toContain("content_type=text%2Fplain");
      expect(result.doc_id).toBe("abc-123");
      expect(result.chunks).toBe(3);
    });
  });

  describe("insertStream", () => {
    it("POSTs a ReadableStream with filename and content_type params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "stream-123",
          cid: "streamhash",
          chunks: 5,
          vectors: 5,
          version: 1,
        }),
      );

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed data"));
          controller.close();
        },
      });

      const result = await client.insertStream(stream, {
        filename: "upload.pdf",
        contentType: "application/pdf",
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents?");
      expect(url).toContain("filename=upload.pdf");
      expect(url).toContain("content_type=application%2Fpdf");
      expect(init.method).toBe("POST");
      expect(result.doc_id).toBe("stream-123");
      expect(result.chunks).toBe(5);
    });

    it("uses default filename and content type when no options", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "def-123",
          cid: "hash",
          chunks: 1,
          vectors: 1,
          version: 1,
        }),
      );

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      });

      await client.insertStream(stream);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("filename=upload.bin");
      expect(url).toContain("content_type=application%2Foctet-stream");
    });

    it("does not retry on 503", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Service Unavailable" }, 503),
      );

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      });

      await expect(client.insertStream(stream)).rejects.toThrow(AetherApiError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("insertText", () => {
    it("POSTs UTF-8 encoded text", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "txt-456",
          cid: "hash",
          chunks: 1,
          vectors: 1,
          version: 1,
        }),
      );

      const result = await client.insertText("some text content");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("filename=text.txt");
      expect(url).toContain("content_type=text%2Fplain");
      expect(init.method).toBe("POST");
      expect(result.doc_id).toBe("txt-456");
    });
  });

  describe("update", () => {
    it("PUTs binary data to /documents/{id}", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "newhash",
          chunks: 4,
          vectors: 4,
          version: 2,
        }),
      );

      const data = new TextEncoder().encode("updated content");
      const result = await client.update("abc-123", data, {
        filename: "test.txt",
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/abc-123?");
      expect(init.method).toBe("PUT");
      expect(result.version).toBe(2);
    });
  });

  describe("get", () => {
    it("GETs document metadata", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "hash",
          title: "Test Doc",
          content_type: "text/plain",
          size_bytes: 1024,
          chunks: 3,
          vectors: 3,
          version: 1,
          created_at: "2024-01-01T00:00:00Z",
        }),
      );

      const doc = await client.get("abc-123");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/documents/abc-123");
      expect(doc.title).toBe("Test Doc");
      expect(doc.size_bytes).toBe(1024);
    });
  });

  describe("download", () => {
    it("returns ArrayBuffer", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      mockFetch.mockResolvedValueOnce(binaryResponse(bytes));

      const buf = await client.download("abc-123");
      expect(buf.byteLength).toBe(4);
      expect(new Uint8Array(buf)).toEqual(bytes);
    });
  });

  describe("list", () => {
    it("returns array of DocumentRecords", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          documents: [
            {
              doc_id: "a",
              cid: "",
              content_type: "text/plain",
              size_bytes: 100,
              version: 1,
            },
            {
              doc_id: "b",
              cid: "",
              content_type: "application/pdf",
              size_bytes: 200,
              version: 2,
            },
          ],
          count: 2,
          total: 2,
          has_more: false,
        }),
      );

      const result = await client.list();
      expect(result.documents).toHaveLength(2);
      expect(result.documents[0].doc_id).toBe("a");
      expect(result.documents[1].doc_id).toBe("b");
      expect(result.total).toBe(2);
      expect(result.has_more).toBe(false);
    });
  });

  describe("delete", () => {
    it("sends DELETE request", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "tombstoned", doc_id: "abc-123" }),
      );

      await client.delete("abc-123");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/abc-123");
      expect(init.method).toBe("DELETE");
    });
  });

  describe("restore", () => {
    it("POSTs to /documents/{id}/restore", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "restored", doc_id: "abc-123" }),
      );

      await client.restore("abc-123");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/abc-123/restore");
      expect(init.method).toBe("POST");
    });
  });

  // ── Search ──────────────────────────────────────────────────────

  describe("search", () => {
    it("passes query and k as URL params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "machine learning",
          results: [
            {
              doc_id: "abc",
              score: 92.5,
              title: "ML Intro",
              content_type: "text/plain",
            },
          ],
        }),
      );

      const results = await client.search("machine learning", 5);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("q=machine+learning");
      expect(url).toContain("k=5");
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(92.5);
    });

    it("defaults k to 10", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("k=10");
    });
  });

  // ── Cluster ─────────────────────────────────────────────────────

  describe("status", () => {
    it("returns NodeStatus", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          node_id: 0,
          cluster_mode: true,
          documents: 42,
          tombstoned: 1,
          vectors: 100,
          shards: 50,
          events: 200,
          wal_size_bytes: 4096,
          erasure_coding: true,
          token_balance: 9999,
        }),
      );

      const s = await client.status();
      expect(s.documents).toBe(42);
      expect(s.token_balance).toBe(9999);
    });
  });

  // ── Retrieval (RAG) ───────────────────────────────────────────

  describe("downloadText", () => {
    it("returns document content as string", async () => {
      const text = "Hello, this is document content.";
      const bytes = new TextEncoder().encode(text);
      mockFetch.mockResolvedValueOnce(binaryResponse(bytes));

      const result = await client.downloadText("abc-123");
      expect(result).toBe(text);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/abc-123/download");
    });
  });

  describe("retrieve", () => {
    it("returns search results with document content", async () => {
      // Mock search response
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test query",
          results: [
            { doc_id: "doc-1", score: 95, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-2", score: 80, title: "Doc 2", content_type: "text/plain" },
          ],
        }),
      );
      // Mock download responses (parallel)
      mockFetch.mockResolvedValueOnce(
        binaryResponse(new TextEncoder().encode("Content of doc 1")),
      );
      mockFetch.mockResolvedValueOnce(
        binaryResponse(new TextEncoder().encode("Content of doc 2")),
      );

      const results = await client.retrieve("test query", 5);
      expect(results).toHaveLength(2);
      expect(results[0].doc_id).toBe("doc-1");
      expect(results[0].content).toBe("Content of doc 1");
      expect(results[0].score).toBe(95);
      expect(results[1].content).toBe("Content of doc 2");
    });

    it("deduplicates results by doc_id", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            { doc_id: "doc-1", score: 95, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-1", score: 88, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-2", score: 70, title: "Doc 2", content_type: "text/plain" },
          ],
        }),
      );
      mockFetch.mockResolvedValueOnce(
        binaryResponse(new TextEncoder().encode("Content 1")),
      );
      mockFetch.mockResolvedValueOnce(
        binaryResponse(new TextEncoder().encode("Content 2")),
      );

      const results = await client.retrieve("test", 5);
      // Should only have 2 results despite 3 search hits
      expect(results).toHaveLength(2);
      // Should keep the best (first) match (score 95, not 88)
      expect(results[0].score).toBe(95);
    });
  });

  // ── URL construction ────────────────────────────────────────────

  describe("base URL handling", () => {
    it("strips trailing slashes from baseUrl", async () => {
      const c = new AetherClient({ baseUrl: "http://localhost:9000///" });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ node_id: 0, cluster_mode: false, documents: 0, tombstoned: 0, vectors: 0, shards: 0, events: 0, wal_size_bytes: 0, erasure_coding: true, token_balance: 0 }),
      );
      await c.status();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/status");
    });
  });

  // ── Retry logic ──────────────────────────────────────────────────

  describe("retry logic", () => {
    it("retries on 503 and succeeds", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
        .mockResolvedValueOnce(jsonResponse({ node_id: 1, documents: 0, vectors: 0 }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000", retryBaseDelay: 0.01 });
      const status = await client.status();
      expect(status.node_id).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("exhausts retries and throws", async () => {
      mockFetch
        .mockResolvedValue(jsonResponse({ error: "unavailable" }, 503));
      const client = new AetherClient({ baseUrl: "http://localhost:9000", maxRetries: 1, retryBaseDelay: 0.01 });
      await expect(client.status()).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    });

    it("does not retry on 404", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await expect(client.get("missing")).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("retries on network error", async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(jsonResponse({ node_id: 1, documents: 0, vectors: 0 }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000", retryBaseDelay: 0.01 });
      const status = await client.status();
      expect(status.node_id).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("respects maxRetries: 0", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));
      const client = new AetherClient({ baseUrl: "http://localhost:9000", maxRetries: 0 });
      await expect(client.status()).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ── Batch operations ─────────────────────────────────────────────

  describe("batchInsert", () => {
    it("sends POST to /documents/batch", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.batchInsert([{ filename: "a.txt", content: "hello" }]);
      expect(results).toHaveLength(1);
      expect(results[0].doc_id).toBe("a");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/batch");
      expect(init.method).toBe("POST");
    });

    it("joins each document's tags into a comma-separated string", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchInsert([{ filename: "a.txt", content: "hello", tags: ["x", "y", "z"] }]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      // Server's batch deserializer expects tags as a comma-joined string, not an array.
      expect(body.documents[0].tags).toBe("x,y,z");
    });

    it("omits tags when none are provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchInsert([{ filename: "a.txt", content: "hello" }]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.documents[0].tags).toBeUndefined();
    });
  });

  describe("batchSearch", () => {
    it("sends POST to /search/batch", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ query: "test", results: [{ doc_id: "a", score: 90, content_type: "text/plain" }] }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.batchSearch([{ q: "test", k: 5 }]);
      expect(results).toHaveLength(1);
      expect(results[0].query).toBe("test");
    });

    it("joins each query's tags into a comma-separated string", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ query: "test", results: [] }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchSearch([{ q: "test", k: 5, tags: ["a", "b"] }]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.queries[0].tags).toBe("a,b");
    });
  });

  // ── Async operations ─────────────────────────────────────────────

  describe("insertAsync", () => {
    it("sends POST to /documents/async", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ job_id: "j1", status: "pending", poll_url: "/documents/jobs/j1" }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const result = await client.insertAsync(new Uint8Array([1, 2, 3]), { filename: "test.bin" });
      expect(result.job_id).toBe("j1");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/async");
    });
  });

  describe("waitForJob", () => {
    it("polls until completed", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
        .mockResolvedValueOnce(jsonResponse({ status: "completed", doc_id: "d1" }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const result = await client.waitForJob("j1", { pollIntervalMs: 10 });
      expect(result.status).toBe("completed");
      expect(result.doc_id).toBe("d1");
    });
  });

  // ── Input validation ─────────────────────────────────────────────

  describe("input validation", () => {
    it("rejects empty docId in get()", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await expect(client.get("")).rejects.toThrow("docId");
    });

    it("rejects k < 1 in search()", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await expect(client.search("query", 0)).rejects.toThrow("k must be at least 1");
    });

    it("rejects empty query in search()", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await expect(client.search("", 5)).rejects.toThrow("query");
    });

    it("rejects empty documents in batchInsert()", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await expect(client.batchInsert([])).rejects.toThrow("documents");
    });
  });

  // ── BYOE (Bring Your Own Embeddings) ─────────────────────────────

  describe("insertWithEmbeddings", () => {
    it("sends POST to /documents/embed", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "e1", cid: "c1", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const doc = await client.insertWithEmbeddings({ content: "hello", embedding: [0.1, 0.2] });
      expect(doc.doc_id).toBe("e1");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/embed");
      expect(init.method).toBe("POST");
    });
  });

  describe("searchByVector", () => {
    it("sends POST to /search/embed", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [{ doc_id: "a", score: 90, content_type: "text/plain" }] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.searchByVector([0.1, 0.2], 5);
      expect(results).toHaveLength(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/search/embed");
    });
  });

  // ── entity_id (AET-146) ──────────────────────────────────────────

  describe("entity_id on insert family", () => {
    function docResponse() {
      return jsonResponse({
        doc_id: "e-1",
        cid: "c1",
        content_type: "text/plain",
        size_bytes: 5,
        chunks: 1,
        vectors: 1,
        version: 1,
        entity_id: "user-42",
      });
    }

    it("insert maps entityId to the entity_id query param", async () => {
      mockFetch.mockResolvedValueOnce(docResponse());
      const data = new TextEncoder().encode("hello");
      const doc = await client.insert(data, { filename: "a.txt", entityId: "user-42" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=user-42");
      expect(doc.entity_id).toBe("user-42");
    });

    it("insertText maps entityId to the entity_id query param", async () => {
      mockFetch.mockResolvedValueOnce(docResponse());
      await client.insertText("hello", { entityId: "user-42" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=user-42");
    });

    it("insertStream maps entityId to the entity_id query param", async () => {
      mockFetch.mockResolvedValueOnce(docResponse());
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data"));
          controller.close();
        },
      });
      await client.insertStream(stream, { entityId: "user-42" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=user-42");
    });

    it("update maps entityId to the entity_id query param", async () => {
      mockFetch.mockResolvedValueOnce(docResponse());
      const data = new TextEncoder().encode("updated");
      await client.update("e-1", data, { filename: "a.txt", entityId: "user-42" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=user-42");
    });

    it("insertWithEmbeddings sends entity_id in the JSON body", async () => {
      mockFetch.mockResolvedValueOnce(docResponse());
      await client.insertWithEmbeddings({ content: "hello", embedding: [0.1, 0.2], entityId: "user-42" });
      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body as string).entity_id).toBe("user-42");
    });

    it("omits entity_id when not provided", async () => {
      mockFetch.mockResolvedValueOnce(docResponse());
      await client.insertText("hello");
      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("entity_id");
    });
  });

  describe("entity_id and time-window filters on search/retrieve/list", () => {
    it("search forwards entityId, since, until and lastNDays as snake_case params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "q", results: [] }));
      await client.search("q", 5, {
        entityId: "user-42",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
        lastNDays: 7,
      });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=user-42");
      expect(url).toContain("since=2026-01-01");
      expect(url).toContain("until=2026-02-01");
      expect(url).toContain("last_n_days=7");
    });

    it("search keeps max_distance working alongside the new filters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "q", results: [] }));
      await client.search("q", 5, { maxDistance: 0.3, entityId: "user-42" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("max_distance=0.3");
      expect(url).toContain("entity_id=user-42");
    });

    it("list forwards the filters as snake_case params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ documents: [], count: 0, total: 0, has_more: false }),
      );
      await client.list({ entityId: "user-42", lastNDays: 30 });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=user-42");
      expect(url).toContain("last_n_days=30");
    });

    it("retrieve forwards entityId through to search", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "q",
          results: [
            { doc_id: "d-1", score: 90, content_type: "text/plain", entity_id: "user-42" },
          ],
        }),
      );
      // retrieve() downloads each unique doc's full text (search no longer inlines content).
      mockFetch.mockResolvedValueOnce(
        binaryResponse(new TextEncoder().encode("body")),
      );
      const results = await client.retrieve("q", 5, { entityId: "user-42" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=user-42");
      expect(results[0].entity_id).toBe("user-42");
      expect(results[0].content).toBe("body");
    });

    it("searchByVector sends the filters in the JSON body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      await client.searchByVector([0.1, 0.2], 5, {
        entityId: "user-42",
        since: "2026-01-01T00:00:00Z",
        until: "2026-02-01T00:00:00Z",
        lastNDays: 7,
      });
      const [, init] = mockFetch.mock.calls[0];
      const sent = JSON.parse(init.body as string);
      expect(sent.entity_id).toBe("user-42");
      expect(sent.since).toBe("2026-01-01T00:00:00Z");
      expect(sent.until).toBe("2026-02-01T00:00:00Z");
      expect(sent.last_n_days).toBe(7);
    });
  });

  describe("entity_id on batch operations", () => {
    it("batchInsert maps per-document entityId to entity_id", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }] }),
      );
      await client.batchInsert([{ filename: "a.txt", content: "hello", entityId: "user-42" }]);
      const [, init] = mockFetch.mock.calls[0];
      const sent = JSON.parse(init.body as string);
      expect(sent.documents[0].entity_id).toBe("user-42");
      expect(sent.documents[0]).not.toHaveProperty("entityId");
    });

    it("batchSearch maps per-query entityId and lastNDays to snake_case", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ results: [{ query: "q", results: [] }] }),
      );
      await client.batchSearch([
        { q: "q", k: 5, entityId: "user-42", since: "2026-01-01T00:00:00Z", lastNDays: 7 },
      ]);
      const [, init] = mockFetch.mock.calls[0];
      const sent = JSON.parse(init.body as string);
      expect(sent.queries[0].entity_id).toBe("user-42");
      expect(sent.queries[0].since).toBe("2026-01-01T00:00:00Z");
      expect(sent.queries[0].last_n_days).toBe(7);
      expect(sent.queries[0]).not.toHaveProperty("entityId");
      expect(sent.queries[0]).not.toHaveProperty("lastNDays");
    });
  });

  describe("backfillEntityFromTags", () => {
    it("POSTs tag_prefix and overwrite to /documents/backfill-entity", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          scanned: 10,
          updated: 5,
          skipped_existing: 2,
          skipped_no_match: 3,
          skipped_ambiguous: 0,
          skipped_invalid: 0,
        }),
      );
      const report = await client.backfillEntityFromTags("user:", { overwrite: true });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/documents/backfill-entity");
      expect(init.method).toBe("POST");
      const sent = JSON.parse(init.body as string);
      expect(sent.tag_prefix).toBe("user:");
      expect(sent.overwrite).toBe(true);
      expect(report.scanned).toBe(10);
      expect(report.updated).toBe(5);
      expect(report.skipped_existing).toBe(2);
      expect(report.skipped_no_match).toBe(3);
    });

    it("defaults overwrite to false", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          scanned: 0,
          updated: 0,
          skipped_existing: 0,
          skipped_no_match: 0,
          skipped_ambiguous: 0,
          skipped_invalid: 0,
        }),
      );
      await client.backfillEntityFromTags("user:");
      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body as string).overwrite).toBe(false);
    });

    it("rejects an empty tagPrefix", async () => {
      await expect(client.backfillEntityFromTags("")).rejects.toThrow("tagPrefix");
    });
  });
});
