export interface DocumentRecord {
  doc_id: string;
  cid: string;
  title?: string;
  content_type: string;
  size_bytes: number;
  chunks: number;
  vectors: number;
  version: number;
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
}

export interface BatchSearchQuery {
  q: string;
  k?: number;
  tags?: string[];
  include_content?: boolean;
}

export interface BatchSearchResponse {
  query: string;
  results: SearchResult[];
}
