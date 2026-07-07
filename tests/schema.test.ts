import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";

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

describe("client.schema", () => {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
  });

  it("declareFields PUTs the fields and returns typed FieldSchema", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        fields: [
          {
            name: "amount",
            type: "float",
            source: { metadata: "amount" },
            coverage: 3,
            mismatch_count: 0,
            backfill: "complete",
          },
        ],
        count: 1,
      }),
    );

    const fields = await client.schema.declareFields([
      { name: "amount", type: "float", source: { metadata: "amount" } },
    ]);

    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe("amount");
    expect(fields[0].type).toBe("float");
    expect(fields[0].coverage).toBe(3);

    const { url, init, body } = lastCall();
    expect(init.method).toBe("PUT");
    expect(url).toContain("/v1/schema/fields");
    expect(body).toEqual({
      fields: [{ name: "amount", type: "float", source: { metadata: "amount" } }],
    });
  });

  it("listFields returns the declared fields", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        fields: [{ name: "status", type: "string", source: { metadata: "status" }, coverage: 0, mismatch_count: 0, backfill: "complete" }],
        count: 1,
      }),
    );
    const fields = await client.schema.listFields();
    expect(fields.map((f) => f.name)).toEqual(["status"]);
    expect(lastCall().url).toContain("/v1/schema/fields");
  });

  it("deleteField DELETEs by name", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ fields: [], count: 0 }));
    const remaining = await client.schema.deleteField("amount");
    expect(remaining).toEqual([]);
    const { url, init } = lastCall();
    expect(init.method).toBe("DELETE");
    expect(url).toContain("/v1/schema/fields/amount");
  });

  it("a partition-scoped handle carries the partition query param", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ fields: [], count: 0 }));
    await client.partition("acct-9").schema.listFields();
    expect(lastCall().url).toContain("partition=acct-9");
  });
});
