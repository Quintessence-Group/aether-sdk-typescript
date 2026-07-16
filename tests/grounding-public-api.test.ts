import { describe, expectTypeOf, it } from "vitest";
import type {
  AuditProof,
  GroundingBinding,
  GroundingReceipt,
  GroundingSetAttestation,
  GroundingSource,
  ReceiptAttestation,
  ShareableReceipt,
} from "../src/index.js";

describe("grounding receipt public type exports", () => {
  it("exports the complete proof and commitment surface", () => {
    expectTypeOf<GroundingReceipt["sources"][number]>()
      .toEqualTypeOf<GroundingSource>();
    expectTypeOf<GroundingSource["proof"]>()
      .toEqualTypeOf<AuditProof | undefined>();
    expectTypeOf<GroundingReceipt["binding"]>()
      .toEqualTypeOf<GroundingBinding>();
    expectTypeOf<GroundingBinding["source_evidence_commitment"]>()
      .toEqualTypeOf<string>();
    expectTypeOf<GroundingReceipt["attestation"]>()
      .toEqualTypeOf<GroundingSetAttestation>();
    expectTypeOf<GroundingReceipt["receipt"]>()
      .toEqualTypeOf<ShareableReceipt | undefined>();
    expectTypeOf<ShareableReceipt["capability_commitment"]>()
      .toEqualTypeOf<string>();
    expectTypeOf<ShareableReceipt["owner_commitment"]>()
      .toEqualTypeOf<string>();
    expectTypeOf<ShareableReceipt["attestation"]>()
      .toEqualTypeOf<ReceiptAttestation>();
  });
});
