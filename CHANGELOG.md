# Changelog

All notable changes to `@aether-ai/sdk` are documented here. This project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.6.0

Additive release — no breaking changes. Existing code continues to work
unchanged; every new method, type, and error is opt-in.

### Added

- **Thread lifecycle.** Whole-thread operations on the raw client —
  `client.restoreThread(threadId)`, `client.setThreadAcl(threadId, aclReaders)`,
  `client.moveThread(threadId, { expectPartition, toPartition })`, and
  `client.deleteThread(threadId, { hard })` — each resolving to a uniform
  `ThreadLifecycleResult` (`status`, `thread_id`, `turns`). The
  `memory.thread(threadId)` facade gains the same operations as `restore()`,
  `setAcl(readers)`, `move(toPartition)`, and `delete(hard)`. Every operation
  sends an `Idempotency-Key` (pass `idempotencyKey` to make cross-process
  retries safe). Turn text is never rewritten — an edit appends a correction
  turn — and deletes are soft by default; `hard: true` is an irreversible
  erasure.
- **Connections API + connect sessions.** Attach an end user's external account
  (Dropbox today) to their partition from your own backend, without the portal:
  - `client.createConnectSession({ externalUserId, returnUrl, provider?, targetPartition? })`
    mints a hosted OAuth entry point and returns a `ConnectSession`
    (`session_token`, `connect_url`, a one-time `client_secret`, `expires_at`).
  - `verifyConnectRedirectSignature(clientSecret, { session, status, connectionId, sig })`
    verifies the signed redirect back to your `returnUrl` entirely offline
    (HMAC-SHA256 over `session|status|connection_id`, keyed by
    `SHA-256(client_secret)`). No network call, no new dependencies.
  - `client.listConnections(options?)`, `client.getConnection(id)`,
    `client.resyncConnection(id)`, `client.browseConnection(id, { path?, cursor? })`,
    and `client.updateSelection(id, selectedPaths)` manage a connection and its
    sync scope. `client.deleteConnection(id)` purges the synced content and
    returns a `DisconnectResult`; the signed purge receipt is fetchable with
    `client.getPurgeReceipt(receiptId)` (`ConnectionPurgeReceipt`).
  - New types: `ConnectSession`, `CreateConnectSessionOptions`, `Connection`,
    `ListConnectionsOptions`, `DisconnectResult`, `PurgeSummary`,
    `ConnectionPurgeReceipt`.
- **Typed connect-session errors.** `SessionInvalidError` (HTTP 400,
  `code: "session_invalid"` — the session token is unknown, already used, or
  expired; mint a new session instead of retrying) and `PartitionMismatchError`
  (HTTP 400, `code: "partition_mismatch"` — the handle's partition disagrees
  with where the session would resolve). Neither is retryable.

## 0.5.0

Additive release — no breaking changes. Existing code continues to work
unchanged; every new field is optional and defaults to the prior behavior.

### Added

- **Per-user permissions & audit.** Documents can carry a read-ACL, and a client
  handle can act on behalf of a principal so reads are filtered by that ACL.
  - Pass `aclReaders: ["user:alice", "group:eng"]` to `insert`, `insertText`,
    `ingestFiles`, and `ingestDirectory` to restrict who can read a document.
    Omit it (or pass `[]`) for the admin-only default.
  - `client.asPrincipal("user:alice", { groups: [...] })` returns a scoped
    client whose reads and searches only surface documents the principal is
    allowed to see (unlabeled documents plus those whose ACL names it or one of
    its groups). Composes with `client.partition(...)`. Admin-role keys bypass
    filtering.
  - `client.audit.access(query?)` (`AuditOps`) queries the tenant's access-audit
    log — document reads, search deliveries, denials, and admin bypasses —
    returning an `AccessAuditPage`. New `AccessAuditQuery` and `AccessAuditPage`
    types. Requires access-audit capture to be enabled for the tenant.
  - New typed error `PrincipalPinMismatchError` (HTTP 403,
    `code: "principal_pin_mismatch"`) thrown when a principal-pinned API key is
    asked to assert a different principal. Not retryable.
- **Durable conversation threads.** `client.appendThread(...)` and
  `client.getThread(...)` store and replay an ordered message history for an
  agent or chat session, with a `memory.thread(threadId)` facade. New `Thread`,
  `ConversationThread`, `ThreadAppendInput`, and `ThreadReadOptions` exports.
- **Shared grounding provenance receipts.** New `GroundingReceipt`,
  `GroundingBinding`, `GroundingSource`, `GroundingTrustSignal`,
  `GroundingSetAttestation`, `ReceiptAttestation`, and `ShareableReceipt` types
  expose signed, shareable provenance for a generated answer's sources.
- **Multimodal recall.** Image and audio memories via `MediaSource` /
  `MediaRememberInput`, surfaced through the new `MediaMemoryRecord` type.

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
