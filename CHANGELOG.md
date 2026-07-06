# Changelog

All notable changes to `@aether-ai/sdk` are documented here. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.4.0

Additive release — no breaking changes. Existing code continues to work
unchanged; every new field is optional and defaults to the prior behavior.

### Added

- **Move a document between partitions.** New `client.moveDocument(docId, { from, to })`
  re-homes a document from one partition to another (`null` for either side
  means the default partition). It is metadata-only — content, chunks, and
  vectors are untouched — and returns the updated document record with its new
  `partition`. A wrong `from` assertion or a missing document returns the same
  `404` as a nonexistent id, so it never reveals whether another partition
  exists.
- **`partition` on response models.** `DocumentRecord` and `SearchResult` now
  echo the `partition` a document lives in (`null` for the default partition),
  alongside the existing `entity_id`/`source` fields. Older server payloads that
  omit it normalize to `null`.
- **Analytical `client.query()`.** Run exact, deterministic structured queries
  over declared typed fields and built-ins. Mode A returns a paginated,
  typed-sorted page of matching documents; Mode B returns grouped aggregates
  (`count`, `count_distinct`, `sum`, `avg`, `min`, `max`) with typed multi-key
  sort. The filter grammar supports `and`/`or`/`not` over
  `{ field, op, value }` leaves.
- **Field-schema facade — `client.schema`.** Declare, list, and delete the typed
  fields that `query()` filters, sorts, and aggregates over
  (`declareFields`, `listFields`, `deleteField`). On a partition handle every
  call is pinned to that partition.
- **Signed lineage — `client.lineage(docId)`.** Fetch a document's ordered
  provenance trail; each record carries a cryptographic proof so a caller can
  verify it was signed by the node that committed it.
- **Typed `PartitionRequiredError`.** A multi-tenant key that reaches an
  operation requiring a partition (without a scoped handle) now surfaces a
  dedicated error type instead of a generic API error.

### Changed

- **Scoped-handle partition guard now covers id-addressed operations.** On a
  `client.partition(id)` handle, `get`, `download` / `downloadText`, `delete`,
  `restore`, and `update` send the handle's partition as a guard: a document id
  that lives in a different partition returns the same `404` as a nonexistent
  id, so a scoped handle can never reach across the partition boundary through a
  bare document id.
