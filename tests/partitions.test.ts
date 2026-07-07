import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { AetherApiError, AetherError, PartitionRequiredError } from "../src/errors.js";

// Partition lifecycle (listPartitions / deletePartition), the partition guard
// on ID-addressed routes, moveDocument, the partition echo on responses,
// provable isolation (searchTrace / verifyIsolation), and the typed
// partition_required error — all driven through a real client over a mocked
// `fetch` so the genuine request-building / parse / error-mapping path runs.

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

function newClient(): AetherClient {
  return new AetherClient({ baseUrl: "http://localhost:9000", apiKey: "test-key" });
}

describe("partitions", () => {
  // ── listPartitions ────────────────────────────────────────────────

  describe("listPartitions", () => {
    it("parses counts (snake_case → camelCase) and warnings", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          partitions: [
            { id: "client-a", document_count: 3 },
            { id: "client-b", document_count: 1 },
          ],
          count: 2,
          warnings: [
            {
              kind: "single_document",
              partitions: ["client-b"],
              detail: "holds a single document",
            },
          ],
        }),
      );

      const listing = await newClient().listPartitions();

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/partitions");
      expect(init.method ?? "GET").toBe("GET");

      expect(listing.partitions.map((p) => p.id)).toEqual(["client-a", "client-b"]);
      expect(listing.partitions[0].documentCount).toBe(3);
      expect(listing.partitions[1].documentCount).toBe(1);
      expect(listing.warnings[0].kind).toBe("single_document");
      expect(listing.warnings[0].partitions).toEqual(["client-b"]);
      expect(listing.warnings[0].detail).toBe("holds a single document");
    });

    it("tolerates a response with no warnings", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ partitions: [{ id: "client-a", document_count: 5 }], count: 1 }),
      );
      const listing = await newClient().listPartitions();
      expect(listing.warnings).toEqual([]);
      expect(listing.partitions[0].documentCount).toBe(5);
    });

    it("does NOT send a partition query param (tenant-level, ignores any handle)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ partitions: [], warnings: [] }));
      await newClient().partition("client-a").listPartitions();
      const [url] = mockFetch.mock.calls[0];
      // Tenant-level call: the path is /partitions but no `partition=` scope is appended.
      expect(url).toBe("http://localhost:9000/v1/partitions");
      expect(url).not.toContain("partition=");
    });
  });

  // ── deletePartition ───────────────────────────────────────────────

  describe("deletePartition", () => {
    it("returns documents_deleted and encodes the path (slashes included)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "deleted", partition: "client/42", documents_deleted: 7 }),
      );

      const count = await newClient().deletePartition("client/42");

      const [url, init] = mockFetch.mock.calls[0];
      // The id is URL-encoded into the path segment (slash → %2F).
      expect(url).toBe("http://localhost:9000/v1/partitions/client%2F42");
      expect(init.method).toBe("DELETE");
      expect(count).toBe(7);
    });

    it("returns 0 for an unknown/empty partition (idempotent)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ status: "deleted", documents_deleted: 0 }),
      );
      expect(await newClient().deletePartition("ghost")).toBe(0);
    });

    it("rejects an empty id with no HTTP call", async () => {
      await expect(newClient().deletePartition("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects a whitespace-only id with no HTTP call", async () => {
      await expect(newClient().deletePartition("   ")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects an id longer than 256 characters with no HTTP call", async () => {
      await expect(newClient().deletePartition("a".repeat(257))).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── partition guard on ID-addressed routes ────────────────────────

  describe("partition handle guards ID-addressed routes", () => {
    const record = {
      doc_id: "d1",
      cid: "c1",
      content_type: "text/plain",
      size_bytes: 1,
      chunks: 1,
      vectors: 1,
      version: 1,
    };

    it("get injects the handle partition as a query param", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(record));
      await newClient().partition("client-a").get("d1");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/documents/d1?partition=client-a");
    });

    it("get stays unguarded on an unscoped client", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(record));
      await newClient().get("d1");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/documents/d1");
    });

    it("download and downloadText inject the handle partition", async () => {
      // A fresh Response per call — a body can only be read once.
      mockFetch.mockImplementation(async () => new Response("hello", { status: 200 }));
      const scoped = newClient().partition("client-a");
      await scoped.download("d1");
      expect(await scoped.downloadText("d1")).toBe("hello");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [url] of mockFetch.mock.calls) {
        expect(url).toBe(
          "http://localhost:9000/v1/documents/d1/download?partition=client-a",
        );
      }
    });

    it("soft delete injects the handle partition", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "deleted" }));
      await newClient().partition("client-a").delete("d1");
      const [url, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe("DELETE");
      expect(url).toBe("http://localhost:9000/v1/documents/d1?partition=client-a");
    });

    it("hard delete keeps hard=true alongside the partition guard", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "deleted" }));
      await newClient().partition("client-a").delete("d1", { hard: true });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "http://localhost:9000/v1/documents/d1?hard=true&partition=client-a",
      );
    });

    it("restore injects the handle partition", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "restored" }));
      await newClient().partition("client-a").restore("d1");
      const [url, init] = mockFetch.mock.calls[0];
      expect(init.method).toBe("POST");
      expect(url).toBe(
        "http://localhost:9000/v1/documents/d1/restore?partition=client-a",
      );
    });

    it("backfillEntityFromTags constrains the scan to the handle partition", async () => {
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
      await newClient().partition("client-a").backfillEntityFromTags("patient:");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "http://localhost:9000/v1/documents/backfill-entity?partition=client-a",
      );
    });

    it("a mismatched guard surfaces the same 404 as a missing document", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "document not found: d1", code: "document_not_found" }, 404),
      );
      try {
        await newClient().partition("client-b").get("d1");
        throw new Error("expected a 404");
      } catch (e) {
        expect(e).toBeInstanceOf(AetherApiError);
        expect((e as AetherApiError).status).toBe(404);
        expect((e as AetherApiError).errorCode).toBe("document_not_found");
      }
    });
  });

  // ── moveDocument ──────────────────────────────────────────────────

  describe("moveDocument", () => {
    const moved = {
      doc_id: "d1",
      cid: "c1",
      content_type: "text/plain",
      size_bytes: 1,
      chunks: 1,
      vectors: 1,
      version: 2,
      partition: "client-b",
    };

    it("POSTs both wire fields and returns the updated record", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(moved));
      const record = await newClient().moveDocument("d1", {
        from: "client-a",
        to: "client-b",
      });
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/documents/d1/move");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({
        to_partition: "client-b",
        expect_partition: "client-a",
      });
      expect(record.partition).toBe("client-b");
      expect(record.version).toBe(2);
    });

    it("sends explicit nulls for the default partition (keys always present)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ ...moved, partition: null }));
      await newClient().moveDocument("d1", { from: "client-a", to: null });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ to_partition: null, expect_partition: "client-a" });
      expect("to_partition" in body).toBe(true);
      expect("expect_partition" in body).toBe(true);
    });

    it("is never auto-scoped: a partition handle adds no query param", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(moved));
      await newClient()
        .partition("client-z")
        .moveDocument("d1", { from: null, to: "client-b" });
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:9000/v1/documents/d1/move");
      expect(url).not.toContain("partition=");
    });

    it("surfaces a wrong `from` assertion as the plain not-found 404", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "document not found: d1", code: "document_not_found" }, 404),
      );
      try {
        await newClient().moveDocument("d1", { from: "client-x", to: "client-b" });
        throw new Error("expected a 404");
      } catch (e) {
        expect(e).toBeInstanceOf(AetherApiError);
        expect((e as AetherApiError).status).toBe(404);
        expect((e as AetherApiError).errorCode).toBe("document_not_found");
      }
    });

    it("rejects an empty docId with no HTTP call", async () => {
      await expect(
        newClient().moveDocument("", { from: null, to: "client-b" }),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects an omitted field with no HTTP call (null must be explicit)", async () => {
      await expect(
        newClient().moveDocument(
          "d1",
          { from: "client-a" } as unknown as { from: string | null; to: string | null },
        ),
      ).rejects.toThrow(/to is required/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects an empty or oversized partition string with no HTTP call", async () => {
      await expect(
        newClient().moveDocument("d1", { from: "  ", to: "client-b" }),
      ).rejects.toThrow(AetherError);
      await expect(
        newClient().moveDocument("d1", { from: null, to: "a".repeat(257) }),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── partition echo on responses ───────────────────────────────────

  describe("partition echo", () => {
    const base = {
      cid: "c1",
      content_type: "text/plain",
      size_bytes: 1,
      chunks: 1,
      vectors: 1,
      version: 1,
    };

    it("surfaces partition on a document record, defaulting a missing field to null", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ doc_id: "d1", ...base, partition: "client-a" }),
      );
      expect((await newClient().get("d1")).partition).toBe("client-a");

      // Older payloads omit the field entirely → normalized to null.
      mockFetch.mockResolvedValueOnce(jsonResponse({ doc_id: "d2", ...base }));
      expect((await newClient().get("d2")).partition).toBeNull();
    });

    it("surfaces partition on every list item", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          documents: [
            { doc_id: "d1", ...base, partition: "client-a" },
            { doc_id: "d2", ...base, partition: null },
          ],
          count: 2,
          total: 2,
          offset: 0,
          limit: 10,
          has_more: false,
        }),
      );
      const { documents } = await newClient().list();
      expect(documents[0].partition).toBe("client-a");
      expect(documents[1].partition).toBeNull();
    });

    it("surfaces partition on every search hit (explicit null = default partition)", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          query: "q",
          results: [
            { doc_id: "d1", score: 90, content_type: "text/plain", partition: "client-a" },
            { doc_id: "d2", score: 80, content_type: "text/plain", partition: null },
          ],
        }),
      );
      const results = await newClient().search("q");
      expect(results[0].partition).toBe("client-a");
      expect(results[1].partition).toBeNull();
    });
  });

  // ── searchTrace + verifyIsolation ─────────────────────────────────

  function traceBody(
    partitionsTouched: string[],
    opts?: { defaultTouched?: boolean; results?: number },
  ): unknown {
    const results = opts?.results ?? 1;
    return {
      query: "q",
      results: [
        { doc_id: "d1", score: 90, content_type: "text/plain" },
      ].slice(0, results),
      trace: {
        scoped_to: "client-a",
        partitions_touched: partitionsTouched,
        default_partition_touched: opts?.defaultTouched ?? false,
        results,
        candidates_in_scope: 1,
        boundary: "partition",
      },
    };
  }

  describe("searchTrace", () => {
    it("sends trace=true, injects the handle partition, and parses results + trace", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(traceBody(["client-a"])));

      const traced = await newClient()
        .partition("client-a")
        .searchTrace("returns policy");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/v1/search?");
      expect(url).toContain("trace=true");
      expect(url).toContain("partition=client-a");

      expect(traced.trace.scopedTo).toBe("client-a");
      expect(traced.trace.partitionsTouched).toEqual(["client-a"]);
      expect(traced.trace.defaultPartitionTouched).toBe(false);
      expect(traced.trace.candidatesInScope).toBe(1);
      expect(traced.trace.boundary).toBe("partition");
      expect(traced.results[0].doc_id).toBe("d1");
    });

    it("works unscoped too (no partition param) and defaults a missing trace", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ query: "q", results: [] }));
      const traced = await newClient().searchTrace("anything");
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("trace=true");
      expect(url).not.toContain("partition=");
      expect(traced.results).toEqual([]);
      expect(traced.trace.scopedTo).toBeNull();
      expect(traced.trace.partitionsTouched).toEqual([]);
      expect(traced.trace.candidatesInScope).toBeNull();
    });
  });

  describe("verifyIsolation", () => {
    it("ok when the scope holds", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(traceBody(["client-a"])));
      const check = await newClient().partition("client-a").verifyIsolation("returns policy");
      expect(check.ok).toBe(true);
      expect(check.leaked).toEqual([]);
      expect(check.scopedTo).toBe("client-a");
      expect(check.results).toBe(1);
      expect(check.candidatesInScope).toBe(1);
    });

    it("flags a leak when another partition is touched", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(traceBody(["client-a", "client-b"])));
      const check = await newClient().partition("client-a").verifyIsolation("returns policy");
      expect(check.ok).toBe(false);
      expect(check.leaked).toEqual(["client-b"]);
    });

    it("not ok when the default partition was touched", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(traceBody(["client-a"], { defaultTouched: true })),
      );
      const check = await newClient().partition("client-a").verifyIsolation("returns policy");
      expect(check.ok).toBe(false);
      expect(check.leaked).toEqual([]);
    });

    it("requires a partition handle (throws without one, no HTTP call)", async () => {
      await expect(newClient().verifyIsolation("returns policy")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── typed partition_required error ────────────────────────────────

  describe("partition_required typed error", () => {
    it("maps 400 + code=partition_required to PartitionRequiredError", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "This API key is multi-tenant, so every search must name a partition.",
            code: "partition_required",
          },
          400,
        ),
      );

      try {
        await newClient().search("anything");
        throw new Error("expected PartitionRequiredError");
      } catch (e) {
        expect(e).toBeInstanceOf(PartitionRequiredError);
        expect((e as PartitionRequiredError).status).toBe(400);
        expect((e as PartitionRequiredError).errorCode).toBe("partition_required");
      }
    });

    it("maps the strict-scoping 400 on an unguarded by-ID call too", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "This API key requires every document route to name a partition.",
            code: "partition_required",
          },
          400,
        ),
      );
      await expect(newClient().get("d1")).rejects.toThrow(PartitionRequiredError);
    });

    it("a 400 with a different code stays the base API error", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "bad input", code: "invalid_input" }, 400),
      );
      try {
        await newClient().search("anything");
        throw new Error("expected an error");
      } catch (e) {
        expect(e).not.toBeInstanceOf(PartitionRequiredError);
      }
    });
  });
});
