import { describe, expect, it } from "vitest";
import { formatContext } from "../src/rag.js";
import type { RetrievalResult, SearchResult } from "../src/models.js";

function makeResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    doc_id: "d1",
    score: 90,
    content: "full body",
    content_type: "text/plain",
    ...overrides,
  };
}

describe("formatContext defaults", () => {
  it("returns empty string for empty input", () => {
    expect(formatContext([])).toBe("");
  });

  it("numbers sources from one with the default template", () => {
    const results = [makeResult({ doc_id: "a" }), makeResult({ doc_id: "b" })];
    const out = formatContext(results);
    expect(out).toContain("[Source 1]");
    expect(out).toContain("[Source 2]");
    expect(out).not.toContain("[Source 0]");
  });

  it("joins sources with a blank line by default", () => {
    const results = [
      makeResult({ doc_id: "a", content: "alpha" }),
      makeResult({ doc_id: "b", content: "beta" }),
    ];
    expect(formatContext(results)).toBe(
      "[Source 1]\nalpha\n\n[Source 2]\nbeta",
    );
  });

  it("prefers passage over content by default", () => {
    // Long-form docs: passage is the matched chunk; content is the whole doc.
    const results = [
      makeResult({ content: "100-page handbook", passage: "the matched paragraph" }),
    ];
    const out = formatContext(results);
    expect(out).toContain("the matched paragraph");
    expect(out).not.toContain("100-page handbook");
  });

  it("falls back to content when passage is missing", () => {
    // Short single-chunk inserts (the quickstart shape) have no separate passage.
    const results = [makeResult({ content: "short doc" })];
    expect(formatContext(results)).toContain("short doc");
  });
});

describe("formatContext options", () => {
  it("preferPassage=false uses content", () => {
    const results = [makeResult({ content: "full body", passage: "chunk" })];
    const out = formatContext(results, { preferPassage: false });
    expect(out).toContain("full body");
    expect(out).not.toContain("chunk");
  });

  it("custom template with title and score", () => {
    const results = [
      makeResult({
        doc_id: "d1",
        title: "PTO policy",
        score: 92.5,
        content: "20 days",
      }),
    ];
    const out = formatContext(results, {
      template: "<{title} | s={score:.1f}>\n{text}",
    });
    expect(out).toBe("<PTO policy | s=92.5>\n20 days");
  });

  it("custom template falls back to doc_id when title is missing", () => {
    const results = [makeResult({ doc_id: "d1", content: "body" })];
    const out = formatContext(results, { template: "[{title}] {text}" });
    expect(out).toBe("[d1] body");
  });

  it("custom separator", () => {
    const results = [makeResult({ content: "a" }), makeResult({ content: "b" })];
    const out = formatContext(results, { separator: " --- " });
    expect(out).toContain(" --- ");
    expect(out).not.toContain("\n\n");
  });
});

describe("formatContext result types", () => {
  it("accepts a plain SearchResult and renders its passage", () => {
    // search() returns SearchResult carrying the matched passage (no full content).
    const sr: SearchResult = {
      doc_id: "d1",
      score: 90,
      content_type: "text/plain",
      passage: "search body",
    };
    expect(formatContext([sr])).toContain("search body");
  });

  it("SearchResult without a passage renders empty text", () => {
    // A search hit with no passage has no text to render.
    const sr: SearchResult = {
      doc_id: "d1",
      score: 90,
      content_type: "text/plain",
    };
    const out = formatContext([sr]);
    expect(out).toContain("[Source 1]\n");
    expect(out.endsWith("\n")).toBe(true);
  });
});
