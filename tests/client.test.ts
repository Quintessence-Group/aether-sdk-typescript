import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import {
  AetherApiError,
  AetherError,
  AetherNetworkError,
  CreditExhaustedError,
  TenantPausedError,
} from "../src/errors.js";

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

    it("throws CreditExhaustedError on a 402 credit_exhausted insert", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Prepaid credit balance exhausted; top up to continue.",
            code: "credit_exhausted",
          },
          402,
        ),
      );

      await expect(client.insertText("some text content")).rejects.toThrow(
        CreditExhaustedError,
      );
    });

    it("populates the typed error fields from a 402 credit_exhausted body", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Prepaid credit balance exhausted; top up to continue.",
            code: "credit_exhausted",
          },
          402,
        ),
      );

      try {
        await client.insertText("some text content");
        throw new Error("expected insertText to reject");
      } catch (e) {
        expect(e).toBeInstanceOf(CreditExhaustedError);
        expect(e).toBeInstanceOf(AetherApiError);
        const err = e as CreditExhaustedError;
        expect(err.status).toBe(402);
        expect(err.errorCode).toBe("credit_exhausted");
        expect(err.body.code).toBe("credit_exhausted");
      }
    });

    it("throws TenantPausedError on a 403 tenant_paused search", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "Tenant has been paused by the operator",
            code: "tenant_paused",
          },
          403,
        ),
      );

      try {
        await client.search("machine learning", 5);
        throw new Error("expected search to reject");
      } catch (e) {
        expect(e).toBeInstanceOf(TenantPausedError);
        expect(e).toBeInstanceOf(AetherApiError);
        const err = e as TenantPausedError;
        expect(err.status).toBe(403);
        expect(err.errorCode).toBe("tenant_paused");
        expect(err.body.error).toBe("Tenant has been paused by the operator");
      }
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
      expect(url).toContain("/v1/documents?");
      expect(url).toContain("filename=test.txt");
      expect(url).toContain("content_type=text%2Fplain");
      expect(result.doc_id).toBe("abc-123");
      expect(result.chunks).toBe(3);
    });

    it("sends entity_id as URL param when entityId is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          chunks: 3,
          vectors: 3,
          version: 1,
          entity_id: "customer-42",
        }),
      );

      const data = new TextEncoder().encode("hello world");
      const result = await client.insert(data, {
        filename: "test.txt",
        entityId: "customer-42",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
      expect(result.entity_id).toBe("customer-42");
    });

    it("omits entity_id when entityId is not provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          chunks: 3,
          vectors: 3,
          version: 1,
        }),
      );

      await client.insert(new TextEncoder().encode("hello"), { filename: "test.txt" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("entity_id");
    });

    it("sends source as URL param when source is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          chunks: 3,
          vectors: 3,
          version: 1,
          source: "slack",
        }),
      );

      const data = new TextEncoder().encode("hello world");
      const result = await client.insert(data, {
        filename: "test.txt",
        source: "slack",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("source=slack");
      expect(result.source).toBe("slack");
    });

    it("omits source when source is not provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          chunks: 3,
          vectors: 3,
          version: 1,
        }),
      );

      await client.insert(new TextEncoder().encode("hello"), { filename: "test.txt" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("source=");
    });

    it("echoes tags/source as defaults when the server omits them", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          chunks: 3,
          vectors: 3,
          version: 1,
        }),
      );

      const result = await client.insert(new TextEncoder().encode("hi"), {
        filename: "test.txt",
      });

      // Tolerant parsing: older payloads with no tags/source default cleanly.
      expect(result.tags).toEqual([]);
      expect(result.source).toBeNull();
    });

    it("round-trips tags/source/created_at from the insert response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          chunks: 3,
          vectors: 3,
          version: 1,
          tags: ["animal", "mammal"],
          source: "notion",
          created_at: "2026-06-15T09:30:00Z",
        }),
      );

      const result = await client.insert(new TextEncoder().encode("hi"), {
        filename: "test.txt",
      });

      expect(result.tags).toEqual(["animal", "mammal"]);
      expect(result.source).toBe("notion");
      expect(result.created_at).toBe("2026-06-15T09:30:00Z");
    });

    it("parses size_bytes, title, and content_type from the insert response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "blake3hash",
          title: "test.txt",
          content_type: "text/plain",
          size_bytes: 11,
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

      // size_bytes / title / content_type must survive the round-trip, mirroring get()/list().
      expect(result.size_bytes).toBe(11);
      expect(result.title).toBe("test.txt");
      expect(result.content_type).toBe("text/plain");
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
      expect(url).toContain("/v1/documents?");
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

    it("sends entity_id as URL param when entityId is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "stream-456",
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

      await client.insertStream(stream, { entityId: "customer-42" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
    });

    it("sends source as URL param when source is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "stream-789",
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

      await client.insertStream(stream, { source: "slack" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("source=slack");
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

    it("parses size_bytes from the insertText response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "txt-456",
          cid: "hash",
          title: "text.txt",
          content_type: "text/plain",
          size_bytes: 17,
          chunks: 1,
          vectors: 1,
          version: 1,
        }),
      );

      const result = await client.insertText("some text content");
      expect(result.size_bytes).toBe(17);
      expect(result.content_type).toBe("text/plain");
    });

    it("sends entity_id as URL param when entityId is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "txt-789",
          cid: "hash",
          chunks: 1,
          vectors: 1,
          version: 1,
        }),
      );

      await client.insertText("some text content", { entityId: "customer-42" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
    });

    it("sends source as URL param when source is provided", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "txt-790",
          cid: "hash",
          chunks: 1,
          vectors: 1,
          version: 1,
        }),
      );

      await client.insertText("some text content", { source: "slack" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("source=slack");
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
      expect(url).toContain("/v1/documents/abc-123?");
      expect(init.method).toBe("PUT");
      expect(result.version).toBe(2);
    });

    it("sends entity_id as URL param when entityId is provided", async () => {
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
      await client.update("abc-123", data, {
        filename: "test.txt",
        entityId: "customer-42",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
    });

    it("sends source as URL param when source is provided", async () => {
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
      await client.update("abc-123", data, {
        filename: "test.txt",
        source: "notion",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("source=notion");
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
      expect(url).toBe("http://localhost:9000/v1/documents/abc-123");
      expect(doc.title).toBe("Test Doc");
      expect(doc.size_bytes).toBe(1024);
    });

    it("round-trips tags and source on read", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "hash",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
          tags: ["animal", "mammal"],
          source: "slack",
        }),
      );

      const doc = await client.get("abc-123");
      expect(doc.tags).toEqual(["animal", "mammal"]);
      expect(doc.source).toBe("slack");
    });

    it("defaults tags to [] and source to null when omitted", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          cid: "hash",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
        }),
      );

      const doc = await client.get("abc-123");
      expect(doc.tags).toEqual([]);
      expect(doc.source).toBeNull();
    });
  });

  describe("lineage", () => {
    it("GETs the signed audit records for a document", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "abc-123",
          records: [
            {
              at: "2026-07-05T12:00:00+00:00",
              actor: "node:deadbeef",
              action: "document.inserted",
              resource: "document:abc-123",
              outcome: "committed",
              source: "ledger",
              proof: {
                content_id: "blake3:cafe",
                lamport: 42,
                node_id: "a".repeat(64),
                public_key: "pubkeyhex",
                signature: "sighex",
                verified: true,
              },
            },
            {
              at: "2026-07-05T12:05:00+00:00",
              actor: "node:deadbeef",
              action: "document.tombstoned",
              resource: "document:abc-123",
              outcome: "committed",
              source: "ledger",
              proof: {
                lamport: 43,
                node_id: "a".repeat(64),
                public_key: "pubkeyhex",
                signature: "sighex2",
                verified: true,
              },
            },
          ],
        }),
      );

      const records = await client.lineage("abc-123");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/audit/records/abc-123");
      expect(records).toHaveLength(2);
      expect(records[0].action).toBe("document.inserted");
      // Ledger records always carry a proof (`proof` is optional only because
      // access-audit records share the envelope without one).
      expect(records[0].proof?.content_id).toBe("blake3:cafe");
      expect(records[0].proof?.lamport).toBe(42);
      expect(records[0].proof?.verified).toBe(true);
      // A tombstone omits content_id -> it must come through as undefined.
      expect(records[1].action).toBe("document.tombstoned");
      expect(records[1].proof).toBeDefined();
      expect(records[1].proof?.content_id).toBeUndefined();
    });

    it("throws on empty docId", async () => {
      await expect(client.lineage("")).rejects.toThrow("docId");
    });

    it("throws AetherApiError on 404", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Document not found" }, 404),
      );
      await expect(client.lineage("nonexistent")).rejects.toThrow(
        AetherApiError,
      );
    });
  });

  describe("grounding receipts", () => {
    it("posts declared source ids and parses private provenance plus a public-safe receipt", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          answer_digest: "blake3:answer-commitment",
          sources: [{
            document_id: "doc-1",
            content_id: "aether:private-cid",
            rank: 0,
            retained_signed_event_count: 2,
            current_content_verified: true,
            proof: {
              content_id: "aether:private-cid",
              lamport: 42,
              node_id: "source-node-id",
              public_key: "source-public-key",
              signature: "source-signature",
              verified: true,
            },
          }],
          trust: {
            status: "verified",
            sources_requested: 1,
            sources_verified: 1,
            answer_bound: true,
          },
          binding: {
            algorithm: "blake3-keyed/aether-grounding-binding/v1",
            source_set_commitment: "blake3:sources",
            source_evidence_commitment: "blake3:evidence",
            binding_commitment: "opaque-binding",
            verification_salt: "authenticated-only-salt",
          },
          attestation: {
            version: "aether-grounding-set-attestation/v1",
            issued_at: "2026-07-10T00:00:00Z",
            binding_algorithm: "blake3-keyed/aether-grounding-binding/v1",
            signer_node_id: "grounding-node-id",
            signer_public_key: "grounding-public-key",
            signature: "grounding-signature",
            verified: true,
          },
          receipt: {
            version: "aether-grounding-receipt/v2",
            receipt_id: "receipt-1",
            issued_at: "2026-07-10T00:00:00Z",
            expires_at: "2026-08-09T00:00:00Z",
            source_count: 1,
            verified_source_count: 1,
            status: "verified",
            binding_commitment: "opaque-binding",
            capability_commitment: "blake3:capability",
            owner_commitment: "blake3:owner",
            attestation: {
              signer_node_id: "node-id",
              signer_public_key: "public-key",
              signature: "signature",
              verified: true,
            },
            share_url: "/receipts/capability",
            badge_url: "/receipts/capability/badge.svg",
          },
        }),
      );

      const receipt = await client.createGroundingReceipt(
        "private answer", ["doc-1"], { share: true },
      );
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/audit/grounding");
      expect(JSON.parse(init.body as string)).toEqual({
        answer: "private answer",
        source_doc_ids: ["doc-1"],
        share: true,
      });
      expect(receipt.sources[0].content_id).toBe("aether:private-cid");
      expect(receipt.sources[0].proof?.lamport).toBe(42);
      expect(receipt.trust.status).toBe("verified");
      expect(receipt.binding.source_evidence_commitment).toBe("blake3:evidence");
      expect(receipt.attestation.signature).toBe("grounding-signature");
      expect(receipt.attestation.verified).toBe(true);
      expect(receipt.receipt?.share_url).toBe("/receipts/capability");
      expect(receipt.receipt?.capability_commitment).toBe("blake3:capability");
      expect(receipt.receipt?.owner_commitment).toBe("blake3:owner");
      expect(receipt.receipt?.attestation.verified).toBe(true);

    });

    it.each([502, 503])(
      "does not retry share issuance after a %i response",
      async (status) => {
        mockFetch.mockReset();
        const retryClient = new AetherClient({
          baseUrl: "http://localhost:9000",
          maxRetries: 2,
          retryBaseDelay: 0,
        });
        mockFetch
          .mockResolvedValueOnce(jsonResponse({ error: `first-${status}` }, status))
          .mockResolvedValueOnce(jsonResponse({ answer_digest: "unexpected" }));

        let error: unknown;
        try {
          await retryClient.createGroundingReceipt("answer", ["doc-1"], { share: true });
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeInstanceOf(AetherApiError);
        expect((error as AetherApiError).status).toBe(status);
        expect((error as AetherApiError).body.error).toBe(`first-${status}`);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      },
    );

    it.each([502, 503])(
      "retains normal retry behavior for a private receipt after a %i response",
      async (status) => {
        mockFetch.mockReset();
        const retryClient = new AetherClient({
          baseUrl: "http://localhost:9000",
          maxRetries: 2,
          retryBaseDelay: 0,
        });
        mockFetch
          .mockResolvedValueOnce(jsonResponse({ error: `transient-${status}` }, status))
          .mockResolvedValueOnce(jsonResponse({ answer_digest: "blake3:retried" }));

        const result = await retryClient.createGroundingReceipt("answer", ["doc-1"]);

        expect(result.answer_digest).toBe("blake3:retried");
        expect(mockFetch).toHaveBeenCalledTimes(2);
      },
    );

    it("keeps a receipt private by default and revokes through a void DELETE", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          answer_digest: "blake3:answer-commitment",
          sources: [],
          trust: {
            status: "partial",
            sources_requested: 0,
            sources_verified: 0,
            answer_bound: true,
          },
          binding: {
            algorithm: "blake3-keyed/aether-grounding-binding/v1",
            source_set_commitment: "blake3:sources",
            binding_commitment: "opaque-binding",
            verification_salt: "authenticated-only-salt",
          },
        }),
      );
      const result = await client.createGroundingReceipt("answer", ["doc-1"]);
      expect(result.receipt).toBeUndefined();
      expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({
        answer: "answer", source_doc_ids: ["doc-1"],
      });

      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await client.revokeGroundingReceipt("receipt-1");
      expect(mockFetch.mock.calls[1][0]).toBe(
        "http://localhost:9000/v1/audit/receipts/receipt-1",
      );
      expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
    });

    it("validates required grounding inputs before making a request", async () => {
      await expect(client.createGroundingReceipt("", ["doc-1"])).rejects.toThrow("answer");
      await expect(client.createGroundingReceipt("answer", [])).rejects.toThrow("sourceDocIds");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("injects a partition handle into grounding creation and revocation", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          answer_digest: "blake3:answer",
          sources: [],
          trust: { status: "partial", sources_requested: 0, sources_verified: 0, answer_bound: true },
          binding: {
            algorithm: "blake3-keyed/aether-grounding-binding/v1",
            source_set_commitment: "blake3:sources",
            binding_commitment: "opaque-binding",
            verification_salt: "authenticated-only-salt",
          },
        }),
      );
      const scoped = client.partition("customer-a");
      await scoped.createGroundingReceipt("answer", ["doc-1"]);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toMatchObject({
        partition: "customer-a",
      });
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await scoped.revokeGroundingReceipt("receipt-1");
      expect(mockFetch.mock.calls[1][0]).toContain("partition=customer-a");
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

    it("passes entity and time window filters as URL params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ documents: [], count: 0, total: 0, has_more: false }),
      );

      await client.list({
        entityId: "customer-42",
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-10T23:59:59Z",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
      expect(url).toContain("since=2026-06-01T00%3A00%3A00Z");
      expect(url).toContain("until=2026-06-10T23%3A59%3A59Z");
    });

    it("passes last_n_days as URL param", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ documents: [], count: 0, total: 0, has_more: false }),
      );

      await client.list({ entityId: "customer-42", lastNDays: 30 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
      expect(url).toContain("last_n_days=30");
    });

    it("passes metadata facet filters as CSV URL params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ documents: [], count: 0, total: 0, has_more: false }),
      );

      await client.list({
        tags: ["animal", "mammal"],
        anyTags: ["dog", "cat"],
        contentTypes: ["text/plain", "text/markdown"],
        sources: ["slack", "notion"],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("tags=animal%2Cmammal");
      expect(url).toContain("any_tags=dog%2Ccat");
      expect(url).toContain("content_type=text%2Fplain%2Ctext%2Fmarkdown");
      expect(url).toContain("source=slack%2Cnotion");
    });

    it("omits filter params when no filters are set", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ documents: [], count: 0, total: 0, has_more: false }),
      );

      await client.list({ offset: 5, limit: 10 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("entity_id");
      expect(url).not.toContain("since");
      expect(url).not.toContain("until");
      expect(url).not.toContain("last_n_days");
      expect(url).not.toContain("any_tags");
      expect(url).not.toContain("content_type");
      expect(url).not.toContain("source");
    });

    it("normalizes tags/source on listed documents", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          documents: [
            {
              doc_id: "a",
              cid: "",
              content_type: "text/plain",
              size_bytes: 100,
              version: 1,
              tags: ["x"],
              source: "slack",
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
      expect(result.documents[0].tags).toEqual(["x"]);
      expect(result.documents[0].source).toBe("slack");
      expect(result.documents[1].tags).toEqual([]);
      expect(result.documents[1].source).toBeNull();
    });
  });

  describe("delete", () => {
    it("sends DELETE request", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "tombstoned", doc_id: "abc-123" }),
      );

      await client.delete("abc-123");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/documents/abc-123");
      expect(url).not.toContain("hard");
      expect(init.method).toBe("DELETE");
    });

    it("hard delete sends ?hard=true", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "hard_deleted", doc_id: "abc-123" }),
      );

      await client.delete("abc-123", { hard: true });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/documents/abc-123?hard=true");
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
      expect(url).toContain("/v1/documents/abc-123/restore");
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
              score: 85,
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
      expect(results[0].score).toBe(85);
    });

    it("defaults k to 10", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("k=10");
    });

    it("passes entity and time window filters as URL params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test", 5, {
        entityId: "customer:42",
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-10T23:59:59Z",
        maxDistance: 0.4,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer%3A42");
      expect(url).toContain("since=2026-06-01T00%3A00%3A00Z");
      expect(url).toContain("until=2026-06-10T23%3A59%3A59Z");
      expect(url).toContain("max_distance=0.4");
    });

    it("passes last_n_days as URL param", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test", 5, { entityId: "customer-42", lastNDays: 30 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
      expect(url).toContain("last_n_days=30");
    });

    it("omits filter params when no options are set", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test");
      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("entity_id");
      expect(url).not.toContain("since");
      expect(url).not.toContain("until");
      expect(url).not.toContain("last_n_days");
      expect(url).not.toContain("max_distance");
      expect(url).not.toContain("any_tags");
      expect(url).not.toContain("content_type");
      expect(url).not.toContain("source");
    });

    it("passes the metadata facet filters as CSV URL params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test", 5, {
        tags: ["animal"],
        anyTags: ["dog", "cat"],
        contentTypes: ["text/plain", "text/markdown"],
        sources: ["slack", "notion"],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("tags=animal");
      expect(url).toContain("any_tags=dog%2Ccat");
      expect(url).toContain("content_type=text%2Fplain%2Ctext%2Fmarkdown");
      expect(url).toContain("source=slack%2Cnotion");
    });

    it("echoes tags/source/created_at on hits and defaults them when omitted", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            {
              doc_id: "a",
              score: 90,
              content_type: "text/plain",
              tags: ["animal", "mammal"],
              source: "slack",
              created_at: "2026-06-15T09:30:00Z",
            },
            {
              doc_id: "b",
              score: 80,
              content_type: "text/plain",
            },
          ],
        }),
      );

      const results = await client.search("test", 5);
      expect(results[0].tags).toEqual(["animal", "mammal"]);
      expect(results[0].source).toBe("slack");
      expect(results[0].created_at).toBe("2026-06-15T09:30:00Z");
      // Tolerant parsing: older hits with no tags/source default cleanly.
      expect(results[1].tags).toEqual([]);
      expect(results[1].source).toBeNull();
      expect(results[1].created_at).toBeUndefined();
    });

    it("parses the calibrated score verbatim and reads created_at/updated_at", async () => {
      // The engine serves a calibrated `score` (0-100, higher = better).
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            {
              doc_id: "a",
              score: 90,
              content_type: "text/plain",
              created_at: "2026-06-15T09:30:00Z",
              updated_at: "2026-06-20T11:00:00Z",
            },
            {
              doc_id: "b",
              score: 0,
              content_type: "text/plain",
            },
          ],
        }),
      );

      const results = await client.search("test", 5);
      // The 0-100 score is surfaced verbatim, never rescaled client-side.
      expect(results[0].score).toBe(90);
      expect(results[1].score).toBe(0);
      expect(results[0].created_at).toBe("2026-06-15T09:30:00Z");
      expect(results[0].updated_at).toBe("2026-06-20T11:00:00Z");
      // updated_at defaults to null when the server omits it (never updated).
      expect(results[1].updated_at).toBeNull();
    });

    it("preserves the server's descending-score order", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            { doc_id: "a", score: 95, content_type: "text/plain" },
            { doc_id: "b", score: 40, content_type: "text/plain" },
          ],
        }),
      );

      const results = await client.search("test", 5);
      // The client never re-sorts; server order (best score first) is kept.
      expect(results.map((r) => r.score)).toEqual([95, 40]);
      expect(results[0].updated_at).toBeNull();
    });

    it("passes recency_weight and half_life_days as URL params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test", 5, {
        recencyWeight: 0.3,
        halfLifeDays: 14,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("recency_weight=0.3");
      expect(url).toContain("half_life_days=14");
    });

    it("omits recency params when not set", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test", 5);
      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("recency_weight");
      expect(url).not.toContain("half_life_days");
    });

    it("passes freshness_weight and freshness_half_life_days as URL params", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test", 5, {
        freshnessWeight: 0.4,
        freshnessHalfLifeDays: 7,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("freshness_weight=0.4");
      expect(url).toContain("freshness_half_life_days=7");
    });

    it("omits freshness params when not set", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "test", results: [] }),
      );

      await client.search("test", 5);
      const [url] = mockFetch.mock.calls[0];
      expect(url).not.toContain("freshness_weight");
      expect(url).not.toContain("freshness_half_life_days");
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
      expect(url).toContain("/v1/documents/abc-123/download");
    });
  });

  describe("retrieve", () => {
    it("returns search results with document content", async () => {
      // Mock search response
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test query",
          results: [
            { doc_id: "doc-1", score: 90, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-2", score: 70, title: "Doc 2", content_type: "text/plain" },
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
      expect(results[0].score).toBe(90);
      expect(results[1].content).toBe("Content of doc 2");
    });

    it("deduplicates results by doc_id", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            { doc_id: "doc-1", score: 90, title: "Doc 1", content_type: "text/plain" },
            { doc_id: "doc-1", score: 80, title: "Doc 1", content_type: "text/plain" },
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
      // Should keep the best-scoring match (score 90, not 80)
      expect(results[0].score).toBe(90);
    });

    it("forwards entity and time window filters to search", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            {
              doc_id: "doc-1",
              score: 90,
              content_type: "text/plain",
              content: "Inline content",
            },
          ],
        }),
      );

      await client.retrieve("test", 5, {
        entityId: "customer-42",
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-10T23:59:59Z",
        lastNDays: 30,
        maxDistance: 0.4,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/search?");
      expect(url).toContain("entity_id=customer-42");
      expect(url).toContain("since=2026-06-01T00%3A00%3A00Z");
      expect(url).toContain("until=2026-06-10T23%3A59%3A59Z");
      expect(url).toContain("last_n_days=30");
      expect(url).toContain("max_distance=0.4");
    });

    it("forwards metadata facet filters to search", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            {
              doc_id: "doc-1",
              score: 90,
              content_type: "text/plain",
              content: "Inline content",
            },
          ],
        }),
      );

      await client.retrieve("test", 5, {
        tags: ["animal"],
        anyTags: ["dog", "cat"],
        contentTypes: ["text/plain"],
        sources: ["slack", "notion"],
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/search?");
      expect(url).toContain("tags=animal");
      expect(url).toContain("any_tags=dog%2Ccat");
      expect(url).toContain("content_type=text%2Fplain");
      expect(url).toContain("source=slack%2Cnotion");
    });

    it("forwards recency params to search", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            {
              doc_id: "doc-1",
              score: 80,
              content_type: "text/plain",
              content: "Inline content",
            },
          ],
        }),
      );

      const results = await client.retrieve("test", 5, {
        recencyWeight: 0.5,
        halfLifeDays: 7,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/search?");
      expect(url).toContain("recency_weight=0.5");
      expect(url).toContain("half_life_days=7");
      // The calibrated score flows through the RAG path untouched.
      expect(results[0].score).toBe(80);
    });

    it("forwards freshness params to search", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "test",
          results: [
            {
              doc_id: "doc-1",
              score: 80,
              content_type: "text/plain",
              content: "Inline content",
            },
          ],
        }),
      );

      await client.retrieve("test", 5, {
        freshnessWeight: 0.4,
        freshnessHalfLifeDays: 3,
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/search?");
      expect(url).toContain("freshness_weight=0.4");
      expect(url).toContain("freshness_half_life_days=3");
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
      expect(url).toContain("/v1/documents/batch");
      expect(init.method).toBe("POST");
    });

    it("serializes per-item entity_id verbatim", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchInsert([
        { filename: "a.txt", content: "hello", entity_id: "customer-42" },
      ]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.documents[0].entity_id).toBe("customer-42");
    });

    it("serializes per-item source verbatim", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchInsert([
        { filename: "a.txt", content: "hello", source: "slack" },
      ]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.documents[0].source).toBe("slack");
    });

    it("normalizes tags/source on returned records", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [
          { doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1, tags: ["x"], source: "slack" },
          { doc_id: "b", cid: "c2", chunks: 1, vectors: 1, version: 1 },
        ],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.batchInsert([
        { filename: "a.txt", content: "x" },
        { filename: "b.txt", content: "y" },
      ]);
      expect(results[0].tags).toEqual(["x"]);
      expect(results[0].source).toBe("slack");
      expect(results[1].tags).toEqual([]);
      expect(results[1].source).toBeNull();
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

    it("serializes per-query filter fields verbatim", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ query: "test", results: [] }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchSearch([
        {
          q: "test",
          k: 5,
          entity_id: "customer-42",
          threadId: "support-42",
          since: "2026-06-01T00:00:00Z",
          until: "2026-06-10T23:59:59Z",
          last_n_days: 30,
          max_distance: 0.4,
        },
      ]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.queries[0].entity_id).toBe("customer-42");
      expect(body.queries[0].thread_id).toBe("support-42");
      expect(body.queries[0]).not.toHaveProperty("threadId");
      expect(body.queries[0].since).toBe("2026-06-01T00:00:00Z");
      expect(body.queries[0].until).toBe("2026-06-10T23:59:59Z");
      expect(body.queries[0].last_n_days).toBe(30);
      expect(body.queries[0].max_distance).toBe(0.4);
    });

    it("rejects an invalid per-query thread id before transport", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await expect(client.batchSearch([{ q: "test", threadId: "bad\u0000thread" }]))
        .rejects.toThrow("threadId");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("serializes per-query metadata facet fields as comma-separated strings", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ query: "test", results: [] }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchSearch([
        {
          q: "test",
          tags: ["animal", "mammal"],
          any_tags: ["dog", "cat"],
          content_type: ["text/plain", "text/markdown"],
          source: ["slack", "notion"],
        },
      ]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      // The batch route accepts these facets as comma-separated strings, NOT JSON
      // arrays — mirror the GET /search CSV convention on the wire.
      expect(body.queries[0].tags).toBe("animal,mammal");
      expect(body.queries[0].any_tags).toBe("dog,cat");
      expect(body.queries[0].content_type).toBe("text/plain,text/markdown");
      expect(body.queries[0].source).toBe("slack,notion");
    });

    it("omits empty metadata facet fields from each query", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ query: "test", results: [] }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchSearch([{ q: "test", tags: [], any_tags: ["dog"] }]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.queries[0]).not.toHaveProperty("tags");
      expect(body.queries[0].any_tags).toBe("dog");
      expect(body.queries[0]).not.toHaveProperty("content_type");
      expect(body.queries[0]).not.toHaveProperty("source");
    });

    it("normalizes tags/source on nested batch hits", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [
          {
            query: "test",
            results: [
              { doc_id: "a", score: 90, content_type: "text/plain", tags: ["x"], source: "slack" },
              { doc_id: "b", score: 80, content_type: "text/plain" },
            ],
          },
        ],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.batchSearch([{ q: "test" }]);
      expect(results[0].results[0].tags).toEqual(["x"]);
      expect(results[0].results[0].source).toBe("slack");
      expect(results[0].results[1].tags).toEqual([]);
      expect(results[0].results[1].source).toBeNull();
    });

    it("serializes per-query recency fields verbatim", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [{ query: "test", results: [] }],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchSearch([
        { q: "test", k: 5, recency_weight: 0.3, half_life_days: 14 },
      ]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.queries[0].recency_weight).toBe(0.3);
      expect(body.queries[0].half_life_days).toBe(14);
    });

    it("serializes per-query freshness fields verbatim", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [
          { query: "fresh", results: [] },
          { query: "plain", results: [] },
        ],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.batchSearch([
        { q: "fresh", k: 5, freshness_weight: 0.4, freshness_half_life_days: 7 },
        { q: "plain" },
      ]);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.queries[0].freshness_weight).toBe(0.4);
      expect(body.queries[0].freshness_half_life_days).toBe(7);
      expect(body.queries[1]).not.toHaveProperty("freshness_weight");
      expect(body.queries[1]).not.toHaveProperty("freshness_half_life_days");
    });

    it("parses score on nested batch hits and reads updated_at", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        results: [
          {
            query: "test",
            results: [
              {
                doc_id: "a",
                score: 60,
                content_type: "text/plain",
                updated_at: "2026-06-20T11:00:00Z",
              },
              { doc_id: "b", score: 80, content_type: "text/plain" },
            ],
          },
        ],
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.batchSearch([{ q: "test" }]);
      expect(results[0].results[0].score).toBe(60);
      expect(results[0].results[0].updated_at).toBe("2026-06-20T11:00:00Z");
      // hit with no updated_at -> null (never updated since insert)
      expect(results[0].results[1].score).toBe(80);
      expect(results[0].results[1].updated_at).toBeNull();
    });
  });

  // ── Entity backfill ──────────────────────────────────────────────

  describe("backfillEntityFromTags", () => {
    it("POSTs to /documents/backfill-entity with tag_prefix and overwrite=false by default", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        scanned: 0,
        updated: 0,
        skipped_existing: 0,
        skipped_no_match: 0,
        skipped_ambiguous: 0,
        skipped_invalid: 0,
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.backfillEntityFromTags("patient:");
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/documents/backfill-entity");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.tag_prefix).toBe("patient:");
      expect(body.overwrite).toBe(false);
    });

    it("forwards overwrite: true", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        scanned: 0,
        updated: 0,
        skipped_existing: 0,
        skipped_no_match: 0,
        skipped_ambiguous: 0,
        skipped_invalid: 0,
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.backfillEntityFromTags("patient:", { overwrite: true });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.tag_prefix).toBe("patient:");
      expect(body.overwrite).toBe(true);
    });

    it("parses the 200 report into the EntityBackfillReport shape", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        scanned: 100,
        updated: 73,
        skipped_existing: 12,
        skipped_no_match: 10,
        skipped_ambiguous: 4,
        skipped_invalid: 1,
      }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const report = await client.backfillEntityFromTags("patient:");
      expect(report.scanned).toBe(100);
      expect(report.updated).toBe(73);
      expect(report.skipped_existing).toBe(12);
      expect(report.skipped_no_match).toBe(10);
      expect(report.skipped_ambiguous).toBe(4);
      expect(report.skipped_invalid).toBe(1);
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
      expect(url).toContain("/v1/documents/async");
    });

    it("sends entity_id as URL param when entityId is provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ job_id: "j2", status: "pending", poll_url: "/documents/jobs/j2" }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.insertAsync(new Uint8Array([1, 2, 3]), {
        filename: "test.bin",
        entityId: "customer-42",
      });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("entity_id=customer-42");
    });

    it("sends source as URL param when source is provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ job_id: "j3", status: "pending", poll_url: "/documents/jobs/j3" }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.insertAsync(new Uint8Array([1, 2, 3]), {
        filename: "test.bin",
        source: "slack",
      });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("source=slack");
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
      expect(url).toContain("/v1/documents/embed");
      expect(init.method).toBe("POST");
    });

    it("includes entity_id in the JSON body when entityId is provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "e2", cid: "c2", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.insertWithEmbeddings({
        content: "hello",
        embedding: [0.1, 0.2],
        entityId: "customer-42",
      });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.entity_id).toBe("customer-42");
    });

    it("omits entity_id from the JSON body when entityId is not set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "e3", cid: "c3", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.insertWithEmbeddings({ content: "hello", embedding: [0.1, 0.2] });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty("entity_id");
    });

    it("includes source in the JSON body when source is provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "e4", cid: "c4", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.insertWithEmbeddings({
        content: "hello",
        embedding: [0.1, 0.2],
        source: "slack",
      });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.source).toBe("slack");
    });

    it("omits source from the JSON body when source is not set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "e5", cid: "c5", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.insertWithEmbeddings({ content: "hello", embedding: [0.1, 0.2] });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty("source");
    });
  });

  describe("searchByVector", () => {
    it("sends POST to /search/embed", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [{ doc_id: "a", score: 90, content_type: "text/plain" }] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.searchByVector([0.1, 0.2], 5);
      expect(results).toHaveLength(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/search/embed");
    });

    it("includes entity and time window filters in the JSON body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.searchByVector([0.1, 0.2], 5, {
        entityId: "customer-42",
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-10T23:59:59Z",
        lastNDays: 30,
        maxDistance: 0.4,
      });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.entity_id).toBe("customer-42");
      expect(body.since).toBe("2026-06-01T00:00:00Z");
      expect(body.until).toBe("2026-06-10T23:59:59Z");
      expect(body.last_n_days).toBe(30);
      expect(body.max_distance).toBe(0.4);
    });

    it("omits filter fields from the JSON body when no options are set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.searchByVector([0.1, 0.2], 5);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty("entity_id");
      expect(body).not.toHaveProperty("since");
      expect(body).not.toHaveProperty("until");
      expect(body).not.toHaveProperty("last_n_days");
      expect(body).not.toHaveProperty("max_distance");
      expect(body).not.toHaveProperty("any_tags");
      expect(body).not.toHaveProperty("content_type");
      expect(body).not.toHaveProperty("source");
    });

    it("sends the metadata facet filters as JSON arrays", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.searchByVector([0.1, 0.2], 5, {
        anyTags: ["dog", "cat"],
        contentTypes: ["text/plain"],
        sources: ["slack", "notion"],
      });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.any_tags).toEqual(["dog", "cat"]);
      expect(body.content_type).toEqual(["text/plain"]);
      expect(body.source).toEqual(["slack", "notion"]);
    });

    it("normalizes tags/source on returned hits", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "",
          results: [
            { doc_id: "a", score: 90, content_type: "text/plain", tags: ["x"], source: "slack" },
            { doc_id: "b", score: 80, content_type: "text/plain" },
          ],
        }),
      );
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.searchByVector([0.1, 0.2], 5);
      expect(results[0].tags).toEqual(["x"]);
      expect(results[0].source).toBe("slack");
      expect(results[1].tags).toEqual([]);
      expect(results[1].source).toBeNull();
    });

    it("includes recency_weight and half_life_days in the JSON body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.searchByVector([0.1, 0.2], 5, {
        recencyWeight: 0.3,
        halfLifeDays: 14,
      });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.recency_weight).toBe(0.3);
      expect(body.half_life_days).toBe(14);
    });

    it("omits recency fields from the JSON body when not set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.searchByVector([0.1, 0.2], 5);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty("recency_weight");
      expect(body).not.toHaveProperty("half_life_days");
    });

    it("includes freshness_weight and freshness_half_life_days in the JSON body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.searchByVector([0.1, 0.2], 5, {
        freshnessWeight: 0.4,
        freshnessHalfLifeDays: 7,
      });
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body.freshness_weight).toBe(0.4);
      expect(body.freshness_half_life_days).toBe(7);
    });

    it("omits freshness fields from the JSON body when not set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      await client.searchByVector([0.1, 0.2], 5);
      const [, init] = mockFetch.mock.calls[0];
      const body = JSON.parse(init.body as string);
      expect(body).not.toHaveProperty("freshness_weight");
      expect(body).not.toHaveProperty("freshness_half_life_days");
    });

    it("parses the calibrated score and reads updated_at", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "",
          results: [
            {
              doc_id: "a",
              score: 75,
              content_type: "text/plain",
              created_at: "2026-06-15T09:30:00Z",
              updated_at: "2026-06-20T11:00:00Z",
            },
          ],
        }),
      );
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      const results = await client.searchByVector([0.1, 0.2], 5);
      expect(results[0].score).toBe(75);
      expect(results[0].created_at).toBe("2026-06-15T09:30:00Z");
      expect(results[0].updated_at).toBe("2026-06-20T11:00:00Z");
    });
  });

  // ── Partition scoping ──────────────────────────────────
  //
  // A scoped handle auto-injects `partition` on every partition-aware read
  // and write; there is no per-call partition argument. The original client
  // stays unscoped. doc_id-addressed methods never send a partition.

  describe("partition scoping", () => {
    const base = new AetherClient({ baseUrl: "http://localhost:9000" });

    // ── Handle identity & immutability ──────────────────────────────
    describe("handle", () => {
      it("returns a distinct scoped object and leaves the original unscoped", () => {
        const scoped = base.partition("tenant-a");
        expect(scoped).not.toBe(base);
        expect(scoped).toBeInstanceOf(AetherClient);
      });

      it("the ORIGINAL client sends no partition (byte-identical)", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
        await base.search("hello");
        const [url] = mockFetch.mock.calls[0];
        expect(url).not.toContain("partition");
      });

      it("re-scoping is last-wins", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
        await base.partition("tenant-a").partition("tenant-b").search("hi");
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("partition=tenant-b");
        expect(url).not.toContain("partition=tenant-a");
      });

      it("shares config (auth header) with the parent", async () => {
        const authed = new AetherClient({
          baseUrl: "http://localhost:9000",
          apiKey: "aether_secret",
        });
        mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
        await authed.partition("tenant-a").search("hi");
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers.Authorization).toBe("Bearer aether_secret");
      });
    });

    // ── Query-route injection ───────────────────────────────────────
    describe("query-route methods send partition as a URL param", () => {
      it("search", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
        await base.partition("tenant-a").search("hello", 5);
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/v1/search?");
        expect(url).toContain("partition=tenant-a");
      });

      it("insertText", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "d", cid: "c", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
        await base.partition("tenant-a").insertText("hi");
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/v1/documents?");
        expect(url).toContain("partition=tenant-a");
      });

      it("list", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ documents: [], count: 0, total: 0, offset: 0, limit: 0, has_more: false }));
        await base.partition("tenant-a").list();
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/v1/documents?");
        expect(url).toContain("partition=tenant-a");
      });

      it("insert", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "d", cid: "c", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
        await base.partition("tenant-a").insert(new Uint8Array([1, 2]), { filename: "a.bin" });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("partition=tenant-a");
      });

      it("update", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "d", cid: "c", chunks: 1, vectors: 1, version: 2, content_type: "text/plain", size_bytes: 5 }));
        await base.partition("tenant-a").update("doc-1", new Uint8Array([1]), { filename: "a.bin" });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/v1/documents/doc-1?");
        expect(url).toContain("partition=tenant-a");
      });

      it("insertAsync", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ job_id: "j", status: "pending", poll_url: "/x" }));
        await base.partition("tenant-a").insertAsync(new Uint8Array([1]), { filename: "a.bin" });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/v1/documents/async?");
        expect(url).toContain("partition=tenant-a");
      });

      it("insertStream", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "d", cid: "c", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        });
        await base.partition("tenant-a").insertStream(stream, { filename: "a.bin" });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/v1/documents?");
        expect(url).toContain("partition=tenant-a");
      });

      it("retrieve inherits scoping via search (no special-case)", async () => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ query: "q", results: [{ doc_id: "d1", score: 90, content_type: "text/plain", content: "x" }] }),
        );
        await base.partition("tenant-a").retrieve("hello", 3);
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/v1/search?");
        expect(url).toContain("partition=tenant-a");
      });

      it("URL-encodes the partition value like entity_id", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
        await base.partition("tenant:a b").search("hi");
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("partition=tenant%3Aa+b");
      });
    });

    // ── JSON-body injection ─────────────────────────────────────────
    describe("body-route methods send partition as a JSON body field", () => {
      it("searchByVector", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ query: "", results: [] }));
        await base.partition("tenant-a").searchByVector([0.1, 0.2], 5);
        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body as string);
        expect(body.partition).toBe("tenant-a");
      });

      it("insertWithEmbeddings", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "e", cid: "c", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
        await base.partition("tenant-a").insertWithEmbeddings({ content: "hi", embedding: [0.1, 0.2] });
        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body as string);
        expect(body.partition).toBe("tenant-a");
      });

      it("batchInsert stamps the same partition on every item", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }, { doc_id: "b", cid: "c2", chunks: 1, vectors: 1, version: 1 }] }));
        await base.partition("tenant-a").batchInsert([
          { filename: "a.txt", content: "x" },
          { filename: "b.txt", content: "y" },
        ]);
        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body as string);
        expect(body.documents[0].partition).toBe("tenant-a");
        expect(body.documents[1].partition).toBe("tenant-a");
      });

      it("batchInsert does NOT mutate the caller's array", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ results: [{ doc_id: "a", cid: "c1", chunks: 1, vectors: 1, version: 1 }] }));
        const docs = [{ filename: "a.txt", content: "x" }];
        await base.partition("tenant-a").batchInsert(docs);
        expect(docs[0]).not.toHaveProperty("partition");
      });

      it("batchSearch stamps the same partition on every query", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ results: [{ query: "a", results: [] }, { query: "b", results: [] }] }));
        await base.partition("tenant-a").batchSearch([
          { q: "a", threadId: "thread-a" },
          { q: "b", threadId: "thread-b" },
        ]);
        const [, init] = mockFetch.mock.calls[0];
        const body = JSON.parse(init.body as string);
        expect(body.queries[0].partition).toBe("tenant-a");
        expect(body.queries[1].partition).toBe("tenant-a");
        expect(body.queries[0].thread_id).toBe("thread-a");
        expect(body.queries[1].thread_id).toBe("thread-b");
      });

      it("batchSearch does NOT mutate the caller's array", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ results: [{ query: "a", results: [] }] }));
        const queries = [{ q: "a", threadId: "thread-a" }];
        await base.partition("tenant-a").batchSearch(queries);
        expect(queries[0]).not.toHaveProperty("partition");
        expect(queries[0]).not.toHaveProperty("thread_id");
        expect(queries[0].threadId).toBe("thread-a");
      });
    });

    // ── doc_id-addressed methods send the partition as a guard ──────
    // (the boundary hardening: a scoped handle can no longer reach another
    // partition's document via a bare doc id — mismatch is the same 404 as
    // a nonexistent id)
    describe("doc_id-addressed methods send the partition guard when scoped", () => {
      it("get", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "doc-1", cid: "c", chunks: 1, vectors: 1, version: 1, content_type: "text/plain", size_bytes: 5 }));
        await base.partition("tenant-a").get("doc-1");
        const [url] = mockFetch.mock.calls[0];
        expect(url).toBe("http://localhost:9000/v1/documents/doc-1?partition=tenant-a");
      });

      it("delete", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({}));
        await base.partition("tenant-a").delete("doc-1");
        const [url] = mockFetch.mock.calls[0];
        expect(url).toBe("http://localhost:9000/v1/documents/doc-1?partition=tenant-a");
      });

      it("restore and download carry the guard; status stays unscoped", async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({}));
        await base.partition("tenant-a").restore("doc-1");
        expect(mockFetch.mock.calls[0][0]).toContain("partition=tenant-a");

        mockFetch.mockResolvedValueOnce(binaryResponse(new TextEncoder().encode("x")));
        await base.partition("tenant-a").download("doc-1");
        expect(mockFetch.mock.calls[1][0]).toContain("partition=tenant-a");

        mockFetch.mockResolvedValueOnce(jsonResponse({ node_id: 0, documents: 0, vectors: 0 }));
        await base.partition("tenant-a").status();
        expect(mockFetch.mock.calls[2][0]).not.toContain("partition");
      });
    });

    // ── Client-side validation (no HTTP call) ───────────────────────
    describe("validation rejects bad partition ids with no HTTP call", () => {
      it("rejects an empty id", () => {
        expect(() => base.partition("")).toThrow(AetherError);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it("rejects a whitespace-only id", () => {
        expect(() => base.partition("   ")).toThrow(AetherError);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it("rejects an id longer than 256 characters", () => {
        expect(() => base.partition("a".repeat(257))).toThrow(AetherError);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it("accepts an id of exactly 256 characters", () => {
        expect(() => base.partition("a".repeat(256))).not.toThrow();
      });
    });
  });
});

// ── Usage-feedback capture: query_id on hits + sendSearchFeedback ──

describe("usage feedback", () => {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
  });

  const hit = { doc_id: "doc-1", score: 90, content_type: "text/plain" };

  describe("query_id on search results", () => {
    it("stamps the response-level query_id onto every search hit", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "q",
          query_id: "11111111-2222-3333-4444-555555555555",
          results: [hit, { ...hit, doc_id: "doc-2" }],
        }),
      );

      const results = await client.search("q");
      expect(results.map((r) => r.queryId)).toEqual([
        "11111111-2222-3333-4444-555555555555",
        "11111111-2222-3333-4444-555555555555",
      ]);
    });

    it("leaves queryId undefined when the server omits query_id", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "q", results: [hit] }),
      );

      const results = await client.search("q");
      expect(results[0].queryId).toBeUndefined();
      expect(results[0].doc_id).toBe("doc-1");
    });

    it("stamps query_id on searchByVector hits", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ query: "", query_id: "qid-embed", results: [hit] }),
      );

      const results = await client.searchByVector([0.1, 0.2], 5);
      expect(results[0].queryId).toBe("qid-embed");
    });

    it("stamps each batch query's own query_id onto its hits", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          results: [
            { query: "a", query_id: "qid-a", results: [hit] },
            { query: "b", results: [{ ...hit, doc_id: "doc-2" }] },
          ],
        }),
      );

      const responses = await client.batchSearch([{ q: "a" }, { q: "b" }]);
      expect(responses[0].results[0].queryId).toBe("qid-a");
      expect(responses[1].results[0].queryId).toBeUndefined();
    });
  });

  describe("sendSearchFeedback", () => {
    it("POSTs the versioned path with the wire body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ recorded: true }));

      await client.sendSearchFeedback("qid-1", "doc-1", "used");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/search/feedback");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        query_id: "qid-1",
        doc_id: "doc-1",
        signal: "used",
      });
    });

    it("maps 404 (unknown query_id) to AetherApiError", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "unknown query_id" }, 404),
      );

      const err = await client
        .sendSearchFeedback("nope", "doc-1", "cited")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AetherApiError);
      expect((err as AetherApiError).status).toBe(404);
    });

    it("maps 400 (invalid signal) to AetherApiError", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "invalid signal", code: "invalid_input" }, 400),
      );

      const err = await client
        .sendSearchFeedback("qid-1", "doc-1", "loved" as unknown as "used")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AetherApiError);
      expect((err as AetherApiError).status).toBe(400);
      expect((err as AetherApiError).errorCode).toBe("invalid_input");
    });

    it("validates arguments client-side with no HTTP call", async () => {
      await expect(
        client.sendSearchFeedback("", "doc-1", "used"),
      ).rejects.toThrow(AetherError);
      await expect(
        client.sendSearchFeedback("qid-1", "", "used"),
      ).rejects.toThrow(AetherError);
      await expect(
        client.sendSearchFeedback("qid-1", "doc-1", "" as unknown as "used"),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
