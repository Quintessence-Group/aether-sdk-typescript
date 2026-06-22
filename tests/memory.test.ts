import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { CreditExhaustedError } from "../src/errors.js";
import { Memory, type MemoryItem } from "../src/memory.js";

/**
 * Contract test for the {@link Memory} facade (AET-145).
 *
 * Mocked at the same transport layer as the existing client tests
 * (`vi.stubGlobal("fetch", ...)`) with the *real* raw client underneath,
 * constructed via the DI path (`new Memory(entityId, { client })`).
 *
 * This pins the facade to the **shipped 0.3.x search surface**: hits carry a
 * calibrated `score` (0–100, higher = better) and a `passage` — there is no
 * `distance` field, and `recall` fetches each matched document's text with a
 * follow-up `GET /documents/{id}/download` (search no longer inlines content).
 */

const FIXED_NOW = new Date("2026-06-15T00:00:00Z");

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── response builders ────────────────────────────────────────────────

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

function insertResp(
  docId = "doc-new",
  createdAt = "2026-06-15T00:00:00Z",
  entityId = "user-42",
): Response {
  return jsonResponse({
    doc_id: docId,
    cid: "cid-1",
    chunks: 1,
    vectors: 1,
    version: 1,
    created_at: createdAt,
    entity_id: entityId,
  });
}

function hit(docId: string, score: number, passage = "p") {
  return { doc_id: docId, score, content_type: "text/plain", passage };
}

function searchResp(results: unknown[]): Response {
  // 0.3.x wire shape: score + passage, no distance, no content.
  return jsonResponse({ query: "q", results });
}

function docResp(docId: string, createdAt: string | null): Response {
  return jsonResponse({
    doc_id: docId,
    cid: "c",
    content_type: "text/plain",
    size_bytes: 1,
    version: 1,
    created_at: createdAt,
    entity_id: "user-42",
  });
}

function listResp(documents: unknown[]): Response {
  return jsonResponse({
    documents,
    count: documents.length,
    total: documents.length,
    offset: 0,
    limit: documents.length,
    has_more: false,
  });
}

// ── routing transport ────────────────────────────────────────────────
//
// `fetch` is called as `fetch(url, init)`. We dispatch a scripted response keyed
// by `(method, path)`. A list value pops one response per call (FIFO); a single
// `Response` is reused. Records every call so tests can assert URL/params.

type RouteValue = Response | Response[];
interface RecordedCall {
  method: string;
  url: string;
  init: RequestInit;
}

class Transport {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly routes: Record<string, RouteValue>) {}

  handler = (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    this.calls.push({ method, url, init: init ?? {} });
    const path = url.split("?", 1)[0].replace(/^https?:\/\/[^/]+/, "");
    const key = `${method} ${path}`;
    const value = this.routes[key];
    if (value === undefined) {
      throw new Error(`unexpected request: ${method} ${path} (${url})`);
    }
    const resp = Array.isArray(value) ? value.shift()! : value;
    return Promise.resolve(resp);
  };

  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter(
      (c) =>
        c.method === method.toUpperCase() &&
        c.url.split("?", 1)[0].replace(/^https?:\/\/[^/]+/, "") === path,
    );
  }
}

function makeMemory(
  transport: Transport,
  entityId = "user-42",
  opts: Record<string, unknown> = {},
): Memory {
  mockFetch.mockImplementation(transport.handler);
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "k",
    maxRetries: 0,
  });
  return new Memory(entityId, { client, now: () => FIXED_NOW, ...opts });
}

// ── scoping ──────────────────────────────────────────────────────────

describe("scoping", () => {
  it("remember sends entity_id as a query param", async () => {
    const t = new Transport({ "POST /documents": insertResp() });
    await makeMemory(t).remember("hello");
    const [post] = t.callsTo("POST", "/documents");
    expect(post.url).toContain("entity_id=user-42");
  });

  it("recall sends entity_id filter on /search", async () => {
    const t = new Transport({ "GET /search": searchResp([]) });
    await makeMemory(t).recall("anxiety");
    const [search] = t.callsTo("GET", "/search");
    expect(search.url).toContain("entity_id=user-42");
  });

  it("list sends entity_id filter on /documents", async () => {
    const t = new Transport({ "GET /documents": listResp([]) });
    await makeMemory(t).list();
    const [list] = t.callsTo("GET", "/documents");
    expect(list.url).toContain("entity_id=user-42");
  });
});

// ── remember round-trip ──────────────────────────────────────────────

