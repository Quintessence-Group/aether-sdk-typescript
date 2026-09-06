/** Base error for all Aether SDK errors. */
export class AetherError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AetherError";
  }
}

/** JSON body shape returned by Aether on non-2xx responses. */
export interface AetherErrorBody {
  error: string;
  code?: string;
}

/** Thrown when the Aether API returns a non-2xx HTTP response. */
export class AetherApiError extends AetherError {
  readonly status: number;
  readonly statusText: string;
  readonly body: AetherErrorBody;
  readonly errorCode?: string;

  constructor(
    status: number,
    statusText: string,
    body: AetherErrorBody,
  ) {
    super(body.error);
    this.name = "AetherApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.errorCode = body.code;
  }
}

/**
 * Thrown when a paid tenant's prepaid credit balance is exhausted (HTTP 402,
 * `code: "credit_exhausted"`). Top up via the Portal billing page; the SDK
 * never retries these — the operation is permanently denied until credit is
 * added.
 */
export class CreditExhaustedError extends AetherApiError {
  constructor(status: number, statusText: string, body: AetherErrorBody) {
    super(status, statusText, body);
    this.name = "CreditExhaustedError";
  }
}

/**
 * Thrown when a Free-tier tenant exceeds a hard plan limit (HTTP 402,
 * `code: "free_limit_exceeded"`). Distinct from `CreditExhaustedError` so
 * dashboards can separate abuse signal from billing failures. Resolution is
 * a plan upgrade, not a top-up.
 */
export class FreeLimitExceededError extends AetherApiError {
  constructor(status: number, statusText: string, body: AetherErrorBody) {
    super(status, statusText, body);
    this.name = "FreeLimitExceededError";
  }
}

/**
 * Thrown when an operator has paused a tenant via the spike detector or admin
 * console (HTTP 403, `code: "tenant_paused"`). Not retryable; the tenant must
 * be un-paused out-of-band.
 */
export class TenantPausedError extends AetherApiError {
  constructor(status: number, statusText: string, body: AetherErrorBody) {
    super(status, statusText, body);
    this.name = "TenantPausedError";
  }
}

/**
 * Thrown when a multi-tenant key makes an unscoped call (HTTP 400,
 * `code: "partition_required"`). The key requires every read and write to name
 * a partition; scope the call through a partition handle —
 * `client.partition("<end-client-id>")` — instead of the top-level client.
 * A key minted with strict scoping additionally raises this on any
 * ID-addressed call (get/download/delete/restore/update) made without the
 * partition guard a handle would inject.
 * Not retryable: it is a programming error, not a transient failure.
 */
export class PartitionRequiredError extends AetherApiError {
  constructor(status: number, statusText: string, body: AetherErrorBody) {
    super(status, statusText, body);
    this.name = "PartitionRequiredError";
  }
}

/**
 * Thrown when an API key that is pinned to an acting principal receives a
 * request asserting a *different* principal (HTTP 403,
 * `code: "principal_pin_mismatch"`). A pinned key always acts as exactly its
 * pinned principal: issue the call without `asPrincipal(...)` (or with the
 * matching principal), or use an unpinned key. Not retryable: it is a
 * programming error, not a transient failure.
 */
export class PrincipalPinMismatchError extends AetherApiError {
  constructor(status: number, statusText: string, body: AetherErrorBody) {
    super(status, statusText, body);
    this.name = "PrincipalPinMismatchError";
  }
}

/**
 * Thrown when a connect-session token is unknown, already consumed, or
 * expired (HTTP 400, `code: "session_invalid"`). The three cases are
 * deliberately indistinguishable — mint a new session with
 * `createConnectSession` rather than retrying the same token.
 */
export class SessionInvalidError extends AetherApiError {
  constructor(status: number, statusText: string, body: AetherErrorBody) {
    super(status, statusText, body);
    this.name = "SessionInvalidError";
  }
}

/**
 * Thrown when `createConnectSession`'s asserted `?partition=` (from a
 * partition handle) disagrees with the partition the session would actually
 * resolve to (HTTP 400, `code: "partition_mismatch"`). Mint on a handle
 * scoped to the same `externalUserId` you are passing, or omit the handle.
 */
export class PartitionMismatchError extends AetherApiError {
  constructor(status: number, statusText: string, body: AetherErrorBody) {
    super(status, statusText, body);
    this.name = "PartitionMismatchError";
  }
}

/**
 * Build the most-specific `AetherApiError` subclass for the given response.
 * The factory inspects the structured `code` field (Phase 8 / ADR-015 wire
 * shape); unknown codes fall back to the base `AetherApiError`.
 */
export function aetherApiErrorFromResponse(
  status: number,
  statusText: string,
  body: AetherErrorBody,
): AetherApiError {
  if (status === 402 && body.code === "credit_exhausted") {
    return new CreditExhaustedError(status, statusText, body);
  }
  if (status === 402 && body.code === "free_limit_exceeded") {
    return new FreeLimitExceededError(status, statusText, body);
  }
  if (status === 403 && body.code === "tenant_paused") {
    return new TenantPausedError(status, statusText, body);
  }
  if (status === 403 && body.code === "principal_pin_mismatch") {
    return new PrincipalPinMismatchError(status, statusText, body);
  }
  if (status === 400 && body.code === "partition_required") {
    return new PartitionRequiredError(status, statusText, body);
  }
  if (status === 400 && body.code === "session_invalid") {
    return new SessionInvalidError(status, statusText, body);
  }
  if (status === 400 && body.code === "partition_mismatch") {
    return new PartitionMismatchError(status, statusText, body);
  }
  return new AetherApiError(status, statusText, body);
}

/** Thrown when a network-level failure prevents the request from completing. */
export class AetherNetworkError extends AetherError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AetherNetworkError";
  }
}
