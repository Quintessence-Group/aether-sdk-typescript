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
  console.log(`  ${r.doc_id} (distance: ${r.distance}) - ${r.passage}`);
}
```

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
