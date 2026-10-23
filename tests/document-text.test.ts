import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient, isTextLikeContentType } from "../src/client.js";
import { Memory } from "../src/memory.js";
import { AetherApiError, AetherError } from "../src/errors.js";

// Transport-level mock: the real client and Memory code run end to end, and
// `fetch` answers by route so parallel reads can arrive in any order.
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

function newClient(): AetherClient {
  return new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
    maxRetries: 0,
  });
}

function documentText(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_id: "doc-1",
    content_type: "application/pdf",
    source: "passages",
    state: "ready",
    text: "# Master Services Agreement\n\nParsed text.",
    offset: 0,
    next_offset: null,
    total_bytes: 42,
    truncated: false,
    section: null,
    sections: null,
    ...overrides,
  };
}

type TextReply = { status: number; body?: unknown } | "download-only";

/**
 * Route the mock transport: one search hit / list record per call, then the
 * per-document read. Records which document routes were hit.
 */
function routeFetch(options: {
  search?: Record<string, unknown>;
  list?: Record<string, unknown>;
  download?: string;
  text?: TextReply;
}): { downloads: string[]; texts: string[] } {
  const seen = { downloads: [] as string[], texts: [] as string[] };
  mockFetch.mockImplementation(async (input: string) => {
    const url = new URL(input);
    if (url.pathname === "/v1/search") {
      return jsonResponse({ query: "q", results: [options.search] });
    }
    if (url.pathname === "/v1/documents") {
      return jsonResponse({
        documents: [options.list],
        count: 1,
        total: 1,
        has_more: false,
      });
    }
    const download = url.pathname.match(/^\/v1\/documents\/([^/]+)\/download$/);
    if (download) {
      seen.downloads.push(download[1]);
      return new Response(new TextEncoder().encode(options.download ?? ""), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    const text = url.pathname.match(/^\/v1\/documents\/([^/]+)\/text$/);
    if (text) {
      seen.texts.push(`${text[1]}${url.search}`);
      const reply = options.text ?? { status: 200, body: documentText() };
      if (reply === "download-only") throw new Error("/text must not be called");
      return jsonResponse(reply.body ?? { error: "not found", code: "document_not_found" }, reply.status);
    }
    throw new Error(`unexpected request ${input}`);
  });
  return seen;
}

function hit(contentType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_id: "doc-1",
    score: 90,
    content_type: contentType,
    passage: "the matched passage",
    tags: [],
    source: null,
    metadata: {},
    partition: null,
    ...extra,
  };
}

function record(contentType: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_id: "doc-1",
    cid: "",
    content_type: contentType,
    size_bytes: 10,
    version: 1,
    created_at: "2026-10-01T00:00:00Z",
    entity_id: "acme",
    ...extra,
  };
}

describe("getText", () => {
  it("maps options onto GET /v1/documents/{id}/text and parses the result", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        documentText({
          text: "## Agreed terms\n- Net 30\n",
          next_offset: 25,
          truncated: true,
          section: {
            heading: "Agreed terms",
            level: 2,
            slug: "agreed-terms",
            start_line: 4,
            end_line: 6,
            bytes: 71,
          },
        }),
      ),
    );
    const text = await newClient()
      .partition("client-a")
      .getText("doc 1", { section: "Agreed terms", offset: 0, maxBytes: 25 });

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/documents/doc%201/text");
    expect(url.searchParams.get("section")).toBe("Agreed terms");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("max_bytes")).toBe("25");
    expect(url.searchParams.get("partition")).toBe("client-a");
    expect(url.searchParams.has("outline")).toBe(false);
    expect((mockFetch.mock.calls[0][1] as RequestInit).method ?? "GET").toBe("GET");

    expect(text.source).toBe("passages");
    expect(text.next_offset).toBe(25);
    expect(text.truncated).toBe(true);
    expect(text.section?.slug).toBe("agreed-terms");
    expect(text.sections).toBeNull();
  });

  it("requests the outline and parses sections with a null next_offset", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        documentText({
          text: "",
          sections: [
            { heading: "Acme memory", level: 1, slug: "acme-memory", start_line: 1, end_line: 9, bytes: 122 },
          ],
        }),
      ),
    );
    const text = await newClient().getText("doc-1", { outline: true });
    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("outline")).toBe("true");
    expect(url.search).not.toContain("offset");
    expect(text.next_offset).toBeNull();
    expect(text.sections).toHaveLength(1);
    expect(text.sections?.[0].start_line).toBe(1);
  });

  it("rejects an empty doc id before any HTTP call", async () => {
    await expect(newClient().getText("")).rejects.toBeInstanceOf(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("surfaces section errors as AetherApiError with the server code", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "ambiguous",
          code: "document_section_ambiguous",
          candidates: [{ heading: "Notes", slug: "notes", start_line: 16 }],
        },
        409,
      ),
    );
    const err = await newClient().getText("doc-1", { section: "notes" }).catch((e) => e);
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err.status).toBe(409);
    expect(err.errorCode).toBe("document_section_ambiguous");
  });
});

