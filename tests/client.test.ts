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
              distance: 0.15,
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
      expect(results[0].distance).toBe(0.15);
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
            { doc_id: "doc-1", distance: 0.1, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-2", distance: 0.3, title: "Doc 2", content_type: "text/plain" },
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
      expect(results[0].distance).toBe(0.1);
      expect(results[1].content).toBe("Content of doc 2");
    });

    it("deduplicates results by doc_id", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            { doc_id: "doc-1", distance: 0.1, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-1", distance: 0.2, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-2", distance: 0.3, title: "Doc 2", content_type: "text/plain" },
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
      // Should keep the closest match (distance 0.1, not 0.2)
      expect(results[0].distance).toBe(0.1);
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
  });

  describe("batchSearch", () => {
    it("sends POST to /search/batch", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ query: "test", results: [{ doc_id: "a", distance: 0.1, content_type: "text/plain" }] }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.batchSearch([{ q: "test", k: 5 }]);
      expect(results).toHaveLength(1);
      expect(results[0].query).toBe("test");
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
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [{ doc_id: "a", distance: 0.1, content_type: "text/plain" }] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.searchByVector([0.1, 0.2], 5);
      expect(results).toHaveLength(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/search/embed");
    });
  });
});
