import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AetherClient,
  formatIfMatch,
  parseEtagVersion,
  validateMemoryFileName,
} from "../src/client.js";
import { Memory } from "../src/memory.js";
import {
  AetherApiError,
  AetherError,
  CreditExhaustedError,
  VersionConflictError,
} from "../src/errors.js";

// Transport-level mock: the real client, Memory and MemoryFiles code run end to
// end; `fetch` records every request and answers from a queue.
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
});

const OWNER = "scoped:ws_42:company:c_7";
const PARTITION = "scoped-ws_42";

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  json: unknown;
}

/** Answer each request with the next reply (the last one repeats) and record it. */
function respond(...replies: Reply[]): Recorded[] {
  const calls: Recorded[] = [];
  mockFetch.mockImplementation(async (input: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : undefined;
    let json: unknown;
    try {
      json = body === undefined ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    calls.push({
      url: new URL(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
      json,
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    const status = reply.status ?? 200;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status,
      statusText: status < 300 ? "OK" : "Error",
      headers: { "Content-Type": "application/json", ...(reply.headers ?? {}) },
    });
  });
  return calls;
}

function newClient(maxRetries = 0): AetherClient {
  return new AetherClient({
    baseUrl: "http://localhost:9000",
    apiKey: "aether_testkey123",
    maxRetries,
    retryBaseDelay: 0.001,
  });
}

function newMemory(client: AetherClient = newClient()): Memory {
  return new Memory(OWNER, { client });
}

/** Golden vector A outline. */
const VECTOR_A_SECTIONS = [
  { heading: "Acme memory", level: 1, slug: "acme-memory", start_line: 1, end_line: 9, bytes: 122 },
  { heading: "Agreed terms", level: 2, slug: "agreed-terms", start_line: 4, end_line: 6, bytes: 71 },
  { heading: "Exceptions", level: 2, slug: "exceptions", start_line: 7, end_line: 8, bytes: 15 },
  { heading: "Notes", level: 2, slug: "notes", start_line: 9, end_line: 9, bytes: 9 },
];

function info(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity_id: OWNER,
    partition: PARTITION,
    name: "memory.md",
    file_id: "3d1f0000-0000-4000-8000-000000000000",
    doc_id: "a8c20000-0000-4000-8000-000000000000",
    version: 7,
    bytes: 122,
    content_hash: "blake3:9f00",
    author: "scoped:ws_42:user:u_3",
    principal: "key:ak_1a2b3c4d",
    op: "append_section",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-10-10T09:12:44Z",
    ...overrides,
  };
}

/** The read example: section "Agreed terms" of version 7. */
function readBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...info(),
    is_current: true,
    content: "## Agreed terms\n- 2026-09-01 — Net 30 payment terms (alice, ISS-12)\n\n",
    section: VECTOR_A_SECTIONS[1],
    offset: 0,
    next_offset: null,
    total_bytes: 71,
    truncated: false,
    sections: VECTOR_A_SECTIONS,
    ...overrides,
  };
}

function writeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...info(),
    unchanged: false,
    previous_version: 6,
    file_created: false,
    section: null,
    section_created: false,
    sections: VECTOR_A_SECTIONS,
    ...overrides,
  };
}

function summaryBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_id: "doc-1",
    state: "ready",
    reason: null,
    error: null,
    summary_doc_id: "sum-1",
    content: "## Summary\n- A master services agreement.\n",
    revision: "r3f9a1c2b7d4e5f60",
    authored_by: "aether",
    generator: "aether:model-x:2026-10-10.v1",
    prompt_version: "2026-10-10.v1",
    generated_at: "2026-10-10T09:00:00Z",
    source_cid: "cid-1",
    stale: false,
    truncated_input: false,
    ...overrides,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ACCEPTED_NAMES = [
  "memory.md",
  "a",
  "A",
  "0",
  "a.",
  "Grep",
  "grep.md",
  "notes_2026-10.md",
  "x.y.z",
  "abcdefghijklmnopqrstuvwxyz".repeat(4) + "abcdefghijklmnopqrstuvwx",
];

const REJECTED_NAMES = [
  "",
  ".hidden",
  "-x",
  "_x",
  ".",
  "..",
  "a..b",
  "a...b",
  "a/b",
  "a b",
  "a\\b",
  "memory.md ",
  "naïve.md",
  "grep",
  "abcdefghijklmnopqrstuvwxyz".repeat(4) + "abcdefghijklmnopqrstuvwxy",
  // Not a golden vector: a trailing newline must not slip past an anchored regex.
  "memory.md\n",
];