describe("hydration (MEMORY_CONTRACT §25.6 / §27.5)", () => {
  it("classifies content types exactly as the golden table", () => {
    const textLike = [
      "text/plain",
      "text/markdown; charset=utf-8",
      "TEXT/MARKDOWN",
      "text/x-python",
      "application/json",
      "application/x-yaml",
    ];
    const notTextLike = [
      "text/html",
      "text/csv",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
      "",
    ];
    for (const ct of textLike) expect(isTextLikeContentType(ct), ct).toBe(true);
    for (const ct of notTextLike) expect(isTextLikeContentType(ct), ct).toBe(false);
    expect(isTextLikeContentType(undefined)).toBe(false);
  });

  const downloadRows = [
    "text/plain",
    "text/markdown; charset=utf-8",
    "TEXT/MARKDOWN",
    "text/x-python",
    "application/json",
    "application/x-yaml",
  ];
  for (const contentType of downloadRows) {
    it(`retrieve downloads ${JSON.stringify(contentType)}`, async () => {
      const seen = routeFetch({ search: hit(contentType), download: "original text", text: "download-only" });
      const [result] = await newClient().retrieve("q");
      expect(result.content).toBe("original text");
      expect(seen.downloads).toEqual(["doc-1"]);
      expect(seen.texts).toEqual([]);
    });
  }

  const textRows = [
    "text/html",
    "text/csv",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
    "",
  ];
  for (const contentType of textRows) {
    it(`retrieve reads ${JSON.stringify(contentType)} through /text, never /download`, async () => {
      const seen = routeFetch({ search: hit(contentType) });
      const [result] = await newClient().retrieve("q");
      expect(result.content).toBe("# Master Services Agreement\n\nParsed text.");
      expect(seen.downloads).toEqual([]);
      expect(seen.texts).toEqual(["doc-1?max_bytes=1048576"]);
    });

    it(`Memory.list reads ${JSON.stringify(contentType)} through /text`, async () => {
      const seen = routeFetch({ list: record(contentType) });
      const [item] = await new Memory("acme", { client: newClient() }).list();
      expect(item.text).toBe("# Master Services Agreement\n\nParsed text.");
      expect(seen.downloads).toEqual([]);
      expect(seen.texts).toHaveLength(1);
    });
  }

  it("falls back to the passage when a PDF's /text is unsupported", async () => {
    routeFetch({
      search: hit("application/pdf"),
      text: { status: 200, body: documentText({ state: "unsupported", source: null, text: "" }) },
    });
    const [result] = await newClient().retrieve("q");
    expect(result.content).toBe("the matched passage");
  });

  it("falls back to the passage on a 404 from an older server", async () => {
    const seen = routeFetch({ search: hit("application/pdf"), text: { status: 404 } });
    const [result] = await newClient().retrieve("q");
    expect(result.content).toBe("the matched passage");
    expect(seen.downloads).toEqual([]);
  });

  it("falls back to an empty string when the hit carries no passage", async () => {
    routeFetch({ search: hit("application/pdf", { passage: undefined }), text: { status: 404 } });
    const [result] = await newClient().retrieve("q");
    expect(result.content).toBe("");
  });

  it("Memory.recall uses the hydrated /text content for a PDF hit", async () => {
    const seen = routeFetch({ search: hit("application/pdf") });
    const [item] = await new Memory("acme", { client: newClient() }).recall("terms");
    expect(item.text).toBe("# Master Services Agreement\n\nParsed text.");
    expect(seen.downloads).toEqual([]);
  });

  it("Memory.list falls back to an empty string on unsupported or 404", async () => {
    routeFetch({
      list: record("application/pdf"),
      text: { status: 200, body: documentText({ state: "unsupported", source: null, text: "" }) },
    });
    const [unsupported] = await new Memory("acme", { client: newClient() }).list();
    expect(unsupported.text).toBe("");

    routeFetch({ list: record("application/pdf"), text: { status: 404 } });
    const [missing] = await new Memory("acme", { client: newClient() }).list();
    expect(missing.text).toBe("");
  });

  it("propagates errors other than 404", async () => {
    routeFetch({ search: hit("application/pdf"), text: { status: 500, body: { error: "boom" } } });
    await expect(newClient().retrieve("q")).rejects.toMatchObject({ status: 500 });
  });

  it("never reads media documents (image / audio use passage or derived_text)", async () => {
    for (const [contentType, modality] of [
      ["image/png", "image"],
      ["audio/mpeg", "audio"],
    ] as const) {
      const searched = routeFetch({ search: hit(contentType, { modality }), text: "download-only" });
      const [result] = await newClient().retrieve("q");
      expect(result.content).toBe("the matched passage");
      expect(searched.downloads).toEqual([]);

      const listed = routeFetch({
        list: record(contentType, { modality, derived_text: "a caption" }),
        text: "download-only",
      });
      const [item] = await new Memory("acme", { client: newClient() }).list();
      expect(item.text).toBe("a caption");
      expect(listed.downloads).toEqual([]);
    }
  });
});
