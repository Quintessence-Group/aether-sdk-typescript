import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { Memory } from "../src/memory.js";
import { AetherError } from "../src/errors.js";

/** UUID shape the SDK mints for a thread lifecycle Idempotency-Key fallback. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    statusText: status === 200 ? "OK" : "Created",
    headers: { "Content-Type": "application/json" },
  });
}

describe("AetherClient conversational threads", () => {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
  });

  it("appends through /v1 with a caller-stable idempotency header", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        doc_id: "turn-1",
        cid: "blake3:turn-1",
        chunks: 1,
        vectors: 1,
        version: 1,
        content_type: "text/plain",
        size_bytes: 5,
        thread_id: "chat/42",
        turn_index: 0,
      }, 201),
    );

    const result = await client.appendThread("chat/42", {
      text: "hello",
      metadata: { role: "user" },
      tags: ["support"],
      idempotencyKey: "thread-turn-42-0",
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:9000/v1/threads/chat%2F42/append");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer aether_testkey123",
      "Content-Type": "application/json",
      "Idempotency-Key": "thread-turn-42-0",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      text: "hello",
      metadata: { role: "user" },
      tags: ["support"],
    });
    expect(result.thread_id).toBe("chat/42");
    expect(result.turn_index).toBe(0);
  });

  it("reads chronological context with window and partition parameters", async () => {
    const scoped = client.partition("tenant-a");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        thread_id: "chat-1",
        documents: [{
          doc_id: "turn-2",
          cid: "blake3:turn-2",
          chunks: 1,
          vectors: 1,
          version: 1,
          content_type: "text/plain",
          size_bytes: 5,
          thread_id: "chat-1",
          turn_index: 2,
        }],
      }),
    );

    const thread = await scoped.getThread("chat-1", {
      lastNTurns: 3,
      recentFirst: true,
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/threads/chat-1?");
    expect(url).toContain("last_n_turns=3");
    expect(url).toContain("recent_first=true");
    expect(url).toContain("partition=tenant-a");
    expect(thread.documents[0]?.turn_index).toBe(2);
  });

  it("rejects invalid thread ids and turn windows before transport", async () => {
    await expect(client.appendThread("  ", { text: "hello" })).rejects.toBeInstanceOf(AetherError);
    for (const threadId of [".", ".."]) {
      await expect(client.appendThread(threadId, { text: "hello" })).rejects.toThrow(/dot segment/);
    }
    await expect(client.appendThread("safe\u0000id", { text: "hello" })).rejects.toThrow(/control/);
    await expect(client.getThread("safe\u0085id")).rejects.toThrow(/control/);
    await expect(client.appendThread("safe\uD800", { text: "hello" })).rejects.toThrow(/surrogate/);
    await expect(client.getThread("\uDC00safe")).rejects.toThrow(/surrogate/);
    await expect(client.getThread("😀".repeat(257))).rejects.toThrow(/256/);
    await expect(client.getThread("chat", { lastNTurns: 0 })).rejects.toBeInstanceOf(AetherError);
    await expect(client.getThread("chat", { lastNTurns: 1001 })).rejects.toBeInstanceOf(AetherError);
    await expect(client.getThread("chat", { lastNTurns: 1.5 })).rejects.toBeInstanceOf(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("counts thread id length in Unicode scalar values", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ thread_id: "😀".repeat(256), documents: [] }));
    await expect(client.getThread("😀".repeat(256))).resolves.toBeDefined();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("forwards the thread filter to semantic search", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ query: "hello", results: [] }));

    await client.search("hello", 5, { threadId: "chat/42" });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("thread_id=chat%2F42");
  });
});

// Parse the URL + init of the last fetch call, plus decoded convenience views.
function lastCall(): {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
} {
  const [url, init] = mockFetch.mock.calls.at(-1) as [string, RequestInit];
  const headers = (init.headers ?? {}) as Record<string, string>;
  const body =
    typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  return { url, init, headers, body };
}

describe("AetherClient thread lifecycle", () => {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
  });

  function scoped(): AetherClient {
    return client.partition("tenant-a");
  }

  it("restores through /v1 with a minted idempotency header", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "restored", thread_id: "chat/42", turns: 3 }),
    );

    const result = await client.restoreThread("chat/42");

    const { url, init, headers } = lastCall();
    expect(url).toBe("http://localhost:9000/v1/threads/chat%2F42/restore");
    expect(init.method).toBe("POST");
    expect(headers).toMatchObject({ Authorization: "Bearer aether_testkey123" });
    expect(headers["Idempotency-Key"]).toMatch(UUID_RE);
    expect(init.body).toBeUndefined();
    expect(result).toEqual({ status: "restored", thread_id: "chat/42", turns: 3 });
  });

  it("restore honors a caller idempotency key and the partition guard", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "restored", thread_id: "chat-1", turns: 1 }),
    );

    await scoped().restoreThread("chat-1", { idempotencyKey: "restore-key-1" });

    const { url, headers } = lastCall();
    expect(url).toContain("/v1/threads/chat-1/restore?");
    expect(url).toContain("partition=tenant-a");
    expect(headers["Idempotency-Key"]).toBe("restore-key-1");
  });

  it("sets a restricting ACL via PUT with a JSON body", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "acl_updated", thread_id: "chat-1", turns: 2 }),
    );

    await client.setThreadAcl("chat-1", ["user:alice", "group:eng"]);

    const { url, init, headers, body } = lastCall();
    expect(url).toBe("http://localhost:9000/v1/threads/chat-1/acl");
    expect(init.method).toBe("PUT");
    expect(headers).toMatchObject({ "Content-Type": "application/json" });
    expect(headers["Idempotency-Key"]).toMatch(UUID_RE);
    expect(body).toEqual({ acl_readers: ["user:alice", "group:eng"] });
  });

  it("distinguishes null (unlabel) from [] (admin-only quarantine) on the wire", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "acl_updated", thread_id: "chat-1", turns: 1 }),
    );
    await client.setThreadAcl("chat-1", null);
    expect(lastCall().body).toEqual({ acl_readers: null });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "acl_updated", thread_id: "chat-1", turns: 1 }),
    );
    await client.setThreadAcl("chat-1", []);
    expect(lastCall().body).toEqual({ acl_readers: [] });
  });

  it("set-ACL sends the partition guard when scoped", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "acl_updated", thread_id: "chat-1", turns: 1 }),
    );

    await scoped().setThreadAcl("chat-1", ["user:alice"]);

    expect(lastCall().url).toContain("/v1/threads/chat-1/acl?partition=tenant-a");
  });

  it("rejects malformed ACL labels before transport", async () => {
    await expect(client.setThreadAcl("chat-1", ["ok", ""])).rejects.toThrow(
      /empty/,
    );
    await expect(client.setThreadAcl("chat-1", ["a,b"])).rejects.toThrow(/comma/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("moves a thread via a body assertion, never a partition query param", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "moved", thread_id: "chat-1", turns: 4 }),
    );

    const result = await client.moveThread("chat-1", {
      expectPartition: "tenant-a",
      toPartition: "tenant-b",
    });

    const { url, init, headers, body } = lastCall();
    expect(url).toBe("http://localhost:9000/v1/threads/chat-1/move");
    expect(url).not.toContain("partition=");
    expect(init.method).toBe("POST");
    expect(headers).toMatchObject({ "Content-Type": "application/json" });
    expect(headers["Idempotency-Key"]).toMatch(UUID_RE);
    expect(body).toEqual({ to_partition: "tenant-b", expect_partition: "tenant-a" });
    expect(result.status).toBe("moved");
  });

  it("move keeps explicit nulls on the wire (default-partition address)", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "moved", thread_id: "chat-1", turns: 1 }),
    );

    await client.moveThread("chat-1", { expectPartition: null, toPartition: null });

    expect(lastCall().body).toEqual({ to_partition: null, expect_partition: null });
  });

  it("move validates each partition side before transport", async () => {
    await expect(
      client.moveThread("chat-1", {
        expectPartition: undefined as unknown as null,
        toPartition: null,
      }),
    ).rejects.toThrow(/required/);
    await expect(
      client.moveThread("chat-1", { expectPartition: "  ", toPartition: null }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      client.moveThread("chat-1", {
        expectPartition: null,
        toPartition: "x".repeat(257),
      }),
    ).rejects.toThrow(/256/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("soft-deletes with DELETE and a minted idempotency header", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "tombstoned", thread_id: "chat-1", turns: 5 }),
    );

    const result = await client.deleteThread("chat-1");

    const { url, init, headers } = lastCall();
    expect(url).toBe("http://localhost:9000/v1/threads/chat-1");
    expect(url).not.toContain("hard=");
    expect(init.method).toBe("DELETE");
    expect(headers["Idempotency-Key"]).toMatch(UUID_RE);
    expect(result.status).toBe("tombstoned");
  });

  it("hard-deletes via ?hard=true alongside the partition guard", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "hard_deleted", thread_id: "chat-1", turns: 5 }),
    );

    await scoped().deleteThread("chat-1", { hard: true });

    const { url } = lastCall();
    expect(url).toContain("hard=true");
    expect(url).toContain("partition=tenant-a");
  });

  it("validates the thread id on every lifecycle route before transport", async () => {
    await expect(client.restoreThread("  ")).rejects.toBeInstanceOf(AetherError);
    await expect(client.setThreadAcl(".", null)).rejects.toThrow(/dot segment/);
    await expect(
      client.moveThread("safe\u0000id", { expectPartition: null, toPartition: null }),
    ).rejects.toThrow(/control/);
    await expect(client.deleteThread("\uDC00safe")).rejects.toThrow(/surrogate/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("Memory Thread lifecycle facade", () => {
  function threadOn(partition?: string) {
    let client = new AetherClient({
      baseUrl: "http://localhost:9000",
      apiKey: "aether_testkey123",
      maxRetries: 0,
    });
    if (partition) client = client.partition(partition);
    return new Memory("patient-john", { client }).thread("chat-1");
  }

  it("restore() delegates to POST /restore with a minted key", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "restored", thread_id: "chat-1", turns: 1 }),
    );

    await threadOn().restore();

    const { url, init, headers } = lastCall();
    expect(url).toBe("http://localhost:9000/v1/threads/chat-1/restore");
    expect(init.method).toBe("POST");
    expect(headers["Idempotency-Key"]).toMatch(UUID_RE);
  });

  it("setAcl() delegates to PUT /acl with the JSON body", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "acl_updated", thread_id: "chat-1", turns: 1 }),
    );

    await threadOn().setAcl(["user:alice"]);

    const { url, init, body } = lastCall();
    expect(url).toBe("http://localhost:9000/v1/threads/chat-1/acl");
    expect(init.method).toBe("PUT");
    expect(body).toEqual({ acl_readers: ["user:alice"] });
  });

  it("move() asserts the default partition when the handle is unscoped", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "moved", thread_id: "chat-1", turns: 1 }),
    );

    await threadOn().move("tenant-b");

    const { url, body } = lastCall();
    expect(url).toBe("http://localhost:9000/v1/threads/chat-1/move");
    expect(body).toEqual({ to_partition: "tenant-b", expect_partition: null });
  });

  it("move() asserts the handle's current partition as expect_partition", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "moved", thread_id: "chat-1", turns: 1 }),
    );

    await threadOn("tenant-a").move("tenant-b");

    expect(lastCall().body).toEqual({
      to_partition: "tenant-b",
      expect_partition: "tenant-a",
    });
  });

  it("delete() is a soft tombstone by default and hard on request", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "tombstoned", thread_id: "chat-1", turns: 1 }),
    );
    await threadOn().delete();
    let seen = lastCall();
    expect(seen.init.method).toBe("DELETE");
    expect(seen.url).not.toContain("hard=");

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "hard_deleted", thread_id: "chat-1", turns: 1 }),
    );
    await threadOn().delete(true);
    seen = lastCall();
    expect(seen.url).toContain("hard=true");
  });
});
