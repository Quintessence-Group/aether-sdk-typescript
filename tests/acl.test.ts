import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import {
  AetherApiError,
  AetherError,
  PrincipalPinMismatchError,
  aetherApiErrorFromResponse,
} from "../src/errors.js";

// Read-ACLs, acting-principal scoping, and the access-audit surface —
// `acl_readers` wire encoding on the insert family, `asPrincipal()` assertion
// injection (and its composition with `partition()`), `audit.access()`
// parsing, and the typed pinned-key mismatch error — all driven through a real
// client over a mocked `fetch` so the genuine request-building / parse /
// error-mapping path runs.

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

const DOC = { doc_id: "d1", cid: "c1", content_type: "text/plain" };

function calledUrl(callIndex = 0): URL {
  return new URL(mockFetch.mock.calls[callIndex][0] as string);
}

describe("acl_readers wire encoding", () => {
  it("insertText sends acl_readers comma-joined", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient().insertText("hello", {
      aclReaders: ["user:alice", "group:eng"],
    });
    const url = calledUrl();
    expect(url.searchParams.get("acl_readers")).toBe("user:alice,group:eng");
  });

  it("insertText with an empty array sends an explicit empty param (quarantine)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient().insertText("hello", { aclReaders: [] });
    const url = calledUrl();
    expect(url.searchParams.has("acl_readers")).toBe(true);
    expect(url.searchParams.get("acl_readers")).toBe("");
  });

  it("insertText without aclReaders sends no param", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient().insertText("hello");
    expect(calledUrl().searchParams.has("acl_readers")).toBe(false);
  });

  it("insert and update send acl_readers", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(DOC))
      .mockResolvedValueOnce(jsonResponse(DOC));
    const client = newClient();
    await client.insert(new TextEncoder().encode("x"), {
      filename: "a.txt",
      aclReaders: ["user:alice"],
    });
    await client.update("d1", new TextEncoder().encode("y"), {
      filename: "a.txt",
      aclReaders: ["user:bob"],
    });
    expect(calledUrl(0).searchParams.get("acl_readers")).toBe("user:alice");
    expect(calledUrl(1).searchParams.get("acl_readers")).toBe("user:bob");
  });

  it("insertAsync sends acl_readers", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ job_id: "j1", status: "queued", poll_url: "/x" }),
    );
    await newClient().insertAsync(new TextEncoder().encode("x"), {
      filename: "a.txt",
      aclReaders: ["group:eng"],
    });
    expect(calledUrl().searchParams.get("acl_readers")).toBe("group:eng");
  });

  it("batchInsert items carry acl_readers as a CSV string (empty array survives)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [DOC, DOC, DOC] }));
    await newClient().batchInsert([
      { filename: "a.txt", content: "a", acl_readers: ["user:alice", "group:eng"] },
      { filename: "b.txt", content: "b", acl_readers: [] },
      { filename: "c.txt", content: "c" },
    ]);
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.documents[0].acl_readers).toBe("user:alice,group:eng");
    expect(body.documents[1].acl_readers).toBe("");
    expect(body.documents[2]).not.toHaveProperty("acl_readers");
  });

  it("rejects a label containing a comma client-side (no HTTP call)", async () => {
    // A comma inside one label would silently split it into several on the
    // CSV wire — widening the ACL (e.g. smuggling in an extra group grant).
    const client = newClient();
    await expect(
      client.insertText("hello", { aclReaders: ["user:bob,group:everyone"] }),
    ).rejects.toThrow(AetherError);
    await expect(
      client.batchInsert([{ filename: "a.txt", content: "a", acl_readers: ["a,b"] }]),
    ).rejects.toThrow(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects a blank label client-side (no HTTP call)", async () => {
    // [""] would encode identically to [] — an accidental quarantine.
    const client = newClient();
    await expect(client.insertText("hello", { aclReaders: [""] })).rejects.toThrow(
      AetherError,
    );
    await expect(
      client.insertText("hello", { aclReaders: ["user:alice", "   "] }),
    ).rejects.toThrow(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("insertWithEmbeddings sends acl_readers as a JSON array", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient().insertWithEmbeddings({
      content: "x",
      embedding: [0.1, 0.2],
      aclReaders: ["user:alice", "group:eng"],
    });
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.acl_readers).toEqual(["user:alice", "group:eng"]);
  });

  it("insertWithEmbeddings keeps empty and omitted aclReaders distinct", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(DOC))
      .mockResolvedValueOnce(jsonResponse(DOC));
    const client = newClient();
    await client.insertWithEmbeddings({ content: "x", embedding: [0.1], aclReaders: [] });
    await client.insertWithEmbeddings({ content: "x", embedding: [0.1] });
    const first = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const second = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(first.acl_readers).toEqual([]);
    expect(second).not.toHaveProperty("acl_readers");
  });
});

