import { describe, expect, it } from "vitest";
import {
  AetherError,
  AetherApiError,
  AetherNetworkError,
  CreditExhaustedError,
  FreeLimitExceededError,
  TenantPausedError,
  aetherApiErrorFromResponse,
} from "../src/errors.js";

describe("AetherError", () => {
  it("is an instance of Error", () => {
    const err = new AetherError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AetherError);
    expect(err.name).toBe("AetherError");
    expect(err.message).toBe("test");
  });
});

describe("AetherApiError", () => {
  it("extends AetherError with status and body", () => {
    const err = new AetherApiError(404, "Not Found", {
      error: "Document not found",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AetherError);
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err.name).toBe("AetherApiError");
    expect(err.status).toBe(404);
    expect(err.statusText).toBe("Not Found");
    expect(err.body).toEqual({ error: "Document not found" });
    expect(err.message).toBe("Document not found");
  });

  it("can be caught as AetherError", () => {
    const err = new AetherApiError(401, "Unauthorized", {
      error: "Invalid API key",
    });
    try {
      throw err;
    } catch (e) {
      expect(e).toBeInstanceOf(AetherError);
    }
  });
});

describe("aetherApiErrorFromResponse", () => {
  it("returns CreditExhaustedError for 402 + credit_exhausted", () => {
    const err = aetherApiErrorFromResponse(402, "Payment Required", {
      error: "Top up your balance",
      code: "credit_exhausted",
    });
    expect(err).toBeInstanceOf(CreditExhaustedError);
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err.errorCode).toBe("credit_exhausted");
    expect(err.status).toBe(402);
  });

  it("returns FreeLimitExceededError for 402 + free_limit_exceeded", () => {
    const err = aetherApiErrorFromResponse(402, "Payment Required", {
      error: "Free plan limit reached",
      code: "free_limit_exceeded",
    });
    expect(err).toBeInstanceOf(FreeLimitExceededError);
    expect(err).toBeInstanceOf(AetherApiError);
    // FreeLimitExceededError is NOT a CreditExhaustedError — they're siblings.
    expect(err).not.toBeInstanceOf(CreditExhaustedError);
  });

  it("returns TenantPausedError for 403 + tenant_paused", () => {
    const err = aetherApiErrorFromResponse(403, "Forbidden", {
      error: "Tenant paused",
      code: "tenant_paused",
    });
    expect(err).toBeInstanceOf(TenantPausedError);
    expect(err.status).toBe(403);
  });

  it("falls back to AetherApiError for unknown 402 codes", () => {
    const err = aetherApiErrorFromResponse(402, "Payment Required", {
      error: "Some other thing",
      code: "unknown_code",
    });
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).not.toBeInstanceOf(CreditExhaustedError);
    expect(err).not.toBeInstanceOf(FreeLimitExceededError);
  });

  it("falls back to AetherApiError for 402 with no code", () => {
    const err = aetherApiErrorFromResponse(402, "Payment Required", {
      error: "Generic billing error",
    });
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).not.toBeInstanceOf(CreditExhaustedError);
  });

  it("falls back to AetherApiError for unrelated statuses", () => {
    const err = aetherApiErrorFromResponse(404, "Not Found", {
      error: "Document not found",
    });
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).not.toBeInstanceOf(CreditExhaustedError);
    expect(err).not.toBeInstanceOf(TenantPausedError);
  });
});

// ── Canonical billing-rejection fixtures ──────────────────
// These are the exact wire bodies the engine emits for billing/operator
// rejections. The factory must map each (status, code) pair to its typed
// subclass with `.errorCode`, `.status`, and `.body` populated, and fall back
// to the base `AetherApiError` for an unrecognized code.

describe("aetherApiErrorFromResponse — canonical billing fixtures", () => {
  it("maps 402 credit_exhausted to CreditExhaustedError", () => {
    const body = {
      error: "Prepaid credit balance exhausted; top up to continue.",
      code: "credit_exhausted",
    };
    const err = aetherApiErrorFromResponse(402, "Payment Required", body);
    expect(err).toBeInstanceOf(CreditExhaustedError);
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).toBeInstanceOf(AetherError);
    expect(err).not.toBeInstanceOf(FreeLimitExceededError);
    expect(err.status).toBe(402);
    expect(err.errorCode).toBe("credit_exhausted");
    expect(err.body).toEqual(body);
    expect(err.message).toBe(
      "Prepaid credit balance exhausted; top up to continue.",
    );
  });

  it("maps 402 free_limit_exceeded to FreeLimitExceededError", () => {
    const body = {
      error: "Free vector limit exceeded (1001/1000)",
      code: "free_limit_exceeded",
    };
    const err = aetherApiErrorFromResponse(402, "Payment Required", body);
    expect(err).toBeInstanceOf(FreeLimitExceededError);
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).toBeInstanceOf(AetherError);
    // Sibling subclass, not a credit-exhaustion failure.
    expect(err).not.toBeInstanceOf(CreditExhaustedError);
    expect(err.status).toBe(402);
    expect(err.errorCode).toBe("free_limit_exceeded");
    expect(err.body).toEqual(body);
    expect(err.message).toBe("Free vector limit exceeded (1001/1000)");
  });

  it("maps 403 tenant_paused to TenantPausedError", () => {
    const body = {
      error: "Tenant has been paused by the operator",
      code: "tenant_paused",
    };
    const err = aetherApiErrorFromResponse(403, "Forbidden", body);
    expect(err).toBeInstanceOf(TenantPausedError);
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err).toBeInstanceOf(AetherError);
    expect(err.status).toBe(403);
    expect(err.errorCode).toBe("tenant_paused");
    expect(err.body).toEqual(body);
    expect(err.message).toBe("Tenant has been paused by the operator");
  });

  it("falls back to base AetherApiError for an unknown billing code", () => {
    const body = {
      error: "Some new billing rejection we don't model yet",
      code: "some_unknown_code",
    };
    const err = aetherApiErrorFromResponse(402, "Payment Required", body);
    // Exactly the base class — none of the typed subclasses.
    expect(err).toBeInstanceOf(AetherApiError);
    expect(err.constructor).toBe(AetherApiError);
    expect(err).not.toBeInstanceOf(CreditExhaustedError);
    expect(err).not.toBeInstanceOf(FreeLimitExceededError);
    expect(err).not.toBeInstanceOf(TenantPausedError);
    expect(err.status).toBe(402);
    expect(err.errorCode).toBe("some_unknown_code");
    expect(err.body).toEqual(body);
  });
});

describe("AetherNetworkError", () => {
  it("extends AetherError with cause", () => {
    const cause = new TypeError("fetch failed");
    const err = new AetherNetworkError("Connection refused", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AetherError);
    expect(err).toBeInstanceOf(AetherNetworkError);
    expect(err.name).toBe("AetherNetworkError");
    expect(err.message).toBe("Connection refused");
    expect(err.cause).toBe(cause);
  });
});
