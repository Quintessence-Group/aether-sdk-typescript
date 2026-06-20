/**
 * RAG-specific helpers for the Aether SDK.
 *
 * These utilities sit on top of {@link AetherClient.retrieve} to remove the
 * last-mile boilerplate of building an LLM prompt context: numbering sources,
 * choosing between the matched passage and the full document content, and
 * joining them into a single string.
 */
import type { RetrievalResult, SearchResult } from "./models.js";

export type FormatContextResult = RetrievalResult | SearchResult;

export interface FormatContextOptions {
  /**
   * Format string per source. Available placeholders:
   * `{i}` (1-based source number), `{doc_id}`, `{title}` (falls back to
   * `{doc_id}` when missing), `{text}` (passage or content), `{score}`.
   * Numeric placeholders accept a Python-style fixed-precision spec, e.g.
   * `{score:.1f}`.
   */
  template?: string;
  /** String joined between formatted sources. Defaults to `"\n\n"`. */
  separator?: string;
  /**
   * When `true` (default), use the matched passage if present and fall back
   * to `content`. When `false`, use `content` if present and fall back to
   * `passage`. Passages are the right choice for chunked long-form documents;
   * content is fine for short single-chunk inserts.
   */
  preferPassage?: boolean;
}

export const DEFAULT_TEMPLATE = "[Source {i}]\n{text}";

const PLACEHOLDER_RE = /\{(\w+)(?::([^}]+))?\}/g;

/**
 * Render one template, substituting `{name}` and `{name:spec}` placeholders
 * from `values`. Supports a tiny subset of Python's format spec: a fixed
 * decimal precision (`.2f`) for numbers. Unknown placeholders are left
 * untouched so a template typo doesn't silently drop a label.
 */
function renderTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(PLACEHOLDER_RE, (match, name: string, spec?: string) => {
    if (!(name in values)) return match;
    const raw = values[name];
    if (spec) {
      const fixed = /^\.(\d+)f$/.exec(spec);
      if (fixed && typeof raw === "number") {
        return raw.toFixed(Number(fixed[1]));
      }
    }
    return String(raw);
  });
}

/**
 * Format `retrieve()` / `search()` results into an LLM-ready context string.
 *
 * The default output looks like:
 *
 * ```
 * [Source 1]
 * <matched passage 1>
 *
 * [Source 2]
 * <matched passage 2>
 * ```
 *
 * @example
 * ```ts
 * import { AetherClient, formatContext } from "@aether-ai/sdk";
 *
 * const client = new AetherClient();
 * const results = await client.retrieve("How many vacation days do I get?", 3);
 * const context = formatContext(results);
 * ```
 */
export function formatContext(
  results: ReadonlyArray<FormatContextResult>,
  options: FormatContextOptions = {},
): string {
  const template = options.template ?? DEFAULT_TEMPLATE;
  const separator = options.separator ?? "\n\n";
  const preferPassage = options.preferPassage ?? true;

  const chunks: string[] = [];
  results.forEach((r, idx) => {
    const passage = r.passage ?? "";
    // `content` (full document text) is present only on RetrievalResult, which
    // `retrieve()` returns; plain `search()` results carry just the passage.
    const content = "content" in r ? r.content : "";
    const text = preferPassage ? passage || content : content || passage;
    chunks.push(
      renderTemplate(template, {
        i: idx + 1,
        doc_id: r.doc_id,
        title: r.title ?? r.doc_id,
        text,
        score: r.score,
      }),
    );
  });
  return chunks.join(separator);
}
