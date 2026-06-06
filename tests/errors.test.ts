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