describe("memory-file names (golden)", () => {
  it("the 128- and 129-char vectors have the expected lengths", () => {
    expect(ACCEPTED_NAMES[ACCEPTED_NAMES.length - 1]).toHaveLength(128);
    expect(REJECTED_NAMES[REJECTED_NAMES.length - 2]).toHaveLength(129);
  });

  it.each(ACCEPTED_NAMES)("accepts %j", (name) => {
    expect(() => validateMemoryFileName(name)).not.toThrow();
  });

  it.each(REJECTED_NAMES)("rejects %j without any HTTP call", async (name) => {
    respond({ body: readBody() });
    expect(() => validateMemoryFileName(name)).toThrow(AetherError);
    const memory = newMemory();
    await expect(memory.files.read(name)).rejects.toThrow(/invalid memory file name/);
    await expect(memory.files.write(name, "x", { create: true })).rejects.toThrow(AetherError);
    await expect(memory.files.delete(name)).rejects.toThrow(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("accepted names reach the right route", async () => {
    const calls = respond({ body: readBody() });
    await newMemory().files.read("notes_2026-10.md");
    expect(calls[0].url.pathname).toBe("/v1/memory/files/notes_2026-10.md");
  });
});

describe("precondition headers (golden)", () => {
  it.each([
    [7, '"7"'],
    [1, '"1"'],
    [123456, '"123456"'],
  ])("write expectedVersion %d sends If-Match %s", async (version, header) => {
    const calls = respond({ body: writeBody() });
    await newMemory().files.write("memory.md", "# Acme\n", { expectedVersion: version });
    expect(calls[0].headers["If-Match"]).toBe(header);
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();
  });

  it("write create sends If-None-Match: * and no If-Match", async () => {
    const calls = respond({ status: 201, body: writeBody({ file_created: true, previous_version: null, version: 1 }) });
    await newMemory().files.write("memory.md", "# Acme\n", { create: true });
    expect(calls[0].headers["If-None-Match"]).toBe("*");
    expect(calls[0].headers["If-Match"]).toBeUndefined();
  });

  it.each([
    [{}],
    [{ create: false }],
    [{ expectedVersion: 3, create: true }],
  ])("write rejects precondition %j client-side", async (options) => {
    respond({ body: writeBody() });
    await expect(newMemory().files.write("memory.md", "x", options)).rejects.toThrow(
      /exactly one of expectedVersion or create/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])("rejects expectedVersion %d", async (version) => {
    respond({ body: writeBody() });
    const files = newMemory().files;
    await expect(files.write("memory.md", "x", { expectedVersion: version })).rejects.toThrow(
      /expectedVersion must be an integer >= 1/,
    );
    await expect(files.append("memory.md", "x", { expectedVersion: version })).rejects.toThrow(AetherError);
    await expect(files.delete("memory.md", { expectedVersion: version })).rejects.toThrow(AetherError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("append sends no precondition unless expectedVersion is given", async () => {
    const calls = respond({ body: writeBody() });
    const files = newMemory().files;
    await files.append("memory.md", "- a");
    await files.append("memory.md", "- b", { expectedVersion: 3 });
    expect(calls[0].headers["If-Match"]).toBeUndefined();
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();
    expect(calls[1].headers["If-Match"]).toBe('"3"');
  });

  it("replaceSection without a precondition fails client-side (P12)", async () => {
    respond({ body: writeBody() });
    await expect(
      newMemory().files.replaceSection("memory.md", "Notes", "- n1"),
    ).rejects.toThrow(/exactly one of expectedVersion or create/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("replaceSection create sends If-None-Match: *", async () => {
    const calls = respond({ status: 201, body: writeBody({ file_created: true }) });
    await newMemory().files.replaceSection("memory.md", "Notes", "- n1", { create: true });
    expect(calls[0].headers["If-None-Match"]).toBe("*");
  });

  it("delete expectedVersion sends If-Match", async () => {
    const calls = respond({
      body: { entity_id: OWNER, partition: null, name: "memory.md", file_id: "f", version: 4, hard: false, versions_deleted: 1 },
    });
    await newMemory().files.delete("memory.md", { expectedVersion: 4 });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].headers["If-Match"]).toBe('"4"');
  });

  it("putSummary expectedRevision sends If-Match", async () => {
    const calls = respond({ body: summaryBody({ authored_by: "user" }) });
    await newClient().putSummary("doc-1", "## Summary\n", { expectedRevision: "r3f9a1c2b7d4e5f60" });
    expect(calls[0].headers["If-Match"]).toBe('"r3f9a1c2b7d4e5f60"');
  });

  it("formats and parses entity tags", () => {
    expect(formatIfMatch(7)).toBe('"7"');
    expect(formatIfMatch("r1")).toBe('"r1"');
    expect(parseEtagVersion('"7"')).toBe(7);
    expect(parseEtagVersion('"123456"')).toBe(123456);
    expect(parseEtagVersion("7")).toBe(7);
    expect(parseEtagVersion('W/"7"')).toBe(7);
    expect(parseEtagVersion('"abc"')).toBeNull();
    expect(parseEtagVersion(null)).toBeNull();
  });
});

describe("Idempotency-Key on writes", () => {
  it("is sent on PUT and every PATCH op, fresh per call", async () => {
    const calls = respond({ body: writeBody() });
    const files = newMemory().files;
    await files.write("memory.md", "x", { expectedVersion: 7 });
    await files.append("memory.md", "x");
    await files.appendSection("memory.md", "Notes", "x");
    await files.replaceSection("memory.md", "Notes", "x", { expectedVersion: 7 });
    const keys = calls.map((c) => c.headers["Idempotency-Key"]);
    for (const key of keys) expect(key).toMatch(UUID_RE);
    expect(new Set(keys).size).toBe(4);
  });

  it("is reused verbatim when the write is retried after 503 memory_file_busy", async () => {
    const calls = respond(
      {
        status: 503,
        body: { error: "file busy", code: "memory_file_busy" },
        headers: { "Retry-After": "0" },
      },
      { body: writeBody() },
    );
    const result = await newMemory(newClient(1)).files.append("memory.md", "- once");
    expect(result.version).toBe(7);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["Idempotency-Key"]).toMatch(UUID_RE);
    expect(calls[1].headers["Idempotency-Key"]).toBe(calls[0].headers["Idempotency-Key"]);
  });

  it("uses a caller-supplied key", async () => {
    const calls = respond({ body: writeBody() });
    await newMemory().files.write("memory.md", "x", { create: true, idempotencyKey: "my-key-1" });
    expect(calls[0].headers["Idempotency-Key"]).toBe("my-key-1");
  });

  it("is not sent on read or delete", async () => {
    const calls = respond({ body: readBody() });
    const files = newMemory().files;
    await files.read("memory.md");
    await files.delete("memory.md");
    expect(calls[0].headers["Idempotency-Key"]).toBeUndefined();
    expect(calls[1].headers["Idempotency-Key"]).toBeUndefined();
  });
});

describe("version conflicts and error passthrough", () => {
  it("412 memory_file_version_conflict is a VersionConflictError with currentVersion", async () => {
    respond({
      status: 412,
      body: { error: "version conflict", code: "memory_file_version_conflict", current_version: 8, request_id: "req-1" },
    });
    const err = await newMemory()
      .files.write("memory.md", "x", { expectedVersion: 7 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err).toBeInstanceOf(AetherApiError);
    const conflict = err as VersionConflictError;
    expect(conflict.currentVersion).toBe(8);
    expect(conflict.status).toBe(412);
    expect(conflict.errorCode).toBe("memory_file_version_conflict");
  });

  it("currentVersion is null when the file does not exist", async () => {
    respond({
      status: 412,
      body: { error: "version conflict", code: "memory_file_version_conflict", current_version: null },
    });
    const err = await newMemory()
      .files.replaceSection("memory.md", "Notes", "x", { expectedVersion: 2 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect((err as VersionConflictError).currentVersion).toBeNull();
  });

  it("402 credit_exhausted from a memory-file write keeps its typed error", async () => {
    respond({ status: 402, body: { error: "top up", code: "credit_exhausted" } });
    await expect(newMemory().files.append("memory.md", "x")).rejects.toBeInstanceOf(
      CreditExhaustedError,
    );
  });

  it.each([
    [428, "precondition_required", {}],
    [409, "memory_file_section_ambiguous", { candidates: [{ heading: "Notes", slug: "notes", start_line: 16 }] }],
    [404, "feature_not_enabled", { feature: "memory_files" }],
    [404, "memory_file_not_found", {}],
    [413, "memory_file_too_large", { limit_bytes: 524288 }],
    [412, "summary_revision_conflict", { current_revision: "r2" }],
  ])("%d %s surfaces as the base API error", async (status, code, extra) => {
    respond({ status, body: { error: "nope", code, ...extra } });
    const err = await newMemory()
      .files.appendSection("memory.md", "Notes", "x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).not.toBeInstanceOf(VersionConflictError);
    expect((err as AetherApiError).status).toBe(status);
    expect((err as AetherApiError).errorCode).toBe(code);
    if (code === "memory_file_section_ambiguous") {
      expect((err as AetherApiError).body).toMatchObject({ candidates: [{ slug: "notes" }] });
    }
  });
});

describe("MemoryFiles requests", () => {
  it("scopes facade calls to the entity and the client's partition", async () => {
    const calls = respond({ body: readBody() });
    const files = newMemory(newClient().partition(PARTITION)).files;
    await files.read("memory.md");
    await files.write("memory.md", "x", { expectedVersion: 7 });
    await files.list();
    await files.delete("memory.md");
    for (const call of calls) {
      expect(call.url.searchParams.get("entity_id")).toBe(OWNER);
      expect(call.url.searchParams.get("partition")).toBe(PARTITION);
    }
    respond({ body: { matches: [], truncated: false, truncated_reason: null, files_scanned: 0, bytes_scanned: 0 } });
    const grepCalls = mockFetch.mock.calls;
    await files.grep("net");
    const [url, init] = grepCalls[grepCalls.length - 1] as [string, RequestInit];
    expect(new URL(url).searchParams.get("partition")).toBe(PARTITION);
    expect(JSON.parse(init.body as string).entity_id).toBe(OWNER);
  });

  it("read parses the MemoryFile and maps every option to the query", async () => {
    const calls = respond({ body: readBody(), headers: { ETag: '"7"' } });
    const file = await newMemory().files.read("memory.md", {
      version: 7,
      section: "Agreed terms",
      offset: 0,
      maxBytes: 4096,
    });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v1/memory/files/memory.md");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      entity_id: OWNER,
      version: "7",
      section: "Agreed terms",
      offset: "0",
      max_bytes: "4096",
    });
    expect(file.version).toBe(7);
    expect(file.is_current).toBe(true);
    expect(file.content).toBe("## Agreed terms\n- 2026-09-01 — Net 30 payment terms (alice, ISS-12)\n\n");
    expect(file.section).toEqual(VECTOR_A_SECTIONS[1]);
    expect(file.sections).toEqual(VECTOR_A_SECTIONS);
    expect(file.next_offset).toBeNull();
    expect(file.truncated).toBe(false);
    expect(file.total_bytes).toBe(71);
    expect(file.partition).toBe(PARTITION);
  });

  it("read with outline sends outline=true", async () => {
    const calls = respond({ body: readBody({ content: "", section: null }) });
    await newMemory().files.read("memory.md", { outline: true });
    expect(calls[0].url.searchParams.get("outline")).toBe("true");
    expect(calls[0].url.searchParams.has("section")).toBe(false);
  });

  it("read takes the version from the ETag when the body omits it", async () => {
    const body = readBody();
    delete body.version;
    respond({ body, headers: { ETag: '"7"' } });
    const file = await newMemory().files.read("memory.md");
    expect(file.version).toBe(7);
  });

  it("write sends the raw content as markdown with the author label", async () => {
    const calls = respond({
      status: 201,
      body: writeBody({ version: 1, previous_version: null, file_created: true, op: "put" }),
      headers: { ETag: '"1"' },
    });
    const content = "# Acme memory\nIntro line.\n";
    const result = await newMemory().files.write("memory.md", content, {
      create: true,
      author: "scoped:ws_42:user:u_3",
    });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toBe(content);
    expect(calls[0].headers["Content-Type"]).toBe("text/markdown; charset=utf-8");
    expect(calls[0].url.searchParams.get("author")).toBe("scoped:ws_42:user:u_3");
    expect(result.file_created).toBe(true);
    expect(result.previous_version).toBeNull();
    expect(result.version).toBe(1);
    expect(result.sections).toEqual(VECTOR_A_SECTIONS);
  });

  it("parses an unchanged (no-op) write", async () => {
    respond({ body: writeBody({ unchanged: true, previous_version: 7 }) });
    const result = await newMemory().files.write("memory.md", "same", { expectedVersion: 7 });
    expect(result.unchanged).toBe(true);
    expect(result.version).toBe(7);
  });

  it("appendSection sends exactly the PATCH body with explicit defaults", async () => {
    const calls = respond({ body: writeBody() });
    await newMemory().files.appendSection("memory.md", "Agreed terms", "x");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].json).toEqual({
      op: "append_section",
      section: "Agreed terms",
      content: "x",
      level: 2,
      create_if_missing: true,
    });
  });

  it("append sends no section or level", async () => {
    const calls = respond({ body: writeBody({ op: "append" }) });
    await newMemory().files.append("memory.md", "trailing", { author: "bot" });
    expect(calls[0].json).toEqual({ op: "append", content: "trailing", create_if_missing: true });
    expect(calls[0].url.searchParams.get("author")).toBe("bot");
  });

  it("maps the golden PATCH request shapes", async () => {
    const calls = respond(
      { body: writeBody() },
      {
        status: 201,
        body: writeBody({ section_created: true, section: { heading: "Key decisions", level: 2, slug: "key-decisions", start_line: 11, end_line: 12, bytes: 42 } }),
      },
      { body: writeBody({ op: "replace_section" }) },
      { body: writeBody({ op: "replace_section" }) },
    );
    const files = newMemory().files;
    // P1
    await files.appendSection("memory.md", "Agreed terms", "- 2026-10-10 — Net 45 for EU entities (bob, PRJ-3)");
    // P3
    const created = await files.appendSection("memory.md", "Key decisions", "- Use Stripe for billing");
    // P4
    await files.replaceSection("memory.md", "agreed-terms", "- Net 60", { expectedVersion: 7 });
    // explicit level / createIfMissing
    await files.replaceSection("memory.md", "Open items", "", {
      expectedVersion: 7,
      level: 3,
      createIfMissing: false,
    });
    expect(calls[0].json).toEqual({
      op: "append_section",
      section: "Agreed terms",
      content: "- 2026-10-10 — Net 45 for EU entities (bob, PRJ-3)",
      level: 2,
      create_if_missing: true,
    });
    expect(calls[1].json).toEqual({
      op: "append_section",
      section: "Key decisions",
      content: "- Use Stripe for billing",
      level: 2,
      create_if_missing: true,
    });
    expect(created.section_created).toBe(true);
    expect(created.section?.slug).toBe("key-decisions");
    expect(calls[2].json).toEqual({
      op: "replace_section",
      section: "agreed-terms",
      content: "- Net 60",
      level: 2,
      create_if_missing: true,
    });
    expect(calls[2].headers["If-Match"]).toBe('"7"');
    expect(calls[3].json).toEqual({
      op: "replace_section",
      section: "Open items",
      content: "",
      level: 3,
      create_if_missing: false,
    });
  });

  it("list maps prefix, limit and cursor and parses the page", async () => {
    const calls = respond({
      body: { files: [info({ partition: null, author: null })], next_cursor: "c2" },
    });
    const page = await newMemory().files.list({ prefix: "mem", limit: 10, cursor: "c1" });
    expect(calls[0].url.pathname).toBe("/v1/memory/files");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      entity_id: OWNER,
      prefix: "mem",
      limit: "10",
      cursor: "c1",
    });
    expect(page.next_cursor).toBe("c2");
    expect(page.files[0].name).toBe("memory.md");
    expect(page.files[0].partition).toBeNull();
    expect(page.files[0].author).toBeNull();
  });

  it("versions maps limit and parses the history", async () => {
    const calls = respond({
      body: {
        entity_id: OWNER,
        partition: null,
        name: "memory.md",
        file_id: "f-1",
        current_version: 7,
        versions: [
          { doc_id: "d7", version: 7, bytes: 122, content_hash: "blake3:aa", author: null, principal: "key:ak_1", op: "append_section", updated_at: "2026-10-10T09:12:44Z", is_current: true },
          { doc_id: "d6", version: 6, bytes: 100, content_hash: "blake3:bb", author: "bob", principal: "key:ak_1", op: "put", updated_at: "2026-10-09T09:12:44Z", is_current: false },
        ],
      },
    });
    const versions = await newMemory().files.versions("memory.md", { limit: 2 });
    expect(calls[0].url.pathname).toBe("/v1/memory/files/memory.md/versions");
    expect(calls[0].url.searchParams.get("limit")).toBe("2");
    expect(versions.current_version).toBe(7);
    expect(versions.versions.map((v) => v.version)).toEqual([7, 6]);
    expect(versions.versions[0].is_current).toBe(true);
  });

  it("diff sends context=3 by default and from/to when given", async () => {
    const diffBody = {
      entity_id: OWNER,
      partition: null,
      name: "memory.md",
      file_id: "f-1",
      from_version: 6,
      to_version: 7,
      context: 3,
      diff: "--- memory.md@v6\n+++ memory.md@v7\n@@ -4,3 +4,4 @@\n",
      added_lines: 1,
      removed_lines: 0,
      approximate: false,
      truncated: false,
    };
    const calls = respond({ body: diffBody });
    const files = newMemory().files;
    const diff = await files.diff("memory.md");
    await files.diff("memory.md", { from: 0, to: 7, context: 1 });
    expect(calls[0].url.pathname).toBe("/v1/memory/files/memory.md/diff");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ entity_id: OWNER, context: "3" });
    expect(Object.fromEntries(calls[1].url.searchParams)).toEqual({
      entity_id: OWNER,
      from: "0",
      to: "7",
      context: "1",
    });
    expect(diff.diff.startsWith("--- memory.md@v6")).toBe(true);
    expect(diff.added_lines).toBe(1);
  });

  it.each([
    [{ from: -1 }, /from must be an integer >= 0/],
    [{ to: 0 }, /to must be an integer >= 1/],
  ])("diff rejects %j client-side", async (options, message) => {
    respond({ body: {} });
    await expect(newMemory().files.diff("memory.md", options)).rejects.toThrow(message);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("grep sends every default and files only when given", async () => {
    const grepBody = {
      matches: [
        {
          entity_id: OWNER,
          partition: PARTITION,
          name: "memory.md",
          version: 7,
          line: 5,
          section: "Agreed terms",
          section_slug: "agreed-terms",
          text: "- 2026-09-01 — Net 30 payment terms (alice, ISS-12)",
          before: ["## Agreed terms"],
          after: [""],
        },
      ],
      truncated: false,
      truncated_reason: null,
      files_scanned: 1,
      bytes_scanned: 122,
    };
    const calls = respond({ body: grepBody });
    const files = newMemory().files;
    const result = await files.grep("net");
    await files.grep("net\\s+\\d+", {
      regex: true,
      ignoreCase: true,
      files: ["memory.md"],
      context: 1,
      maxMatches: 10,
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v1/memory/files/grep");
    expect(calls[0].json).toEqual({
      entity_id: OWNER,
      pattern: "net",
      regex: false,
      ignore_case: false,
      context: 0,
      max_matches: 100,
    });
    expect(calls[1].json).toEqual({
      entity_id: OWNER,
      pattern: "net\\s+\\d+",
      regex: true,
      ignore_case: true,
      files: ["memory.md"],
      context: 1,
      max_matches: 10,
    });
    expect(result.matches[0]).toMatchObject({ line: 5, section_slug: "agreed-terms", before: ["## Agreed terms"] });
    expect(result.files_scanned).toBe(1);
    expect(result.truncated_reason).toBeNull();
  });

  it("delete maps hard=true and parses the result", async () => {
    const calls = respond({
      body: { entity_id: OWNER, partition: null, name: "memory.md", file_id: "f-1", version: 7, hard: true, versions_deleted: 7 },
    });
    const files = newMemory().files;
    const result = await files.delete("memory.md", { hard: true });
    await files.delete("memory.md");
    expect(calls[0].url.searchParams.get("hard")).toBe("true");
    expect(calls[1].url.searchParams.has("hard")).toBe(false);
    expect(result.versions_deleted).toBe(7);
    expect(result.hard).toBe(true);
  });

  it("rejects blank sections, empty content and empty patterns client-side", async () => {
    respond({ body: writeBody() });
    const files = newMemory().files;
    await expect(files.append("memory.md", "")).rejects.toThrow(/content must be non-empty/);
    await expect(files.appendSection("memory.md", "Notes", "")).rejects.toThrow(/content must be non-empty/);
    await expect(files.appendSection("memory.md", "  ", "x")).rejects.toThrow(/section must be a non-blank/);
    await expect(
      files.replaceSection("memory.md", "", "x", { expectedVersion: 1 }),
    ).rejects.toThrow(/section must be a non-blank/);
    await expect(files.grep("")).rejects.toThrow(/pattern must be non-empty/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("cross-entity memory files", () => {
  it("listMemoryFiles sends entity_prefix and no entity_id", async () => {
    const calls = respond({ body: { files: [], next_cursor: null } });
    const page = await newClient().partition(PARTITION).listMemoryFiles({
      entityPrefix: "scoped:ws_42:company:",
    });
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      entity_prefix: "scoped:ws_42:company:",
      partition: PARTITION,
    });
    expect(page.files).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it("grepMemoryFiles puts entity_prefix in the body", async () => {
    const calls = respond({ body: { matches: [], truncated: true, truncated_reason: "max_files", files_scanned: 500, bytes_scanned: 9 } });
    const result = await newClient().grepMemoryFiles("Net 30", { entityPrefix: "scoped:ws_42:company:" });
    expect(calls[0].json).toEqual({
      entity_prefix: "scoped:ws_42:company:",
      pattern: "Net 30",
      regex: false,
      ignore_case: false,
      context: 0,
      max_matches: 100,
    });
    expect(result.truncated_reason).toBe("max_files");
  });

  it("rejects entityId together with entityPrefix", async () => {
    respond({ body: {} });
    const client = newClient();
    await expect(
      client.listMemoryFiles({ entityId: OWNER, entityPrefix: "scoped:" }),
    ).rejects.toThrow(/mutually exclusive/);
    await expect(
      client.grepMemoryFiles("x", { entityId: OWNER, entityPrefix: "scoped:" }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("document summaries", () => {
  it("getSummary parses a ready summary", async () => {
    const calls = respond({ body: summaryBody(), headers: { ETag: '"r3f9a1c2b7d4e5f60"' } });
    const summary = await newClient().getSummary("doc-1");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v1/documents/doc-1/summary");
    expect(summary).toEqual(summaryBody());
  });

  it("getSummary defaults the fields of a bare 'none' state", async () => {
    respond({ body: { doc_id: "doc-1", state: "none" } });
    const summary = await newClient().getSummary("doc-1");
    expect(summary.state).toBe("none");
    expect(summary.content).toBeNull();
    expect(summary.revision).toBeNull();
    expect(summary.authored_by).toBeNull();
    expect(summary.stale).toBe(false);
    expect(summary.truncated_input).toBe(false);
  });

  it("sends the partition guard on a partition handle", async () => {
    const calls = respond({ body: summaryBody() });
    await newClient().partition(PARTITION).getSummary("doc-1");
    expect(calls[0].url.searchParams.get("partition")).toBe(PARTITION);
  });

  it("putSummary sends a JSON body without an Idempotency-Key", async () => {
    const calls = respond({ status: 201, body: summaryBody({ authored_by: "user", generator: "user:key:ak_1" }) });
    const summary = await newClient().putSummary("doc-1", "## Summary\nMine.\n");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].json).toEqual({ content: "## Summary\nMine.\n" });
    expect(calls[0].headers["If-Match"]).toBeUndefined();
    expect(calls[0].headers["Idempotency-Key"]).toBeUndefined();
    expect(summary.authored_by).toBe("user");
  });

  it("regenerateSummary posts force=true and parses the 202", async () => {
    const calls = respond({ status: 202, body: summaryBody({ state: "pending" }) });
    const client = newClient();
    const summary = await client.regenerateSummary("doc-1", { force: true });
    await client.regenerateSummary("doc-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v1/documents/doc-1/summary");
    expect(calls[0].url.searchParams.get("force")).toBe("true");
    expect(calls[1].url.searchParams.has("force")).toBe(false);
    expect(summary.state).toBe("pending");
  });

  it("409 summary_user_authored is a base API error", async () => {
    respond({ status: 409, body: { error: "user summary", code: "summary_user_authored" } });
    const err = await newClient().regenerateSummary("doc-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AetherApiError);
    expect((err as AetherApiError).errorCode).toBe("summary_user_authored");
  });

  it("validates docId and expectedRevision client-side", async () => {
    respond({ body: summaryBody() });
    const client = newClient();
    await expect(client.getSummary("")).rejects.toThrow(/docId is required/);
    await expect(client.putSummary("", "x")).rejects.toThrow(/docId is required/);
    await expect(client.regenerateSummary("")).rejects.toThrow(/docId is required/);
    await expect(client.putSummary("doc-1", "x", { expectedRevision: "" })).rejects.toThrow(
      /expectedRevision must be non-empty/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

function docRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_id: "doc-1",
    cid: "cid-1",
    content_type: "text/plain",
    size_bytes: 5,
    chunks: 1,
    vectors: 1,
    version: 1,
    tags: [],
    metadata: {},
    ...overrides,
  };
}

describe("summarize at ingest", () => {
  it("insertText sends summarize only when set, and parses summary", async () => {
    const calls = respond({ body: docRecord({ summary: "pending" }) });
    const client = newClient();
    const record = await client.insertText("hello", { summarize: true });
    await client.insertText("hello", { summarize: false });
    await client.insertText("hello");
    expect(calls[0].url.searchParams.get("summarize")).toBe("true");
    expect(calls[1].url.searchParams.get("summarize")).toBe("false");
    expect(calls[2].url.searchParams.has("summarize")).toBe(false);
    expect(record.summary).toBe("pending");
  });

  it("insert, insertAsync and insertStream forward summarize", async () => {
    const calls = respond({ body: docRecord({ summary: "skipped" }) });
    const client = newClient();
    const record = await client.insert(new TextEncoder().encode("x"), { filename: "a.pdf", summarize: true });
    await client.insertAsync(new TextEncoder().encode("x"), { filename: "a.pdf", summarize: false });
    await client.insertStream(new Blob(["x"]).stream(), { summarize: true });
    expect(record.summary).toBe("skipped");
    expect(calls[0].url.searchParams.get("summarize")).toBe("true");
    expect(calls[1].url.pathname).toBe("/v1/documents/async");
    expect(calls[1].url.searchParams.get("summarize")).toBe("false");
    expect(calls[2].url.searchParams.get("summarize")).toBe("true");
  });

  it("batchInsert sends batch-level and per-item summarize", async () => {
    const calls = respond({ body: { results: [docRecord({ summary: "pending" }), docRecord()] } });
    const records = await newClient().batchInsert(
      [
        { filename: "a.md", content: "a", summarize: false },
        { filename: "b.md", content: "b" },
      ],
      { summarize: true },
    );
    const body = calls[0].json as { summarize?: boolean; documents: Array<Record<string, unknown>> };
    expect(body.summarize).toBe(true);
    expect(body.documents[0].summarize).toBe(false);
    expect("summarize" in body.documents[1]).toBe(false);
    expect(records[0].summary).toBe("pending");
    expect(records[1].summary).toBeUndefined();
  });

  it("batchInsert omits summarize when unset", async () => {
    const calls = respond({ body: { results: [docRecord()] } });
    await newClient().batchInsert([{ filename: "a.md", content: "a" }]);
    expect("summarize" in (calls[0].json as Record<string, unknown>)).toBe(false);
  });

  it("waitForJob surfaces summary_state", async () => {
    respond({ body: { status: "completed", doc_id: "doc-1", summary_state: "pending" } });
    const job = await newClient().waitForJob("job-1", { pollIntervalMs: 1 });
    expect(job.summary_state).toBe("pending");
  });

  it("Memory.remember: constructor default, per-call override, unset", async () => {
    const calls = respond({ body: docRecord({ entity_id: OWNER }) });
    const client = newClient();
    const summarizing = new Memory(OWNER, { client, summarize: true });
    await summarizing.remember("one");
    await summarizing.remember("two", undefined, { summarize: false });
    await new Memory(OWNER, { client }).remember("three");
    await new Memory(OWNER, { client }).remember("four", undefined, { summarize: true });
    expect(calls.map((c) => c.url.searchParams.get("summarize"))).toEqual([
      "true",
      "false",
      null,
      "true",
    ]);
  });
});

describe("search hits", () => {
  it("parse memory_file and leave it absent on other hits", async () => {
    respond({
      body: {
        query: "net",
        results: [
          {
            doc_id: "doc-1",
            score: 90,
            content_type: "text/markdown",
            passage: "Net 30",
            memory_file: { name: "memory.md", version: 7, section: "Agreed terms", section_slug: "agreed-terms" },
          },
          { doc_id: "doc-2", score: 80, content_type: "text/plain", passage: "other" },
        ],
      },
    });
    const hits = await newClient().search("net");
    expect(hits[0].memory_file).toEqual({
      name: "memory.md",
      version: 7,
      section: "Agreed terms",
      section_slug: "agreed-terms",
    });
    expect(hits[1].memory_file ?? null).toBeNull();
  });

  it("retrieve keeps memory_file on the hydrated result", async () => {
    mockFetch.mockImplementation(async (input: string) => {
      const url = new URL(input);
      if (url.pathname === "/v1/search") {
        return new Response(
          JSON.stringify({
            query: "net",
            results: [
              {
                doc_id: "doc-1",
                score: 90,
                content_type: "text/markdown",
                passage: "Net 30",
                memory_file: { name: "memory.md", version: 7, section: null, section_slug: null },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("# Acme memory\n", { status: 200 });
    });
    const [hit] = await newClient().retrieve("net");
    expect(hit.content).toBe("# Acme memory\n");
    expect(hit.memory_file).toEqual({ name: "memory.md", version: 7, section: null, section_slug: null });
  });
});
