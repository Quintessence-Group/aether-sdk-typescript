export interface DocumentRecord {
  doc_id: string;
  cid: string;
  title?: string;
  content_type: string;
  size_bytes: number;
  chunks: number;
  vectors: number;
  version: number;
  /** Caller-supplied entity this document belongs to, if any. */
  entity_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SearchResult {
  doc_id: string;
  distance: number;
  title?: string;
  content_type: string;
  content?: string;
  /** The specific passage that matched the query vector, if available. */
  passage?: string;
  /** Entity the matched document belongs to, if any. */
  entity_id?: string;
}

export interface RetrievalResult extends SearchResult {
  /** Full document content as text, for use in RAG prompts. */
  content: string;
}

export interface NodeStatus {
  node_id: number;
  documents: number;
  vectors: number;
  version?: string;
}

export interface ChunkingConfig {
  chunkSize?: number;
  overlap?: number;
}

export interface BatchInsertItem {
  filename: string;
  content: string;
  tags?: string[];
  /** Caller-supplied entity to associate the document with. */
  entityId?: string;
}

export interface BatchSearchQuery {
  q: string;
  k?: number;
  tags?: string[];
  include_content?: boolean;
  /** Restrict results to documents belonging to this entity. */
  entityId?: string;
  /** Only match documents created at or after this RFC3339 timestamp. */
  since?: string;
  /** Only match documents created at or before this RFC3339 timestamp. */
  until?: string;
  /** Convenience window: only match documents from the last N days. */
  lastNDays?: number;
}

export interface BatchSearchResponse {
  query: string;
  results: SearchResult[];
}

/**
 * Summary returned by {@link AetherClient.backfillEntityFromTags}, describing
 * how many documents were affected when deriving `entity_id` from tags.
 */
export interface EntityBackfillReport {
  /** Total active documents examined. */
  scanned: number;
  /** Documents whose `entity_id` was set from a tag this run. */
  updated: number;
  /** Skipped: already had an `entity_id` (overwrite=false), or the derived value already matched. */
  skipped_existing: number;
  /** Skipped: no tag matched the prefix (or the match had an empty suffix). */
  skipped_no_match: number;
  /** Skipped: two or more tags matched the prefix (ambiguous; never guessed). */
  skipped_ambiguous: number;
  /** Skipped: the derived `entity_id` exceeded the length bound. */
  skipped_invalid: number;
}
