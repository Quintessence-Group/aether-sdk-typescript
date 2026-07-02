import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { Memory } from "../src/memory.js";
import {
  AetherApiError,
  AetherError,
  CreditExhaustedError,
} from "../src/errors.js";

// ── Transport mock (same layer as tests/client.test.ts) ───────────────
// We mock the global `fetch` and construct Memory around a REAL AetherClient
// (DI path, contract §1) so the actual client code runs end-to-end. We never
// mock Memory's own methods.

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

function binaryResponse(text: string): Response {
  return new Response(new TextEncoder().encode(text), {
    status: 200,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

/** A search/retrieve `{query, results}` envelope with inlined content so the
 *  raw `retrieve` does not issue extra download calls. */
function retrieveResponse(
  results: Array<{ doc_id: string; distance: number; content: string }>,
): Response {
  return jsonResponse({
    query: "q",
    results: results.map((r) => ({
      ...r,
      content_type: "text/plain",
    })),
  });
}

function newMemory(entityId = "patient-john", opts = {}): Memory {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
    maxRetries: 0,
  });
  return new Memory(entityId, { client, ...opts });
}

/** Parse the URL + init of the Nth fetch call. */
function call(n: number): { url: string; init: RequestInit } {
  const [url, init] = mockFetch.mock.calls[n];
  return { url: url as string, init: init as RequestInit };
}

describe("Memory", () => {
  // ── §8.1 scoping ────────────────────────────────────────────────────
  describe("scoping (§8.1)", () => {
    it("remember sends the configured entity_id as the entity_id field", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-1",
          cid: "",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
          created_at: "2026-06-15T00:00:00Z",
        }),
      );
      const mem = newMemory("patient-john");
      await mem.remember("hello");
      const { url } = call(0);
      expect(url).toContain("entity_id=patient-john");
    });

    it("recall sends entity_id as the filter", async () => {
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([{ doc_id: "d", distance: 0.2, content: "x" }]),
      );
      const mem = newMemory("patient-john");
      await mem.recall("anxiety");
      const { url } = call(0);
      expect(url).toContain("/v1/search?");
      expect(url).toContain("entity_id=patient-john");
    });

    it("list sends entity_id as the filter", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ documents: [], count: 0, total: 0, has_more: false }),
      );
      const mem = newMemory("patient-john");
      await mem.list();
      const { url } = call(0);
      expect(url).toContain("/v1/documents");
      expect(url).toContain("entity_id=patient-john");
    });
  });

  // ── §8.2 remember round-trip ────────────────────────────────────────
  describe("remember round-trip (§8.2)", () => {
    it("returns a MemoryItem with id and created_at from the response", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-42",
          cid: "",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
          created_at: "2026-06-15T12:00:00Z",
        }),
      );
      const mem = newMemory("patient-john");
      const item = await mem.remember("Anxious about flying");
      expect(item.id).toBe("doc-42");
      expect(item.text).toBe("Anxious about flying");
      expect(item.createdAt).toBe("2026-06-15T12:00:00Z");
      expect(item.entityId).toBe("patient-john");
      expect(item.score).toBeUndefined();
    });

    it("rejects empty/whitespace text with a client-side error (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(mem.remember("   ")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── §8.3 metadata → tags ────────────────────────────────────────────
  describe("metadata → tags (§8.3)", () => {
    it("encodes metadata as key:value tags", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-1",
          cid: "",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
          created_at: "2026-06-15T00:00:00Z",
        }),
      );
      const mem = newMemory("patient-john");
      // String-only values (v1). Keys are emitted sorted ascending, so the wire
      // string is byte-identical across languages regardless of insertion order.
      await mem.remember("text", { topic: "anxiety", severity: "high" });
      const { url } = call(0);
      const decoded = decodeURIComponent(url);
      expect(decoded).toContain("tags=severity:high,topic:anxiety");
    });

    it("sorts prefix keys by key, not by assembled tag (a:v,a0:w)", async () => {
      // Regression: one key is a prefix of another. Sorting the assembled
      // "key:value" strings would give "a0:w,a:v" ('0' 0x30 < ':' 0x3A);
      // sorting KEYS (the contract) gives "a:v,a0:w" — matching py/go/.NET.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-1",
          cid: "",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
        }),
      );
      const mem = newMemory("patient-john");
      await mem.remember("text", { a0: "w", a: "v" });
      const decoded = decodeURIComponent(call(0).url);
      expect(decoded).toContain("tags=a:v,a0:w");
    });

    it("rejects a metadata value containing a comma (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(
        mem.remember("text", { note: "a,b" }),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects an empty metadata key (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(
        mem.remember("text", { "": "value" }),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a metadata key containing a colon (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(
        mem.remember("text", { "a:b": "value" }),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a metadata key containing a comma (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(
        mem.remember("text", { "a,b": "value" }),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── §8.4 recall default (recency_weight = 0) ────────────────────────
  describe("recall default (§8.4)", () => {
    it("issues exactly one retrieve call, created_at null, server order preserved", async () => {
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([
          { doc_id: "first", distance: 0.10, content: "A" },
          { doc_id: "second", distance: 0.40, content: "B" },
        ]),
      );
      const mem = newMemory("patient-john");
      const items = await mem.recall("anxiety coping", { k: 5 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const { url } = call(0);
      expect(url).toContain("/v1/search?");
      expect(url).toContain("include_content=true");
      expect(url).toContain("k=5");

      expect(items.map((i) => i.id)).toEqual(["first", "second"]);
      expect(items[0].createdAt).toBeUndefined();
      expect(items[1].createdAt).toBeUndefined();
      // similarity = 1/(1+distance)
      expect(items[0].score).toBeCloseTo(1 / 1.1, 10);
      expect(items[1].score).toBeCloseTo(1 / 1.4, 10);
    });

    it("forwards since/until to the retrieve call", async () => {
      mockFetch.mockResolvedValueOnce(retrieveResponse([]));
      const mem = newMemory("patient-john");
      await mem.recall("q", {
        since: "2026-06-01T00:00:00Z",
        until: "2026-06-10T00:00:00Z",
      });
      const { url } = call(0);
      expect(url).toContain("since=2026-06-01T00%3A00%3A00Z");
      expect(url).toContain("until=2026-06-10T00%3A00%3A00Z");
    });

    it("rejects an empty query with a client-side error (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(mem.recall("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a whitespace-only query with a client-side error (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(mem.recall("   ")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects k < 1 with a client-side error (no HTTP call)", async () => {
      const mem = newMemory();
      await expect(mem.recall("q", { k: 0 })).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── §8.5 recall recency (golden ordering) ───────────────────────────
  describe("recall recency (§8.5)", () => {
    it("re-ranks by the §4 blended formula — canonical §8.1 golden vector", async () => {
      // Shared cross-language golden vector (MEMORY_CONTRACT.md §8.1). These exact
      // inputs and this exact asserted order must be identical in all four SDKs.
      const now = () => new Date("2026-06-15T00:00:00Z");

      // retrieve returns candidates in server order (ascending distance).
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([
          { doc_id: "doc-e", distance: 0.05, content: "E" }, // best distance, null ts
          { doc_id: "doc-a", distance: 0.1, content: "A" }, // 165 days old
          { doc_id: "doc-b", distance: 0.2, content: "B" }, // 1 day (freshest)
          { doc_id: "doc-c", distance: 0.3, content: "C" }, // 5 days
          { doc_id: "doc-d", distance: 0.4, content: "D" }, // 30 days = 1 half-life
        ]),
      );

      // get(doc_id) returns each created_at (doc-e: null) — order = first
      // appearance in candidates (doc-e, doc-a, doc-b, doc-c, doc-d).
      const records: Record<string, string | undefined> = {
        "doc-e": undefined,
        "doc-a": "2026-01-01T00:00:00Z",
        "doc-b": "2026-06-14T00:00:00Z",
        "doc-c": "2026-06-10T00:00:00Z",
        "doc-d": "2026-05-16T00:00:00Z",
      };
      for (const id of ["doc-e", "doc-a", "doc-b", "doc-c", "doc-d"]) {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            doc_id: id,
            cid: "",
            content_type: "text/plain",
            size_bytes: 1,
            chunks: 1,
            vectors: 1,
            version: 1,
            created_at: records[id],
          }),
        );
      }

      const mem = newMemory("patient-john", { halfLifeDays: 30, now });
      const items = await mem.recall("calm", { k: 5, recencyWeight: 0.5 });

      // 1 retrieve + 5 get = 6 calls
      expect(mockFetch).toHaveBeenCalledTimes(6);
      // Canonical asserted order.
      expect(items.map((i) => i.id)).toEqual([
        "doc-b",
        "doc-c",
        "doc-d",
        "doc-e",
        "doc-a",
      ]);
      // Canonical blended scores (assert within 1e-6 of the §8.1 values).
      const within1e6 = (actual: number | undefined, expected: number) =>
        expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(1e-6);
      within1e6(items[0].score, 0.905246); // doc-b
      within1e6(items[1].score, 0.830065); // doc-c
      within1e6(items[2].score, 0.607143); // doc-d
      within1e6(items[3].score, 0.47619); // doc-e (null ts -> recency 0)
      within1e6(items[4].score, 0.465594); // doc-a (165 days old)
      // created_at populated in recency mode; null for doc-e.
      expect(items[0].createdAt).toBe("2026-06-14T00:00:00Z");
      expect(items[3].createdAt).toBeUndefined();
    });

    it("returns top-k after the re-rank", async () => {
      const now = () => new Date("2026-06-15T00:00:00Z");
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([
          { doc_id: "doc-a", distance: 0.1, content: "A" },
          { doc_id: "doc-b", distance: 0.5, content: "B" },
          { doc_id: "doc-c", distance: 0.25, content: "C" },
        ]),
      );
      const nowMs = Date.parse("2026-06-15T00:00:00Z");
      const DAY = 86_400_000;
      const recs: Record<string, string> = {
        "doc-a": new Date(nowMs - 90 * DAY).toISOString(),
        "doc-b": new Date(nowMs).toISOString(),
        "doc-c": new Date(nowMs - 30 * DAY).toISOString(),
      };
      for (const id of ["doc-a", "doc-b", "doc-c"]) {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            doc_id: id,
            cid: "",
            content_type: "text/plain",
            size_bytes: 1,
            chunks: 1,
            vectors: 1,
            version: 1,
            created_at: recs[id],
          }),
        );
      }
      const mem = newMemory("patient-john", { halfLifeDays: 30, now });
      const items = await mem.recall("calm", { k: 1, recencyWeight: 0.5 });
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("doc-b");
    });

    it("clamps recencyWeight above 1 to a pure-recency blend (still N+1)", async () => {
      const now = () => new Date("2026-06-15T00:00:00Z");
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([
          { doc_id: "doc-old", distance: 0.1, content: "old" },
          { doc_id: "doc-new", distance: 0.9, content: "new" },
        ]),
      );
      const nowMs = Date.parse("2026-06-15T00:00:00Z");
      const DAY = 86_400_000;
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-old",
          cid: "",
          content_type: "text/plain",
          size_bytes: 1,
          chunks: 1,
          vectors: 1,
          version: 1,
          created_at: new Date(nowMs - 365 * DAY).toISOString(),
        }),
      );
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-new",
          cid: "",
          content_type: "text/plain",
          size_bytes: 1,
          chunks: 1,
          vectors: 1,
          version: 1,
          created_at: new Date(nowMs).toISOString(),
        }),
      );
      const mem = newMemory("patient-john", { halfLifeDays: 30, now });
      // recencyWeight=5 clamps to 1 -> pure recency -> newest first.
      const items = await mem.recall("q", { k: 2, recencyWeight: 5 });
      expect(items.map((i) => i.id)).toEqual(["doc-new", "doc-old"]);
    });
  });

  // ── §8.6 list ───────────────────────────────────────────────────────
  describe("list (§8.6)", () => {
    it("returns newest-first items with text downloaded per record", async () => {
      // 1 listing call (server returns created_at-descending) ...
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          documents: [
            {
              doc_id: "newest",
              cid: "",
              content_type: "text/plain",
              size_bytes: 5,
              version: 1,
              created_at: "2026-06-15T00:00:00Z",
              entity_id: "patient-john",
            },
            {
              doc_id: "older",
              cid: "",
              content_type: "text/plain",
              size_bytes: 5,
              version: 1,
              created_at: "2026-06-01T00:00:00Z",
              entity_id: "patient-john",
            },
          ],
          count: 2,
          total: 2,
          has_more: false,
        }),
      );
      // ... then one download per item.
      mockFetch.mockResolvedValueOnce(binaryResponse("newest text"));
      mockFetch.mockResolvedValueOnce(binaryResponse("older text"));

      const mem = newMemory("patient-john");
      const items = await mem.list({ limit: 50 });

      // 1 + N calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
      const { url } = call(0);
      expect(url).toContain("entity_id=patient-john");
      expect(url).toContain("limit=50");

      expect(items.map((i) => i.id)).toEqual(["newest", "older"]);
      expect(items[0].text).toBe("newest text");
      expect(items[1].text).toBe("older text");
      expect(items[0].createdAt).toBe("2026-06-15T00:00:00Z");
      expect(items[0].entityId).toBe("patient-john");
      expect(items[0].score).toBeUndefined();
    });
  });

  // ── §8.7 forget / forget_all ────────────────────────────────────────
  describe("forget / forgetAll (§8.7)", () => {
    it("forget issues one DELETE", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "tombstoned", doc_id: "doc-1" }),
      );
      const mem = newMemory("patient-john");
      await mem.forget("doc-1");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const { url, init } = call(0);
      expect(url).toContain("/v1/documents/doc-1");
      expect(init.method).toBe("DELETE");
    });

    it("forget rejects an empty id with a client-side error", async () => {
      const mem = newMemory();
      await expect(mem.forget("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("forgetAll deletes every listed id and returns the count", async () => {
      // First page: 2 docs.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          documents: [
            { doc_id: "d1", cid: "", content_type: "text/plain", size_bytes: 1, version: 1 },
            { doc_id: "d2", cid: "", content_type: "text/plain", size_bytes: 1, version: 1 },
          ],
          count: 2,
          total: 2,
          has_more: false,
        }),
      );
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "tombstoned", doc_id: "d1" }));
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "tombstoned", doc_id: "d2" }));
      // Second listing (after tombstones): empty -> loop terminates.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ documents: [], count: 0, total: 0, has_more: false }),
      );

      const mem = newMemory("patient-john");
      const count = await mem.forgetAll();
      expect(count).toBe(2);

      // listing scoped to the entity, with limit=1000
      const { url } = call(0);
      expect(url).toContain("entity_id=patient-john");
      expect(url).toContain("limit=1000");

      // two DELETEs were issued
      const methods = mockFetch.mock.calls.map((c) => (c[1] as RequestInit)?.method);
      expect(methods.filter((m) => m === "DELETE")).toHaveLength(2);
    });
  });

  // ── §8.8 error passthrough ──────────────────────────────────────────
  describe("error passthrough (§8.8)", () => {
    it("surfaces the same typed error the raw client raises (402 credit_exhausted)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { error: "Prepaid credit exhausted", code: "credit_exhausted" },
          402,
        ),
      );
      const mem = newMemory("patient-john");
      await expect(mem.remember("text")).rejects.toThrow(CreditExhaustedError);
    });

    it("surfaces a base AetherApiError for an unrecognized status (recall)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "boom", code: "embedding_error" }, 500),
      );
      const mem = newMemory("patient-john");
      await expect(mem.recall("q")).rejects.toThrow(AetherApiError);
    });
  });

  // ── §8.9 invalid construction ───────────────────────────────────────
  describe("invalid construction (§8.9)", () => {
    it("rejects an empty entity_id", () => {
      expect(() => new Memory("")).toThrow(AetherError);
    });

    it("rejects a whitespace-only entity_id", () => {
      expect(() => new Memory("   ")).toThrow(AetherError);
      expect(() => new Memory("\t\n")).toThrow(AetherError);
    });

    it("rejects an oversized entity_id (> 256 chars)", () => {
      expect(() => new Memory("x".repeat(257))).toThrow(AetherError);
    });

    it("accepts a 256-char entity_id (boundary)", () => {
      expect(() => new Memory("x".repeat(256))).not.toThrow();
    });
  });

  // ── extract_facts reserved no-op ────────────────────────────────────
  describe("extractFacts reserved no-op", () => {
    it("stores a single memory regardless of the flag (one HTTP call)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-1",
          cid: "",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
          created_at: "2026-06-15T00:00:00Z",
        }),
      );
      const mem = newMemory("patient-john", { extractFacts: true });
      const item = await mem.remember("fact one. fact two. fact three.");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(item.text).toBe("fact one. fact two. fact three.");
    });
  });

  // ── Partition composition ──────────────────────────────────
  // Memory delegates to the raw client, so building a Memory on a partition
  // handle scopes every operation to BOTH partition and entity — without any
  // change to the Memory constructor or its public surface.
  describe("partition composition", () => {
    it("remember on a partition-scoped client sends both partition and entity_id", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          doc_id: "doc-1",
          cid: "",
          content_type: "text/plain",
          size_bytes: 10,
          chunks: 1,
          vectors: 1,
          version: 1,
          created_at: "2026-06-15T00:00:00Z",
        }),
      );
      const client = new AetherClient({
        baseUrl: "http://localhost:9000",
        apiKey: "aether_testkey123",
        maxRetries: 0,
      });
      const mem = new Memory("patient-john", { client: client.partition("tenant-x") });
      await mem.remember("hello");
      const { url } = call(0);
      expect(url).toContain("partition=tenant-x");
      expect(url).toContain("entity_id=patient-john");
    });

    it("recall on a partition-scoped client sends both partition and entity_id", async () => {
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([{ doc_id: "d", distance: 0.2, content: "x" }]),
      );
      const client = new AetherClient({
        baseUrl: "http://localhost:9000",
        apiKey: "aether_testkey123",
        maxRetries: 0,
      });
      const mem = new Memory("patient-john", { client: client.partition("tenant-x") });
      await mem.recall("anxiety");
      const { url } = call(0);
      expect(url).toContain("/v1/search?");
      expect(url).toContain("partition=tenant-x");
      expect(url).toContain("entity_id=patient-john");
    });
  });
});

