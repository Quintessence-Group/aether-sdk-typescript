import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { AetherError } from "../src/errors.js";

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
