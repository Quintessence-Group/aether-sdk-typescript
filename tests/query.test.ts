import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { AetherApiError } from "../src/errors.js";
import type { AggregateResult, QueryPage } from "../src/models.js";

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

function lastCall(): { url: string; init: RequestInit; body: any } {
  const calls = mockFetch.mock.calls;
  const [url, init] = calls[calls.length - 1];
  return {
    url: url as string,
    init: init as RequestInit,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  };
}

describe("client.query", () => {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
  });

  it("Mode A returns a document page and posts the filter/sort/limit body", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        documents: [
          { doc_id: "d1", cid: "", content_type: "text/plain", metadata: { status: "paid" } },
        ],
        total: 1,
        has_more: false,
      }),
    );

    const page = (await client.query({
      filter: { field: "status", op: "eq", value: "paid" },
      sort: [{ by: "created_at", dir: "desc" }],
      limit: 10,
    })) as QueryPage;

    expect(page.documents.map((d) => d.doc_id)).toEqual(["d1"]);
    expect(page.total).toBe(1);
    expect(page.has_more).toBe(false);

    const { url, init, body } = lastCall();
    expect(init.method).toBe("POST");
    expect(url).toContain("/v1/query");
    expect(body.filter).toEqual({ field: "status", op: "eq", value: "paid" });
    expect(body.sort).toEqual([{ by: "created_at", dir: "desc" }]);
    expect(body.limit).toBe(10);
    expect(body.aggregate).toBeUndefined();
    expect(body.group_by).toBeUndefined();
  });

  it("Mode B returns an aggregate result and posts group_by/aggregate", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        groups: [
          { keys: { status: "paid" }, aggregates: { count: 2, total: 350.0 } },
          { keys: { status: "open" }, aggregates: { count: 1, total: 9.0 } },
        ],
        total_groups: 2,
        scanned: 3,
      }),
    );

    const result = (await client.query({
      groupBy: ["status"],
      aggregate: [{ op: "count" }, { op: "sum", field: "amount", as: "total" }],
      sort: [{ by: "total", dir: "desc" }],
    })) as AggregateResult;

    expect(result.total_groups).toBe(2);
    expect(result.scanned).toBe(3);
    expect(result.groups[0].keys).toEqual({ status: "paid" });
    expect(result.groups[0].aggregates.total).toBe(350.0);

    const { body } = lastCall();
    expect(body.group_by).toEqual(["status"]);
    expect(body.aggregate[1]).toEqual({ op: "sum", field: "amount", as: "total" });
  });

  it("a partition-scoped handle carries the partition in the body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ documents: [], total: 0, has_more: false }));
    await client.partition("acct-42").query({ filter: { status: "paid" } });
    expect(lastCall().body.partition).toBe("acct-42");
  });

  it("a 400 guardrail error raises AetherApiError", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: "aggregation would produce more than 10000 groups" }, 400),
    );
    await expect(
      client.query({ groupBy: ["x"], aggregate: [{ op: "count" }] }),
    ).rejects.toBeInstanceOf(AetherApiError);
  });
});
