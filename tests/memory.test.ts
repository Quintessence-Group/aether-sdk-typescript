import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { Memory, Thread } from "../src/memory.js";
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
  results: Array<{ doc_id: string; score: number; content: string }>,
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
        retrieveResponse([{ doc_id: "d", score: 80, content: "x" }]),
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
          { doc_id: "first", score: 90, content: "A" },
          { doc_id: "second", score: 60, content: "B" },
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
      // similarity = score/100
      expect(items[0].score).toBeCloseTo(0.9, 10);
      expect(items[1].score).toBeCloseTo(0.6, 10);
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

      // retrieve returns candidates in server order (descending score).
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([
          { doc_id: "doc-e", score: 95, content: "E" }, // best score, null ts
          { doc_id: "doc-a", score: 90, content: "A" }, // 165 days old
          { doc_id: "doc-b", score: 80, content: "B" }, // 1 day (freshest)
          { doc_id: "doc-c", score: 70, content: "C" }, // 5 days
          { doc_id: "doc-d", score: 60, content: "D" }, // 30 days = 1 half-life
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
      within1e6(items[0].score, 0.888580); // doc-b
      within1e6(items[1].score, 0.795449); // doc-c
      within1e6(items[2].score, 0.550000); // doc-d
      within1e6(items[3].score, 0.475000); // doc-e (null ts -> recency 0)
      within1e6(items[4].score, 0.461049); // doc-a (165 days old)
      // created_at populated in recency mode; null for doc-e.
      expect(items[0].createdAt).toBe("2026-06-14T00:00:00Z");
      expect(items[3].createdAt).toBeUndefined();
    });

    it("returns top-k after the re-rank", async () => {
      const now = () => new Date("2026-06-15T00:00:00Z");
      mockFetch.mockResolvedValueOnce(
        retrieveResponse([
          { doc_id: "doc-a", score: 90, content: "A" },
          { doc_id: "doc-b", score: 50, content: "B" },
          { doc_id: "doc-c", score: 75, content: "C" },
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
          { doc_id: "doc-old", score: 90, content: "old" },
          { doc_id: "doc-new", score: 10, content: "new" },
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

  // ── extractFacts constructor default + per-call override ──────────
  describe("extractFacts default + per-call override", () => {
    function insertResponse() {
      return jsonResponse({
        doc_id: "doc-1",
        cid: "",
        content_type: "text/plain",
        size_bytes: 10,
        chunks: 1,
        vectors: 1,
        version: 1,
        created_at: "2026-06-15T00:00:00Z",
      });
    }

    it("constructor flag makes remember request extraction by default (one HTTP call)", async () => {
      mockFetch.mockResolvedValueOnce(insertResponse());
      const mem = newMemory("patient-john", { extractFacts: true });
      const item = await mem.remember("fact one. fact two. fact three.");
      expect(mockFetch).toHaveBeenCalledTimes(1); // fan-out happens server-side
      expect(call(0).url).toContain("extract_facts=true");
      expect(item.text).toBe("fact one. fact two. fact three.");
    });

    it("per-call extract: false overrides the constructor default", async () => {
      mockFetch.mockResolvedValueOnce(insertResponse());
      const mem = newMemory("patient-john", { extractFacts: true });
      await mem.remember("fact one.", undefined, { extract: false });
      expect(call(0).url).not.toContain("extract_facts");
    });

    it("per-call extract: true overrides the default-off constructor", async () => {
      mockFetch.mockResolvedValueOnce(insertResponse());
      const mem = newMemory("patient-john");
      await mem.remember("fact one.", undefined, { extract: true });
      expect(call(0).url).toContain("extract_facts=true");
    });

    it("default-off sends no extract_facts param", async () => {
      mockFetch.mockResolvedValueOnce(insertResponse());
      const mem = newMemory("patient-john");
      await mem.remember("fact one.");
      expect(call(0).url).not.toContain("extract_facts");
    });
  });

  describe("multimodal memory", () => {
    function mediaResponse(modality: "image" | "audio", text: string) {
      return jsonResponse({
        doc_id: "media-1",
        cid: "cid-media",
        modality,
        content_type: modality === "image" ? "image/png" : "audio/wav",
        derived_text: text,
        derived_by: "client",
        created_at: "2026-06-15T00:00:00Z",
        entity_id: "patient-john",
        partition: null,
        metadata: { "aether.media.modality": modality },
      }, 201);
    }

    it("uses the remember overload for image bytes", async () => {
      mockFetch.mockResolvedValueOnce(mediaResponse("image", "A red bicycle."));
      const mem = newMemory("patient-john");
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      const item = await mem.remember({
        image: bytes,
        caption: "A red bicycle.",
        metadata: { album: "commute" },
      });

      expect(item.modality).toBe("image");
      expect(item.text).toBe("A red bicycle.");
      const { url, init } = call(0);
      expect(url).toContain("/v1/memory/media?entity_id=patient-john");
      const body = JSON.parse(init.body as string);
      expect(body.modality).toBe("image");
      expect(body.content_type).toBe("image/png");
      expect(body.caption).toBe("A red bicycle.");
      expect(Buffer.from(body.data_base64, "base64")).toEqual(Buffer.from(bytes));
    });

    it("uses the media passage for recall instead of downloading binary bytes", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        query: "bicycle",
        results: [{
          doc_id: "media-1",
          score: 96,
          content_type: "image/png",
          passage: "A red bicycle.",
          modality: "image",
        }],
      }));
      const mem = newMemory("patient-john");

      const items = await mem.recall("bicycle");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(items[0].text).toBe("A red bicycle.");
      expect(items[0].modality).toBe("image");
    });

    it("uses media metadata when an older search omits the passage", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({
          query: "bicycle",
          results: [{
            doc_id: "media-1",
            score: 96,
            content_type: "image/png",
            modality: "image",
          }],
        }))
        .mockResolvedValueOnce(jsonResponse({
          doc_id: "media-1",
          cid: "cid-media",
          content_type: "image/png",
          size_bytes: 100,
          chunks: 1,
          vectors: 1,
          version: 1,
          modality: "image",
          derived_text: "A red bicycle.",
        }));
      const mem = newMemory("patient-john");

      const items = await mem.recall("bicycle");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(call(1).url).toContain("/v1/documents/media-1");
      expect(call(1).url).not.toContain("/download");
      expect(items[0].text).toBe("A red bicycle.");
    });

    it("uses authorized derived_text for list without a binary download", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        documents: [{
          doc_id: "media-1",
          cid: "cid-media",
          content_type: "audio/wav",
          modality: "audio",
          derived_text: "Session transcript.",
          entity_id: "patient-john",
        }],
        total: 1,
        has_more: false,
      }));
      const mem = newMemory("patient-john");

      const items = await mem.list();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(items[0].text).toBe("Session transcript.");
      expect(items[0].modality).toBe("audio");
    });

    it("requires one media input and a transcript when auto-transcription is off", async () => {
      const mem = newMemory("patient-john");
      await expect(mem.remember({})).rejects.toThrow("exactly one");
      await expect(mem.remember({ image: new Uint8Array([1]), audio: new Uint8Array([2]) }))
        .rejects.toThrow("exactly one");
      await expect(mem.remember({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        transcribe: false,
      })).rejects.toThrow("explicit transcript");
      expect(mockFetch).not.toHaveBeenCalled();
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
        retrieveResponse([{ doc_id: "d", score: 80, content: "x" }]),
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

describe("Thread", () => {
  it("appends through the raw thread route with the Memory entity scope", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      doc_id: "turn-1",
      cid: "",
      content_type: "text/plain",
      size_bytes: 12,
      chunks: 1,
      vectors: 1,
      version: 1,
      created_at: "2026-07-10T00:00:00Z",
      entity_id: "patient-john",
      thread_id: "session-4",
      turn_index: 0,
      metadata: { role: "patient" },
    }));
    const thread = newMemory().thread("session-4");
    const item = await thread.append("I slept better", { role: "patient" });

    expect(item.id).toBe("turn-1");
    expect(item.entityId).toBe("patient-john");
    const { url, init } = call(0);
    expect(url).toContain("/v1/threads/session-4/append");
    expect(JSON.parse(init.body as string)).toMatchObject({
      text: "I slept better",
      entity_id: "patient-john",
      metadata: { role: "patient" },
    });
  });

  it("composes bounded recent turns plus de-duplicated semantic matches", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        thread_id: "session-4",
        documents: [
          {
            doc_id: "recent-1",
            cid: "",
            content_type: "text/plain",
            size_bytes: 1,
            chunks: 1,
            vectors: 1,
            version: 1,
            created_at: "2026-07-09T00:00:00Z",
            entity_id: "patient-john",
            thread_id: "session-4",
            turn_index: 7,
            metadata: { role: "therapist" },
          },
          {
            doc_id: "recent-2",
            cid: "",
            content_type: "text/plain",
            size_bytes: 1,
            chunks: 1,
            vectors: 1,
            version: 1,
            created_at: "2026-07-10T00:00:00Z",
            entity_id: "patient-john",
            thread_id: "session-4",
            turn_index: 8,
            metadata: { role: "patient" },
          },
        ],
      }))
      .mockResolvedValueOnce(retrieveResponse([
        { doc_id: "recent-2", score: 97, content: "duplicate semantic turn" },
        { doc_id: "older-match", score: 82, content: "Earlier grounding exercise" },
      ]))
      .mockResolvedValueOnce(binaryResponse("How did the exercise go?"))
      .mockResolvedValueOnce(binaryResponse("It helped before sleep."));

    const thread = new Thread(newMemory(), "session-4");
    const items = await thread.context("what helped with sleep?", 2, true);

    expect(items.map((item) => item.id)).toEqual([
      "recent-1",
      "recent-2",
      "older-match",
    ]);
    expect(items.map((item) => item.text)).toEqual([
      "How did the exercise go?",
      "It helped before sleep.",
      "Earlier grounding exercise",
    ]);
    expect(items[2].score).toBeCloseTo(0.82);
    expect(call(0).url).toContain("last_n_turns=2");
    expect(call(0).url).toContain("recent_first=true");
    expect(call(1).url).toContain("thread_id=session-4");
    expect(call(1).url).toContain("entity_id=patient-john");
    expect(call(1).url).toContain("k=5");
  });

  it("retries a committed turn while its origin projection is pending", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        thread_id: "session-4",
        documents: [{
          doc_id: "pending-1",
          cid: "",
          content_type: "text/plain",
          size_bytes: 14,
          chunks: 0,
          vectors: 0,
          version: 1,
          entity_id: "patient-john",
          thread_id: "session-4",
          turn_index: 0,
        }],
      }))
      .mockResolvedValueOnce(retrieveResponse([]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "Thread turn is committed but its origin projection is still pending",
        code: "thread_projection_pending",
      }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "0" },
      }))
      .mockResolvedValueOnce(binaryResponse("projected turn"));
    const client = new AetherClient({
      baseUrl: "http://localhost:9000",
      apiKey: "aether_testkey123",
      maxRetries: 1,
      retryBaseDelay: 0,
    });

    const items = await new Thread(
      new Memory("patient-john", { client }),
      "session-4",
    ).context("history");

    expect(items.map((item) => item.text)).toEqual(["projected turn"]);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(call(2).url).toContain("/documents/pending-1/download");
    expect(call(3).url).toContain("/documents/pending-1/download");
  });

  it("bounds concurrent thread context downloads", async () => {
    let activeDownloads = 0;
    let peakDownloads = 0;
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/threads/session-4")) {
        return jsonResponse({
          thread_id: "session-4",
          documents: Array.from({ length: 17 }, (_, index) => ({
            doc_id: `turn-${index}`,
            entity_id: "patient-john",
            thread_id: "session-4",
            turn_index: index,
          })),
        });
      }
      if (url.includes("/search")) return retrieveResponse([]);
      if (url.includes("/download")) {
        activeDownloads += 1;
        peakDownloads = Math.max(peakDownloads, activeDownloads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeDownloads -= 1;
        return binaryResponse("turn text");
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const items = await new Thread(newMemory(), "session-4").context("history", 17);

    expect(items).toHaveLength(17);
    expect(peakDownloads).toBe(8);
  });

  it("stops before the next batch when the context byte budget is exceeded", async () => {
    const largeTurn = "x".repeat(2 * 1024 * 1024 + 1);
    let downloadCalls = 0;
    mockFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/threads/session-4")) {
        return jsonResponse({
          thread_id: "session-4",
          documents: Array.from({ length: 9 }, (_, index) => ({
            doc_id: `turn-${index}`,
            entity_id: "patient-john",
            thread_id: "session-4",
            turn_index: index,
          })),
        });
      }
      if (url.includes("/search")) return retrieveResponse([]);
      if (url.includes("/download")) {
        downloadCalls += 1;
        return binaryResponse(largeTurn);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(
      new Thread(newMemory(), "session-4").context("history", 9),
    ).rejects.toThrow(/byte safety limit/);

    expect(downloadCalls).toBe(8);
    expect(mockFetch.mock.calls.some(([url]) =>
      String(url).includes("/documents/turn-8/download")
    )).toBe(false);
  });

  it("validates helper inputs before any HTTP call", async () => {
    const memory = newMemory();
    expect(() => new Thread(memory, " ")).toThrow(AetherError);
    const thread = memory.thread("session-4");
    expect(() => memory.thread("safe\u0000id")).toThrow(/control/);
    expect(() => new Thread(memory, "safe\uD800")).toThrow(/surrogate/);
    expect(() => memory.thread("\uDC00safe")).toThrow(/surrogate/);
    expect(() => memory.thread("😀".repeat(256))).not.toThrow();
    expect(() => memory.thread("😀".repeat(257))).toThrow(/256/);
    await expect(thread.append(" ")).rejects.toThrow(AetherError);
    await expect(thread.context(" ")).rejects.toThrow(AetherError);
    await expect(thread.context("query", 0)).rejects.toThrow(AetherError);
    await expect(thread.context("query", 1001)).rejects.toThrow(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── Part II — memory graph (MEMORY_CONTRACT.md §14) ─────────────────────

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
