import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { AetherError, PartitionRequiredError } from "../src/errors.js";

// Partition lifecycle (listPartitions / deletePartition), provable isolation
// (searchTrace / verifyIsolation), and the typed partition_required error —
// all driven through a real client over a mocked `fetch` so the genuine
// request-building / parse / error-mapping path runs.

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

  // ── searchTrace + verifyIsolation ─────────────────────────────────

  function traceBody(
    partitionsTouched: string[],
    opts?: { defaultTouched?: boolean; results?: number },
  ): unknown {
    const results = opts?.results ?? 1;
    return {
      query: "q",
      results: [
        { doc_id: "d1", distance: 0.1, content_type: "text/plain" },
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
