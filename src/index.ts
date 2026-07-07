export { AetherClient, INGEST_CONTENT_TYPES, resolveContentType } from "./client.js";
export type { AetherClientOptions } from "./client.js";
export { Memory } from "./memory.js";
export type {
  MemoryItem,
  MemoryOptions,
  RecallOptions,
  MemoryListOptions,
  MemoryEntity,
  MemoryRelationship,
  MemoryFact,
  ConsolidationReport,
  ScalarValue,
  FactSubjectType,
  UpsertEntityOptions,
  ListEntitiesOptions,
  RelateOptions,
  ListRelationshipsOptions,
  RememberFactOptions,
  ListFactsOptions,
  FactHistoryOptions,
} from "./memory.js";
export {
  AetherError,
  AetherApiError,
  AetherNetworkError,
  CreditExhaustedError,
  FreeLimitExceededError,
  TenantPausedError,
  PartitionRequiredError,
  aetherApiErrorFromResponse,
} from "./errors.js";
export type { AetherErrorBody } from "./errors.js";
export type {
  AuditProof,
  AuditRecord,
  DocumentRecord,
  SearchResult,
  SearchFeedbackSignal,
  RetrievalResult,
  IngestResult,
  NodeStatus,
  ChunkingConfig,
  BatchInsertItem,
  BatchSearchQuery,
  BatchSearchResponse,
  EntityBackfillReport,
  PartitionInfo,
  PartitionWarning,
  PartitionList,
  SearchTrace,
  TracedSearch,
  IsolationCheck,
  FieldSchema,
  FieldSchemaInput,
  QueryPage,
  QueryGroup,
  AggregateResult,
  SchemaOps,
} from "./models.js";
export { formatContext, DEFAULT_TEMPLATE } from "./rag.js";
export type { FormatContextOptions, FormatContextResult } from "./rag.js";
