import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient, resolveContentType } from "../src/client.js";
import { AetherError } from "../src/errors.js";

const mockFetch = vi.fn();

let tmpDir: string;

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-ingest-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal document-record body the transport can return for a successful insert. */
function docResponse(docId: string): Response {
  return jsonResponse({
    doc_id: docId,
    cid: `cid-${docId}`,
    content_type: "text/plain",
    size_bytes: 1,
    chunks: 1,
    vectors: 1,
    version: 1,
  });
}

function write(name: string, content = "hello world"): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe("ingestion", () => {
  const client = new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
  });

  // ── resolveContentType ──────────────────────────────────────────────

  describe("resolveContentType", () => {
    it("resolves .md to text/markdown", () => {
      expect(resolveContentType("notes.md")).toBe("text/markdown");
      expect(resolveContentType("/a/b/NOTES.MD")).toBe("text/markdown");
    });

    it("resolves the explicit ingest map entries", () => {
      expect(resolveContentType("a.markdown")).toBe("text/markdown");
      expect(resolveContentType("a.txt")).toBe("text/plain");
      expect(resolveContentType("a.text")).toBe("text/plain");
      expect(resolveContentType("a.pdf")).toBe("application/pdf");
      expect(resolveContentType("a.csv")).toBe("text/csv");
      expect(resolveContentType("a.json")).toBe("application/json");
      expect(resolveContentType("a.html")).toBe("text/html");
      expect(resolveContentType("a.htm")).toBe("text/html");
    });

    it("returns undefined for an unknown / binary extension", () => {
      expect(resolveContentType("a.bin")).toBeUndefined();
      expect(resolveContentType("a.unknownext")).toBeUndefined();
    });
  });

  // ── ingestFiles ─────────────────────────────────────────────────────

  describe("ingestFiles", () => {
    it("ingests a markdown file and resolves text/markdown", async () => {
      const f = write("doc.md");
      mockFetch.mockResolvedValueOnce(docResponse("d1"));

      const results = await client.ingestFiles([f]);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        path: f,
        status: "ingested",
        docId: "d1",
        contentType: "text/markdown",
      });
      // content_type must have been sent to the engine as text/markdown.
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("content_type=text%2Fmarkdown");
    });

    it("reports ingested + skipped in a mixed batch (one 422-rejected file)", async () => {
      const good = write("good.md");
      const bad = write("bad.bin");
      // First insert succeeds; second is rejected by the engine with a 422.
      mockFetch
        .mockResolvedValueOnce(docResponse("ok1"))
        .mockResolvedValueOnce(
          jsonResponse({ error: "unsupported or binary content" }, 422),
        );

      const results = await client.ingestFiles([good, bad]);

      expect(results).toHaveLength(2);
      // Results come back in input order.
      expect(results[0]).toMatchObject({
        path: good,
        status: "ingested",
        docId: "ok1",
      });
      expect(results[1].path).toBe(bad);
      expect(results[1].status).toBe("skipped");
      expect(results[1].docId).toBeUndefined();
      expect(results[1].error).toContain("unsupported or binary content");
    });

    it.each([413, 415, 422])(
      "reports status %i as skipped",
      async (status) => {
        const f = write("f.png", "binary");
        mockFetch.mockResolvedValueOnce(jsonResponse({ error: "nope" }, status));
        const [res] = await client.ingestFiles([f]);
        expect(res.status).toBe("skipped");
      },
    );

    it("reports a non-reject API error (500) as error, not skipped", async () => {
      const f = write("f.txt");
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
      const [res] = await client.ingestFiles([f]);
      expect(res.status).toBe("error");
      expect(res.error).toContain("boom");
    });

    it("reports a file-read failure as error", async () => {
      const missing = path.join(tmpDir, "does-not-exist.txt");
      const results = await client.ingestFiles([missing]);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(results[0].status).toBe("error");
      expect(results[0].path).toBe(missing);
    });

    it("re-throws on a rejected file when raiseOnError is true", async () => {
      const f = write("bad.bin");
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "nope" }, 422));
      await expect(
        client.ingestFiles([f], { raiseOnError: true }),
      ).rejects.toThrow();
    });

    it("forwards tags, chunking, entityId and source to the insert", async () => {
      const f = write("doc.txt");
      mockFetch.mockResolvedValueOnce(docResponse("d1"));

      await client.ingestFiles([f], {
        tags: ["a", "b"],
        chunking: { chunkSize: 256, overlap: 32 },
        entityId: "user-7",
        source: "notion",
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("tags=a%2Cb");
      expect(url).toContain("chunk_size=256");
      expect(url).toContain("overlap=32");
      expect(url).toContain("entity_id=user-7");
      expect(url).toContain("source=notion");
    });
  });

  // ── ingestDirectory ─────────────────────────────────────────────────

  describe("ingestDirectory", () => {
    it("throws when the path is not a directory", async () => {
      const f = write("not-a-dir.txt");
      await expect(client.ingestDirectory(f)).rejects.toThrow(AetherError);
      await expect(
        client.ingestDirectory(path.join(tmpDir, "missing")),
      ).rejects.toThrow(AetherError);
    });

    it("recurses by default and ingests every file", async () => {
      write("top.md");
      write("nested/deep.md");
      mockFetch
        .mockResolvedValueOnce(docResponse("a"))
        .mockResolvedValueOnce(docResponse("b"));

      const results = await client.ingestDirectory(tmpDir);

      expect(results.map((r) => r.status)).toEqual(["ingested", "ingested"]);
      // Sorted by path: the nested file sorts before the top-level one.
      expect(results.map((r) => path.basename(r.path))).toEqual([
        "deep.md",
        "top.md",
      ]);
    });

    it("only walks the top level when recursive is false", async () => {
      write("top.md");
      write("nested/deep.md");
      mockFetch.mockResolvedValueOnce(docResponse("a"));

      const results = await client.ingestDirectory(tmpDir, { recursive: false });

      expect(results).toHaveLength(1);
      expect(path.basename(results[0].path)).toBe("top.md");
    });

    it("filters by extension (leading dots and case optional)", async () => {
      write("keep.md");
      write("keep2.markdown");
      write("drop.txt");
      write("drop.bin");
      // Two matches expected -> two inserts.
      mockFetch
        .mockResolvedValueOnce(docResponse("a"))
        .mockResolvedValueOnce(docResponse("b"));

      const results = await client.ingestDirectory(tmpDir, {
        // Mixed forms: no dot, upper case, extra dot.
        extensions: ["md", ".MARKDOWN"],
      });

      expect(results.map((r) => path.basename(r.path)).sort()).toEqual([
        "keep.md",
        "keep2.markdown",
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("forwards a 422 reject as skipped in a directory batch", async () => {
      write("good.md");
      write("bad.md");
      // Files are ingested in sorted path order, so "bad.md" is inserted before
      // "good.md"; the first mocked response (the 422) lands on bad.md.
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "nope" }, 422))
        .mockResolvedValueOnce(docResponse("ok"));

      const results = await client.ingestDirectory(tmpDir, {
        extensions: [".md"],
      });

      const byName = Object.fromEntries(
        results.map((r) => [path.basename(r.path), r.status]),
      );
      expect(byName["good.md"]).toBe("ingested");
      expect(byName["bad.md"]).toBe("skipped");
    });
  });
});
