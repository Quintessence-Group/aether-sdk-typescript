# @aether-ai/sdk

TypeScript SDK for [Aether](https://aetherdb.ai) — the decentralized RAG API.

## Installation

```bash
npm install @aether-ai/sdk
```

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
  console.log(`  ${r.doc_id} (distance: ${r.distance.toFixed(3)})`);
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