describe("remember round-trip", () => {
  it("returns a MemoryItem with score undefined", async () => {
    const t = new Transport({
      "POST /documents": insertResp("doc-7", "2026-06-15T09:30:00Z"),
    });
    const item = await makeMemory(t).remember("anxious about flying");
    expect(item.id).toBe("doc-7");
    expect(item.text).toBe("anxious about flying");
    expect(item.entityId).toBe("user-42");
    expect(item.score).toBeUndefined();
    expect(item.createdAt).toBe("2026-06-15T09:30:00Z");
  });

  it("empty text is a client-side error (no HTTP)", async () => {
    const t = new Transport({});
    await expect(makeMemory(t).remember("   ")).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
  });
});

// ── metadata → tags (write-only) ─────────────────────────────────────

describe("metadata tags", () => {
  it("encodes metadata as a key:value tag", async () => {
    const t = new Transport({ "POST /documents": insertResp() });
    await makeMemory(t).remember("breathing helps", { topic: "anxiety" });
    expect(t.calls[0].url).toContain("tags=topic%3Aanxiety");
  });

  it("sorts multiple tags by key", async () => {
    const t = new Transport({ "POST /documents": insertResp() });
    await makeMemory(t).remember("x", {
      topic: "anxiety",
      score: "5",
      active: "yes",
    });
    expect(t.calls[0].url).toContain(
      "tags=active%3Ayes%2Cscore%3A5%2Ctopic%3Aanxiety",
    );
  });

  it("sorts by key, not by the rendered tag", async () => {
    const t = new Transport({ "POST /documents": insertResp() });
    await makeMemory(t).remember("x", { a0: "w", a: "v" });
    expect(t.calls[0].url).toContain("tags=a%3Av%2Ca0%3Aw");
  });

  it("splits on the first colon so values may contain ':'", async () => {
    const t = new Transport({ "POST /documents": insertResp() });
    await makeMemory(t).remember("x", { time: "12:30" });
    expect(t.calls[0].url).toContain("tags=time%3A12%3A30");
  });

  it.each([
    { topic: "a,b" },
    { "": "v" },
    { "a,b": "v" },
    { "a:b": "v" },
  ])("rejects bad metadata with no HTTP: %o", async (metadata) => {
    const t = new Transport({});
    await expect(
      makeMemory(t).remember("x", metadata as Record<string, string>),
    ).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
  });
});

// ── recall (default: recencyWeight = 0) ──────────────────────────────

describe("recall (default)", () => {
  it("searches then downloads in server order; score = wire/100", async () => {
    const t = new Transport({
      "GET /search": searchResp([hit("d1", 95), hit("d2", 70)]),
      "GET /documents/d1/download": binaryResponse("first"),
      "GET /documents/d2/download": binaryResponse("second"),
    });
    const items = await makeMemory(t).recall("query", { k: 5 });

    // one search + one download per unique hit; NO metadata get() calls
    expect(t.callsTo("GET", "/search")).toHaveLength(1);
    expect(t.callsTo("GET", "/documents/d1/download")).toHaveLength(1);
    expect(t.callsTo("GET", "/documents/d2/download")).toHaveLength(1);
    expect(t.callsTo("GET", "/documents/d1")).toHaveLength(0);

    expect(items.map((i) => i.id)).toEqual(["d1", "d2"]);
    expect(items.map((i) => i.text)).toEqual(["first", "second"]);
    expect(items.every((i) => i.createdAt === undefined)).toBe(true);

    // score normalized from the 0–100 wire score; higher = better
    expect(items[0].score).toBeCloseTo(0.95, 10);
    expect(items[1].score).toBeCloseTo(0.7, 10);

    // entity filter + k forwarded; no removed include_content flag
    const url = t.callsTo("GET", "/search")[0].url;
    expect(url).not.toContain("include_content");
    expect(url).toContain("entity_id=user-42");
    expect(url).toContain("k=5");
  });

  it("empty query is a client-side error (no HTTP)", async () => {
    const t = new Transport({});
    await expect(makeMemory(t).recall("   ")).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
  });

  it("k < 1 is a client-side error (no HTTP)", async () => {
    const t = new Transport({});
    await expect(makeMemory(t).recall("query", { k: 0 })).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
  });
});

// ── recall (recencyWeight > 0: blended re-ranking) ───────────────────
//
// recencyWeight=0.5, halfLifeDays=30, now=2026-06-15. similarity = score/100,
// recency = 0.5 ** (ageDays / 30). blended = 0.5*sim + 0.5*recency:
//   docA score=90  age=0d   -> 0.5*0.90 + 0.5*1.0 = 0.95
//   docB score=80  age=30d  -> 0.5*0.80 + 0.5*0.5 = 0.65
//   docC score=100 created=null (recency 0) -> 0.5*1.00 + 0.5*0.0 = 0.50
// Pure score order is [docC, docA, docB]; recency reorders to [docA, docB, docC].

