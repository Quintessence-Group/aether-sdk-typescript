# @aether-ai/sdk

TypeScript SDK for [Aether](https://aetherdb.ai) — the decentralized RAG API.

## Installation

```bash
npm install @aether-ai/sdk
```

## Memory

`Memory` is the recommended way to give an agent, assistant, or per-user feature
a durable memory. Construct it once with an **entity id** — a user, customer,
patient, or agent session — and every call is automatically scoped to that
entity. It is a thin facade over the raw [`AetherClient`](#quick-start): it adds
no new HTTP routes and inherits all transport, retry, timeout, and error
semantics unchanged.

```typescript
import { Memory } from "@aether-ai/sdk";

const mem = new Memory("patient-john", { apiKey: "aether_your_key_here" });

// Remember something (one HTTP call). Optional metadata is stored as tags.
await mem.remember("Anxious about flying; uses 4-7-8 breathing", {
  topic: "anxiety",
});

// Recall by meaning. `score` is higher = more relevant, relative to this call.
const hits = await mem.recall("anxiety coping", { k: 3 });
for (const h of hits) {
  console.log(`${h.score?.toFixed(2)}  ${h.text}`);
}

// Blend semantic relevance with recency (recent memories rank higher).
const recent = await mem.recall("what did we discuss", {
  k: 5,
  recencyWeight: 0.5,
});

// Chronological view, newest first.
const all = await mem.list({ limit: 20 });

// Forget one memory, or wipe the entity entirely.
await mem.forget(hits[0].id);
const removed = await mem.forgetAll();
```

Each result is a `MemoryItem`:

```typescript
interface MemoryItem {
  id: string;          // underlying doc_id
  text: string;        // the remembered text
  createdAt?: string;  // RFC 3339; set by remember/list, and by recall when recencyWeight > 0
  entityId?: string;   // always this Memory's entity
  metadata: Metadata;  // structured metadata, echoed back on recall/list
  score?: number;      // relevance signal (recall only); higher = more relevant
}
```

> **Note:** `metadata` (`Record<string, string | number | boolean>`) is stored
> with each memory and echoed back on `recall` and `list`. You can also filter
> on it at query time via `recall(query, { filter })`.

For lower-level control — raw documents, BYO embeddings, batching, async jobs —
use the [`AetherClient`](#quick-start) directly.

## Quick Start

```typescript
import { AetherClient } from "@aether-ai/sdk";
import { readFileSync } from "fs";

const client = new AetherClient({
  apiKey: "aether_your_key_here",
});

// Insert a file — content type is auto-detected from the filename
const data = readFileSync("report.pdf");
const doc = await client.insert(new Uint8Array(data), {
  filename: "report.pdf",
});
console.log(`Inserted: ${doc.doc_id}`);

// Insert raw text
await client.insertText("Some text content to index");

// Search
const results = await client.search("machine learning", 5);
for (const r of results) {
  console.log(`  ${r.doc_id} (score: ${r.score}) - ${r.passage}`);
}
```

## Per-user permissions & audit

Restrict who can read a document, then scope a client to act on behalf of a
principal so reads are filtered by each document's ACL:

```typescript
import { AetherClient, PrincipalPinMismatchError } from "@aether-ai/sdk";

const client = new AetherClient({ apiKey: "aether_your_key_here" });

// Write with a read-ACL — only alice and the eng group can read this document.
// Omit aclReaders (or pass []) for the admin-only default.
await client.insertText("Q3 board deck notes", {
  aclReaders: ["user:alice", "group:eng"],
});

// Act as a principal: searches and reads only surface documents this principal
// is allowed to see. Composes with client.partition(...).
const alice = client.asPrincipal("user:alice", { groups: ["group:eng"] });
const hits = await alice.search("board deck", 5);

// Query the tenant's access-audit log (requires audit capture to be enabled).
const page = await client.audit.access({ action: "read", limit: 100 });
console.log(`${page.total} read events`);
for (const rec of page.records) {
  console.log(rec.at, rec.actor, rec.action, rec.resource);
}
```

A principal-pinned API key that is asked to assert a different principal throws
`PrincipalPinMismatchError`.

## Supported File Formats

Content type is auto-detected from the filename extension. No need to specify `contentType` manually.

| Format | Extensions |
|--------|-----------|
| PDF | .pdf |
| Word | .docx, .doc |
| PowerPoint | .pptx, .ppt |
| Excel | .xlsx, .xls |
| HTML | .html, .htm |
| CSV | .csv |
| Plain text | .txt, .md, .json, .xml |

Binary-format parsing is handled automatically server-side — no setup required.

## RAG Quick Start

Use `retrieve()` to search and get document content in one call:

```typescript
import { AetherClient } from "@aether-ai/sdk";

const aether = new AetherClient();

// Insert documents
await aether.insertText("All employees receive 20 days PTO per year...");

// Retrieve relevant context for your LLM
const results = await aether.retrieve("How much PTO do I get?", 3);
const context = results
  .map((r) => `[${r.title ?? r.doc_id}]\n${r.content}`)
  .join("\n\n");
```

For complete RAG examples with Anthropic, OpenAI, Vercel AI SDK, and more, see the [Aether docs](https://docs.aetherdb.ai).

## Async Processing

For large files, use the async methods for non-blocking inserts:

```typescript
import { readFileSync } from "fs";

// Submit for background processing
const data = readFileSync("report.pdf");
const job = await client.insertAsync(new Uint8Array(data), {
  filename: "report.pdf",
});

// Poll until the job reaches a terminal state
const result = await client.waitForJob(job.job_id);
console.log(`Status: ${result.status} (doc: ${result.doc_id})`);
```

## License

MIT

### Memory files

`memory.files` holds named, versioned **markdown files** for the entity — a
`memory.md` of agreed terms, a running log, a profile. Agents read them whole, by
section (heading text or slug) or page by page, and edit them with section-aware
appends or whole-file writes guarded by the version they read. Every version is
kept (up to a retention limit) for `versions` and `diff`, and `grep` searches the
current versions line by line.

```typescript
import { Memory, VersionConflictError } from "@aether-ai/sdk";

const mem = new Memory("acme", { apiKey: "aether_..." });

// Create the file (fails if it already exists).
await mem.files.write("memory.md", "# Acme memory\n\n## Agreed terms\n", { create: true });

// Section-aware appends need no precondition: they apply atomically to the
// current version, and a missing section is created at the end of the file.
await mem.files.appendSection("memory.md", "Agreed terms", "- Net 30 payment terms");
await mem.files.append("memory.md", "- 2026-10-10 call notes");

// Read one section, or only the outline.
const terms = await mem.files.read("memory.md", { section: "Agreed terms" });
const outline = await mem.files.read("memory.md", { outline: true });

// History, diffs and search.
const history = await mem.files.versions("memory.md");
const diff = await mem.files.diff("memory.md"); // previous version → current
const hits = await mem.files.grep("net\\s+\\d+", { regex: true, ignoreCase: true });

// Erase every version.
await mem.files.delete("memory.md", { hard: true });
```

**Read-modify-write.** To rewrite a file, read it, edit the content, and write it
back with `expectedVersion: file.version`. If someone else wrote in between, the
write throws `VersionConflictError` (with `currentVersion`): re-read, re-apply
your edit and write again.

```typescript
for (;;) {
  const file = await mem.files.read("memory.md");
  try {
    await mem.files.write("memory.md", edit(file.content), { expectedVersion: file.version });
    break;
  } catch (err) {
    if (!(err instanceof VersionConflictError)) throw err;
  }
}
```

- `write` and `replaceSection` take exactly one of `expectedVersion` or
  `create: true`; `append` and `appendSection` take an optional `expectedVersion`.
- Every write carries an `Idempotency-Key` that is reused across the SDK's
  automatic retries, so a retried `append` never appends twice. Pass your own
  `idempotencyKey` to make your own retries safe too. Writing content identical to
  the current version is a no-op that returns `unchanged: true`.
- Names are 1–128 letters, digits, `.`, `_` or `-`, start with a letter or digit,
  and are case-sensitive; `validateMemoryFileName` checks one client-side.
- Search hits on a memory file carry `memory_file` (`name`, `version`, `section`).
- To list or grep across entities — e.g. every company in a workspace — use the raw
  client: `client.listMemoryFiles({ entityPrefix: "ws_42:company:" })` and
  `client.grepMemoryFiles("Net 30", { entityPrefix: "ws_42:company:" })`.
- A `404` with code `feature_not_enabled` means memory files are not enabled on
  your Aether deployment.

### Reading a document's text

`getText()` returns the parsed, readable text of any stored document — the
original for text types, the caption or transcript for media, and text rebuilt
from the parsed passages for PDF/Office — paged and addressable by section:

```typescript
const outline = await aether.getText(docId, { outline: true });
console.log(outline.sections?.map((s) => s.heading));

const terms = await aether.getText(docId, { section: "Payment terms" });
let page = await aether.getText(docId, { maxBytes: 65536 });
while (page.truncated) {
  page = await aether.getText(docId, { offset: page.next_offset!, maxBytes: 65536 });
}
```

### Document summaries

Ask for a short markdown summary when you insert a document; it is generated in the
background after the document is stored and never delays or fails the insert:

```typescript
const doc = await aether.insert(pdfBytes, { filename: "msa.pdf", summarize: true });
console.log(doc.summary); // "pending" (or "skipped" by policy)

const summary = await aether.getSummary(doc.doc_id);
if (summary.state === "ready") console.log(summary.content);

// Write your own (it is kept until a forced regeneration), or regenerate.
await aether.putSummary(doc.doc_id, "## Summary\n- Master services agreement.\n", {
  expectedRevision: summary.revision ?? undefined,
});
await aether.regenerateSummary(doc.doc_id, { force: true });
```

`summarize` is accepted by `insert`, `insertText`, `insertStream`, `insertAsync`
(the job status reports `summary_state`), `batchInsert` (batch-wide and per item)
and `Memory` (`new Memory(id, { summarize: true })` or per call in `remember`).
Omit it to follow your tenant's default. `getSummary` always answers with a `state`
(`none`, `pending`, `ready`, `failed`, `skipped` or `unsupported`); `stale: true`
means the document changed after the summary was written. A `404` with code
`feature_not_enabled` means summaries are not enabled on your deployment.

For complete RAG examples with Anthropic, OpenAI, Vercel AI SDK, and more, see [examples/](../../examples/).
