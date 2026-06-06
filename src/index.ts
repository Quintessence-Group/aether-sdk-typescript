export { AetherClient } from "./client.js";
export type { AetherClientOptions } from "./client.js";
export {
  AetherError,
  AetherApiError,
  AetherNetworkError,
  CreditExhaustedError,
  FreeLimitExceededError,
  TenantPausedError,
  aetherApiErrorFromResponse,
} from "./errors.js";
export type { AetherErrorBody } from "./errors.js";
export type {
  DocumentRecord,
  SearchResult,
  RetrievalResult,
  NodeStatus,
  ChunkingConfig,
  BatchInsertItem,
  BatchSearchQuery,
  BatchSearchResponse,
} from "./models.js";