describe("recall (recency blend)", () => {
  function recencyTransport(): Transport {
    return new Transport({
      "GET /search": searchResp([
        hit("docA", 90),
        hit("docB", 80),
        hit("docC", 100),
      ]),
      "GET /documents/docA/download": binaryResponse("A"),
      "GET /documents/docB/download": binaryResponse("B"),
      "GET /documents/docC/download": binaryResponse("C"),
      "GET /documents/docA": docResp("docA", "2026-06-15T00:00:00Z"),
      "GET /documents/docB": docResp("docB", "2026-05-16T00:00:00Z"),
      "GET /documents/docC": docResp("docC", null),
    });
  }

  it("re-orders by the blended score and populates createdAt", async () => {
    const items = await makeMemory(recencyTransport()).recall("q", {
      k: 5,
      recencyWeight: 0.5,
    });
    expect(items.map((i) => i.id)).toEqual(["docA", "docB", "docC"]);
    expect(items[0].score).toBeCloseTo(0.95, 10);
    expect(items[1].score).toBeCloseTo(0.65, 10);
    expect(items[2].score).toBeCloseTo(0.5, 10);
    expect(items[0].createdAt).toBe("2026-06-15T00:00:00Z");
  });

  it("truncates to the top k after re-ranking", async () => {
    const items = await makeMemory(recencyTransport()).recall("q", {
      k: 2,
      recencyWeight: 0.5,
    });
    expect(items.map((i) => i.id)).toEqual(["docA", "docB"]);
  });
});

// ── list (chronological) ─────────────────────────────────────────────

describe("list", () => {
  it("returns newest-first with text downloaded and score undefined", async () => {
    const t = new Transport({
      "GET /documents": listResp([
        {
          doc_id: "m1",
          content_type: "text/plain",
          created_at: "2026-06-15T00:00:00Z",
        },
        {
          doc_id: "m2",
          content_type: "text/plain",
          created_at: "2026-06-01T00:00:00Z",
        },
      ]),
      "GET /documents/m1/download": binaryResponse("newest"),
      "GET /documents/m2/download": binaryResponse("older"),
    });
    const items = await makeMemory(t).list();
    expect(items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(items.map((i) => i.text)).toEqual(["newest", "older"]);
    expect(items.every((i) => i.score === undefined)).toBe(true);
  });
});

// ── forget ───────────────────────────────────────────────────────────

describe("forget", () => {
  it("issues one DELETE", async () => {
    const t = new Transport({ "DELETE /documents/doc-x": jsonResponse({}) });
    await makeMemory(t).forget("doc-x");
    expect(t.callsTo("DELETE", "/documents/doc-x")).toHaveLength(1);
  });

  it("empty id is a client-side error (no HTTP)", async () => {
    const t = new Transport({});
    await expect(makeMemory(t).forget("")).rejects.toThrow();
    expect(t.calls).toHaveLength(0);
  });

  it("forgetAll deletes every listed doc and returns the count", async () => {
    const t = new Transport({
      "GET /documents": [
        listResp([
          { doc_id: "a", content_type: "text/plain" },
          { doc_id: "b", content_type: "text/plain" },
        ]),
        listResp([]),
      ],
      "DELETE /documents/a": jsonResponse({}),
      "DELETE /documents/b": jsonResponse({}),
    });
    expect(await makeMemory(t).forgetAll()).toBe(2);
  });
});

// ── error passthrough ────────────────────────────────────────────────

describe("error passthrough", () => {
  it("surfaces the typed CreditExhaustedError verbatim", async () => {
    const t = new Transport({
      "POST /documents": jsonResponse(
        { error: "out of credit", code: "credit_exhausted" },
        402,
      ),
    });
    await expect(makeMemory(t).remember("x")).rejects.toBeInstanceOf(
      CreditExhaustedError,
    );
  });
});

// ── invalid construction ─────────────────────────────────────────────

describe("invalid construction", () => {
  it.each(["", "   ", "\t"])("rejects empty/whitespace entityId %j", (id) => {
    expect(() => new Memory(id, { client: {} as AetherClient })).toThrow();
  });

  it("rejects an oversized entityId", () => {
    expect(
      () => new Memory("x".repeat(257), { client: {} as AetherClient }),
    ).toThrow();
  });

  it("accepts a max-length entityId", () => {
    expect(
      () => new Memory("x".repeat(256), { client: {} as AetherClient }),
    ).not.toThrow();
  });

  it("rejects a non-positive halfLifeDays", () => {
    expect(
      () =>
        new Memory("u", { client: {} as AetherClient, halfLifeDays: 0 }),
    ).toThrow();
  });
});

// ── type sanity ──────────────────────────────────────────────────────

describe("MemoryItem typing", () => {
  it("exposes the documented fields", () => {
    const item: MemoryItem = {
      id: "d",
      text: "t",
      createdAt: "2026-06-15T00:00:00Z",
      entityId: "user-42",
      score: 0.9,
    };
    expect(item.id).toBe("d");
  });
});