// ── Part II — memory graph (MEMORY_CONTRACT.md §14) ────

function entityWire(over: Record<string, unknown> = {}) {
  return {
    memory_entity_id: "ent-1",
    entity_id: "patient-john",
    partition: null,
    entity_type: "person",
    display_name: "John",
    aliases: [],
    attributes: {},
    created_at: "2026-06-15T00:00:00Z",
    updated_at: "2026-06-15T00:00:00Z",
    ...over,
  };
}
function relationshipWire(over: Record<string, unknown> = {}) {
  return {
    relationship_id: "rel-1",
    entity_id: "patient-john",
    partition: null,
    from_entity_id: "ent-1",
    to_entity_id: "ent-2",
    relationship_type: "works_at",
    attributes: {},
    valid_from: null,
    observed_at: "2026-06-15T00:00:00Z",
    invalid_from: null,
    created_at: "2026-06-15T00:00:00Z",
    updated_at: "2026-06-15T00:00:00Z",
    ...over,
  };
}
function factWire(over: Record<string, unknown> = {}) {
  return {
    fact_id: "fact-1",
    entity_id: "patient-john",
    partition: null,
    subject_type: "owner",
    subject_id: null,
    predicate: "favorite_color",
    value: "blue",
    cardinality: "single",
    valid_from: null,
    observed_at: "2026-06-15T00:00:00Z",
    invalid_from: null,
    supersedes_fact_id: null,
    created_at: "2026-06-15T00:00:00Z",
    updated_at: "2026-06-15T00:00:00Z",
    ...over,
  };
}
function bodyOf(n: number): Record<string, unknown> {
  const { init } = call(n);
  return JSON.parse(init.body as string);
}

