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
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

describe("production hardening", () => {
  describe("User-Agent", () => {
    it("sends a versioned User-Agent header (Node runtime)", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ node_id: 0, documents: 0, vectors: 0 }));
      await client.status();
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["User-Agent"]).toMatch(/^aether-sdk-typescript\//);
    });
  });

  describe("Idempotency-Key", () => {
    it("attaches a key to POST requests", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ doc_id: "d1", cid: "c1", chunks: 1, vectors: 1, version: 1 }),
      );
      await client.insertText("hello");
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["Idempotency-Key"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it("reuses the same key across retries", async () => {
      const client = new AetherClient({
        baseUrl: "http://localhost:9000",
        retryBaseDelay: 0,
      });
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503))
        .mockResolvedValueOnce(
          jsonResponse({ doc_id: "d1", cid: "c1", chunks: 1, vectors: 1, version: 1 }),
        );
      await client.insertText("hello");
      const keys = mockFetch.mock.calls.map((c) => c[1].headers["Idempotency-Key"]);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });

    it("does not attach a key to GET requests", async () => {
      const client = new AetherClient({ baseUrl: "http://localhost:9000" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ node_id: 0, documents: 0, vectors: 0 }));
      await client.status();
      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["Idempotency-Key"]).toBeUndefined();
    });
  });

  describe("insecure-URL enforcement", () => {
    it("throws when an API key is paired with http:// to a remote host", () => {
      expect(
        () => new AetherClient({ baseUrl: "http://api.aetherdb.ai", apiKey: "secret" }),
      ).toThrow(AetherError);
    });

    it.each([
      "http://localhost:9000",
      "http://127.0.0.1:9000",
      "https://api.aetherdb.ai",
    ])("allows %s with an API key", (baseUrl) => {
      expect(() => new AetherClient({ baseUrl, apiKey: "secret" })).not.toThrow();
    });

    it("allows http:// to a remote host when no API key is set", () => {
      expect(() => new AetherClient({ baseUrl: "http://api.aetherdb.ai" })).not.toThrow();
    });
  });
});