describe("asPrincipal scoping", () => {
  it("injects acting_principal and acting_groups on reads", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ query: "q", results: [] }));
    await newClient()
      .asPrincipal("user:alice", { groups: ["group:eng", "group:board"] })
      .search("q");
    const url = calledUrl();
    expect(url.searchParams.get("acting_principal")).toBe("user:alice");
    expect(url.searchParams.get("acting_groups")).toBe("group:eng,group:board");
  });

  it("sends no acting_groups param when no groups are given", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient().asPrincipal("user:alice").get("d1");
    const url = calledUrl();
    expect(url.searchParams.get("acting_principal")).toBe("user:alice");
    expect(url.searchParams.has("acting_groups")).toBe(false);
  });

  it("applies to writes too (consistent audit actor)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient().asPrincipal("user:alice").insertText("hello");
    expect(calledUrl().searchParams.get("acting_principal")).toBe("user:alice");
  });

  it("composes with partition()", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ query: "q", results: [] }));
    await newClient().partition("client-a").asPrincipal("user:alice").search("q");
    const url = calledUrl();
    expect(url.searchParams.get("partition")).toBe("client-a");
    expect(url.searchParams.get("acting_principal")).toBe("user:alice");
  });

  it("re-scoping is last-wins", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ query: "q", results: [] }));
    await newClient().asPrincipal("user:a").asPrincipal("user:b").search("q");
    expect(calledUrl().searchParams.get("acting_principal")).toBe("user:b");
  });

  it("leaves the base client unscoped", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ query: "q", results: [] }));
    const base = newClient();
    base.asPrincipal("user:alice"); // scoped clone unused
    await base.search("q");
    expect(calledUrl().searchParams.has("acting_principal")).toBe(false);
  });

  it("rejects an empty or whitespace principal with no HTTP call", () => {
    expect(() => newClient().asPrincipal("")).toThrow(AetherError);
    expect(() => newClient().asPrincipal("   ")).toThrow(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("drops blank group entries", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient()
      .asPrincipal("user:alice", { groups: ["", "  ", "group:eng"] })
      .get("d1");
    expect(calledUrl().searchParams.get("acting_groups")).toBe("group:eng");
  });

  it("rejects a group label containing a comma (no HTTP call)", () => {
    // Groups are comma-joined on the wire; a comma inside one label would
    // silently widen the asserted read scope with extra groups.
    expect(() =>
      newClient().asPrincipal("user:alice", { groups: ["group:a,group:admin"] }),
    ).toThrow(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("URL-encodes principal labels", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(DOC));
    await newClient().asPrincipal("user:al ice").get("d1");
    const raw = mockFetch.mock.calls[0][0] as string;
    expect(raw).toContain("acting_principal=user%3Aal+ice");
  });
});

describe("audit.access", () => {
  const ACCESS_BODY = {
    records: [
      {
        at: "2026-07-01T00:00:00Z",
        actor: "user:bob",
        action: "denied",
        resource: "document:d1",
        outcome: "denied",
        source: "access",
      },
      {
        at: "2026-07-01T00:00:01Z",
        actor: "user:alice",
        action: "read",
        resource: "document:d1",
        outcome: "ok",
        source: "access",
      },
    ],
    total: 7,
  };

  it("parses records and total from the envelope", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(ACCESS_BODY));
    const page = await newClient().audit.access();
    const url = calledUrl();
    expect(url.pathname).toBe("/v1/audit/access");
    expect(page.total).toBe(7);
    expect(page.records).toHaveLength(2);
    expect(page.records[0].actor).toBe("user:bob");
    expect(page.records[0].outcome).toBe("denied");
    expect(page.records[0].source).toBe("access");
    expect(page.records[0].proof).toBeUndefined();
    expect(page.records[1].outcome).toBe("ok");
  });

  it("sends every filter as a query param", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ records: [], total: 0 }));
    await newClient().audit.access({
      actor: "user:alice",
      resource: "document:d1",
      action: "read",
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-02T00:00:00Z",
      limit: 10,
      offset: 20,
    });
    const url = calledUrl();
    expect(url.searchParams.get("actor")).toBe("user:alice");
    expect(url.searchParams.get("resource")).toBe("document:d1");
    expect(url.searchParams.get("action")).toBe("read");
    expect(url.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(url.searchParams.get("until")).toBe("2026-07-02T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("20");
  });

  it("tolerates a response with no records", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ total: 0 }));
    const page = await newClient().audit.access();
    expect(page.records).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("carries the asPrincipal scope", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ records: [], total: 0 }));
    await newClient().asPrincipal("user:alice").audit.access();
    expect(calledUrl().searchParams.get("acting_principal")).toBe("user:alice");
  });
});

describe("principal_pin_mismatch typed error", () => {
  it("maps 403 + principal_pin_mismatch to PrincipalPinMismatchError", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error:
            "This API key is pinned to a principal and cannot assert a different acting_principal",
          code: "principal_pin_mismatch",
        },
        403,
      ),
    );
    const err = await newClient()
      .asPrincipal("user:mallory")
      .search("q")
      .catch((e) => e);
    expect(err).toBeInstanceOf(PrincipalPinMismatchError);
    expect(err.status).toBe(403);
    expect(err.errorCode).toBe("principal_pin_mismatch");
  });

  it("keeps a plain 403 as the base AetherApiError", () => {
    const err = aetherApiErrorFromResponse(403, "Forbidden", { error: "forbidden" });
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).not.toBeInstanceOf(PrincipalPinMismatchError);
  });

  it("factory maps the (403, principal_pin_mismatch) pair only", () => {
    const typed = aetherApiErrorFromResponse(403, "Forbidden", {
      error: "pinned",
      code: "principal_pin_mismatch",
    });
    expect(typed).toBeInstanceOf(PrincipalPinMismatchError);
    expect(typed.name).toBe("PrincipalPinMismatchError");
    const wrongStatus = aetherApiErrorFromResponse(400, "Bad Request", {
      error: "pinned",
      code: "principal_pin_mismatch",
    });
    expect(wrongStatus).not.toBeInstanceOf(PrincipalPinMismatchError);
  });
});