describe("Memory graph (Part II)", () => {
  describe("entities", () => {
    it("upsertEntity round-trips (POST, entity_id param, parsed result)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(entityWire({ memory_entity_id: "ent-9" }), 201),
      );
      const mem = newMemory("patient-john");
      const ent = await mem.upsertEntity("person", {
        displayName: "John",
        attributes: { age: 30, vip: true },
      });
      const { url, init } = call(0);
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/memory/entities");
      expect(url).toContain("entity_id=patient-john");
      const body = bodyOf(0);
      expect(body.entity_type).toBe("person");
      expect(body.display_name).toBe("John");
      expect(body.attributes).toEqual({ age: 30, vip: true });
      expect(body.memory_entity_id).toBeUndefined();
      expect(ent.memoryEntityId).toBe("ent-9");
      expect(ent.entityId).toBe("patient-john");
    });

    it("upsertEntity sends a supplied id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(entityWire(), 201));
      const mem = newMemory("patient-john");
      await mem.upsertEntity("person", { memoryEntityId: "ent-fixed" });
      expect(bodyOf(0).memory_entity_id).toBe("ent-fixed");
    });

    it("getEntity fetches by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(entityWire()));
      const mem = newMemory("patient-john");
      const ent = await mem.getEntity("ent-1");
      const { url, init } = call(0);
      expect(init.method).toBe("GET");
      expect(url).toContain("/v1/memory/entities/ent-1");
      expect(url).toContain("entity_id=patient-john");
      expect(ent.memoryEntityId).toBe("ent-1");
    });

    it("listEntities sends provided filters and omits unset", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ entities: [entityWire(), entityWire({ memory_entity_id: "ent-2" })], count: 2 }),
      );
      const mem = newMemory("patient-john");
      const ents = await mem.listEntities({ entityType: "person", limit: 10 });
      const { url } = call(0);
      expect(url).toContain("entity_type=person");
      expect(url).toContain("limit=10");
      expect(ents).toHaveLength(2);
    });
  });

  describe("scoping + partition", () => {
    it("graph call carries entity_id and partition", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(entityWire(), 201));
      const client = new AetherClient({
        baseUrl: "http://localhost:9000",
        apiKey: "k",
        maxRetries: 0,
      });
      const mem = new Memory("patient-john", { client: client.partition("tenant-x") });
      await mem.upsertEntity("person");
      const { url } = call(0);
      expect(url).toContain("entity_id=patient-john");
      expect(url).toContain("partition=tenant-x");
    });

    it("unscoped graph call omits partition", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(entityWire(), 201));
      const mem = newMemory("patient-john");
      await mem.upsertEntity("person");
      expect(call(0).url).not.toContain("partition=");
    });
  });

  describe("relationships", () => {
    it("relate posts from/to/type + valid_from", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(relationshipWire({ relationship_id: "rel-9" }), 201),
      );
      const mem = newMemory("patient-john");
      const rel = await mem.relate("ent-1", "ent-2", "works_at", {
        validFrom: "2026-01-01T00:00:00Z",
      });
      const body = bodyOf(0);
      expect(body.from_entity_id).toBe("ent-1");
      expect(body.to_entity_id).toBe("ent-2");
      expect(body.relationship_type).toBe("works_at");
      expect(body.valid_from).toBe("2026-01-01T00:00:00Z");
      expect(rel.relationshipId).toBe("rel-9");
      expect(rel.fromEntityId).toBe("ent-1");
    });

    it("listRelationships sends include_inactive and as_of when set", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ relationships: [relationshipWire()], count: 1 }),
      );
      const mem = newMemory("patient-john");
      await mem.listRelationships({
        includeInactive: true,
        asOf: "2026-06-01T00:00:00Z",
        fromEntityId: "ent-1",
      });
      const { url } = call(0);
      expect(url).toContain("include_inactive=true");
      expect(url).toContain("as_of=2026-06-01");
      expect(url).toContain("from_entity_id=ent-1");
    });

    it("listRelationships default omits include_inactive", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ relationships: [], count: 0 }));
      const mem = newMemory("patient-john");
      await mem.listRelationships();
      expect(call(0).url).not.toContain("include_inactive");
    });
  });

  describe("facts", () => {
    it("rememberFact defaults to owner subject", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(factWire(), 201));
      const mem = newMemory("patient-john");
      const fact = await mem.rememberFact("favorite_color", "blue");
      const body = bodyOf(0);
      expect(body.subject_type).toBe("owner");
      expect(body.subject_id).toBeUndefined();
      expect(body.predicate).toBe("favorite_color");
      expect(body.value).toBe("blue");
      expect(fact.factId).toBe("fact-1");
    });

    it("rememberFact with entity subject sends subject_id", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(factWire({ subject_type: "entity", subject_id: "ent-1" }), 201),
      );
      const mem = newMemory("patient-john");
      await mem.rememberFact("role", "engineer", {
        subjectType: "entity",
        subjectId: "ent-1",
      });
      const body = bodyOf(0);
      expect(body.subject_type).toBe("entity");
      expect(body.subject_id).toBe("ent-1");
    });

    it("rememberFact sends scalar value types including null", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(factWire({ value: 7 }), 201))
        .mockResolvedValueOnce(jsonResponse(factWire({ value: null }), 201));
      const mem = newMemory("patient-john");
      await mem.rememberFact("count", 7);
      expect(bodyOf(0).value).toBe(7);
      await mem.rememberFact("nickname", null);
      expect(bodyOf(1).value).toBeNull();
    });

    it("entity subject without subjectId throws before any HTTP", async () => {
      const mem = newMemory("patient-john");
      await expect(
        mem.rememberFact("role", "x", { subjectType: "entity" }),
      ).rejects.toBeInstanceOf(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("listFacts sends subject + predicate filters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ facts: [factWire()], count: 1 }));
      const mem = newMemory("patient-john");
      await mem.listFacts({
        subjectType: "entity",
        subjectId: "ent-1",
        predicate: "role",
        includeInactive: true,
      });
      const { url } = call(0);
      expect(url).toContain("subject_type=entity");
      expect(url).toContain("subject_id=ent-1");
      expect(url).toContain("predicate=role");
      expect(url).toContain("include_inactive=true");
      expect(url).not.toContain("history=");
    });

    it("factHistory sends history=true with subject + predicate", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          facts: [factWire({ invalid_from: "2026-06-10T00:00:00Z" }), factWire({ fact_id: "fact-2" })],
          count: 2,
        }),
      );
      const mem = newMemory("patient-john");
      const facts = await mem.factHistory("favorite_color", {
        subjectType: "entity",
        subjectId: "ent-1",
      });
      const { url } = call(0);
      expect(url).toContain("history=true");
      expect(url).toContain("subject_type=entity");
      expect(url).toContain("subject_id=ent-1");
      expect(url).toContain("predicate=favorite_color");
      expect(facts).toHaveLength(2);
    });
  });

  describe("consolidate", () => {
    it("posts and parses the report", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ active_facts_before: 5, active_facts_after: 3, retracted: 2 }),
      );
      const mem = newMemory("patient-john");
      const report = await mem.consolidate();
      const { url, init } = call(0);
      expect(init.method).toBe("POST");
      expect(url).toContain("/v1/memory/consolidate");
      expect(url).toContain("entity_id=patient-john");
      expect(report.activeFactsBefore).toBe(5);
      expect(report.activeFactsAfter).toBe(3);
      expect(report.retracted).toBe(2);
    });
  });

  describe("validation (no HTTP)", () => {
    it("empty entityType throws", async () => {
      const mem = newMemory("patient-john");
      await expect(mem.upsertEntity("  ")).rejects.toBeInstanceOf(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
    it("empty predicate throws", async () => {
      const mem = newMemory("patient-john");
      await expect(mem.rememberFact("", "x")).rejects.toBeInstanceOf(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
    it("bad subjectType throws", async () => {
      const mem = newMemory("patient-john");
      await expect(
        // @ts-expect-error deliberately invalid subjectType
        mem.rememberFact("p", "x", { subjectType: "bogus" }),
      ).rejects.toBeInstanceOf(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
    it("empty relate args throw", async () => {
      const mem = newMemory("patient-john");
      await expect(mem.relate("", "ent-2", "works_at")).rejects.toBeInstanceOf(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
    it("empty getEntity id throws", async () => {
      const mem = newMemory("patient-john");
      await expect(mem.getEntity("")).rejects.toBeInstanceOf(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("error passthrough", () => {
    it("402 surfaces the typed raw-client error", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "credits exhausted", code: "credit_exhausted" }, 402),
      );
      const mem = newMemory("patient-john");
      await expect(mem.upsertEntity("person")).rejects.toBeInstanceOf(
        CreditExhaustedError,
      );
    });
  });
});
