import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherClient } from "../src/client.js";
import { verifyConnectRedirectSignature } from "../src/client.js";
import {
  AetherApiError,
  AetherError,
  PartitionMismatchError,
  SessionInvalidError,
} from "../src/errors.js";
import { createHash, createHmac } from "node:crypto";

// The Connections API surface:
// createConnectSession / listConnections / getConnection / deleteConnection /
// resyncConnection / browseConnection / updateSelection / getPurgeReceipt,
// the typed errors, and the offline verifyConnectRedirectSignature verifier.
// Driven through a real client over a mocked `fetch` so the genuine
// request-building / parse / error-mapping path runs — mirroring
// `partitions.test.ts`'s pattern and the parity already shipped for Python
// (`test_connections.py`), Go (`connections_test.go`), and .NET
// (`ConnectionsTests.cs`).

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

function newClient(): AetherClient {
  return new AetherClient({ baseUrl: "http://localhost:9000", apiKey: "test-key" });
}

const CID = "11111111-1111-1111-1111-111111111111";

const RAW_CONNECTION = {
  connection_id: CID,
  provider: "dropbox",
  owner_type: "tenant" as const,
  owner_id: null,
  provider_account_id: "dbid:acme",
  account_display_name: null,
  target_partition: null,
  status: "active",
  granted_scopes: [] as string[],
  created_at: "2026-08-15T00:00:00Z",
  last_sync_at: null,
  last_error: null,
  files_synced: 0,
  files_skipped: 0,
  files_deleted: 0,
  selected_paths: [] as string[],
  purge_state: "not_started" as const,
  purge_receipt_id: null,
  credential_deleted: false,
};

describe("connections", () => {
  // ── createConnectSession ──────────────────────────────────────────

  describe("createConnectSession", () => {
    it("mints and parses the response", async () => {
      mockFetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://localhost:9000/v1/connections/sessions");
        expect(init.method).toBe("POST");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({
          external_user_id: "priya",
          return_url: "https://acme.example.com/cb",
        });
        return jsonResponse({
          session_token: "acs_deadbeef",
          connect_url: "https://connect.example.com/connect/acs_deadbeef",
          client_secret: "acsec_secretsecret",
          expires_at: "2026-08-15T00:00:00Z",
        });
      });

      const session = await newClient().createConnectSession({
        externalUserId: "priya",
        returnUrl: "https://acme.example.com/cb",
      });
      expect(session.sessionToken).toBe("acs_deadbeef");
      expect(session.connectUrl).toBe(
        "https://connect.example.com/connect/acs_deadbeef",
      );
      expect(session.clientSecret).toBe("acsec_secretsecret");
      expect(session.expiresAt).toBe("2026-08-15T00:00:00Z");
    });

    it("sends provider and targetPartition when given", async () => {
      mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.provider).toBe("dropbox");
        expect(body.target_partition).toBe("shared-corpus");
        return jsonResponse({
          session_token: "acs_x",
          connect_url: "https://connect.example.com/connect/acs_x",
          client_secret: "acsec_x",
          expires_at: "2026-08-15T00:00:00Z",
        });
      });

      await newClient().createConnectSession({
        provider: "dropbox",
        externalUserId: "priya",
        returnUrl: "https://acme.example.com/cb",
        targetPartition: "shared-corpus",
      });
    });

    it("on a handle asserts the handle's partition", async () => {
      mockFetch.mockImplementationOnce(async (url: string) => {
        expect(url).toContain("partition=priya");
        return jsonResponse({
          session_token: "acs_x",
          connect_url: "https://connect.example.com/connect/acs_x",
          client_secret: "acsec_x",
          expires_at: "2026-08-15T00:00:00Z",
        });
      });

      await newClient()
        .partition("priya")
        .createConnectSession({
          externalUserId: "priya",
          returnUrl: "https://acme.example.com/cb",
        });
    });

    it("rejects empty externalUserId or returnUrl with no HTTP call", async () => {
      await expect(
        newClient().createConnectSession({
          externalUserId: "",
          returnUrl: "https://acme.example.com/cb",
        }),
      ).rejects.toThrow(AetherError);
      await expect(
        newClient().createConnectSession({
          externalUserId: "priya",
          returnUrl: "",
        }),
      ).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("maps partition_mismatch to the typed error", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'this session would resolve to partition "priya"',
            code: "partition_mismatch",
          },
          400,
        ),
      );

      await expect(
        newClient()
          .partition("someone-else")
          .createConnectSession({
            externalUserId: "priya",
            returnUrl: "https://acme.example.com/cb",
          }),
      ).rejects.toThrow(PartitionMismatchError);
    });

    it("maps session_invalid to the typed error", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error: "this connect session is unknown, already used, or expired",
            code: "session_invalid",
          },
          400,
        ),
      );

      await expect(
        newClient().createConnectSession({
          externalUserId: "priya",
          returnUrl: "https://acme.example.com/cb",
        }),
      ).rejects.toThrow(SessionInvalidError);
    });
  });

  // ── listConnections ───────────────────────────────────────────────

  describe("listConnections", () => {
    it("parses every field (snake_case → camelCase)", async () => {
      mockFetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
        expect(url).toBe("http://localhost:9000/v1/connections");
        expect(init.method ?? "GET").toBe("GET");
        return jsonResponse({
          connections: [
            {
              ...RAW_CONNECTION,
              owner_type: "external_user",
              owner_id: "priya",
              account_display_name: "Priya",
              target_partition: "priya",
              granted_scopes: ["files.metadata.read"],
              files_synced: 3,
            },
          ],
        });
      });

      const conns = await newClient().listConnections();
      expect(conns).toHaveLength(1);
      const c = conns[0];
      expect(c.connectionId).toBe(CID);
      expect(c.ownerType).toBe("external_user");
      expect(c.ownerId).toBe("priya");
      expect(c.accountDisplayName).toBe("Priya");
      expect(c.targetPartition).toBe("priya");
      expect(c.grantedScopes).toEqual(["files.metadata.read"]);
      expect(c.filesSynced).toBe(3);
      expect(c.purgeState).toBe("not_started");
      expect(c.credentialDeleted).toBe(false);
    });

    it("sends owner filters and includePurged=false", async () => {
      mockFetch.mockImplementationOnce(async (url: string) => {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("owner_type")).toBe("external_user");
        expect(parsed.searchParams.get("owner_id")).toBe("priya");
        expect(parsed.searchParams.get("include_purged")).toBe("false");
        return jsonResponse({ connections: [] });
      });

      await newClient().listConnections({
        ownerType: "external_user",
        ownerId: "priya",
        includePurged: false,
      });
    });

    it("on a handle sends the partition query param", async () => {
      mockFetch.mockImplementationOnce(async (url: string) => {
        expect(url).toContain("partition=priya");
        return jsonResponse({ connections: [] });
      });

      await newClient().partition("priya").listConnections();
    });
  });

  // ── getConnection ─────────────────────────────────────────────────

  describe("getConnection", () => {
    it("fetches by id", async () => {
      mockFetch.mockImplementationOnce(async (url: string) => {
        expect(url).toBe(`http://localhost:9000/v1/connections/${CID}`);
        return jsonResponse(RAW_CONNECTION);
      });

      const conn = await newClient().getConnection(CID);
      expect(conn.connectionId).toBe(CID);
      expect(conn.ownerType).toBe("tenant");
      expect(conn.targetPartition).toBeUndefined();
    });

    it("a wrong-partition handle gets the plain connection_not_found", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "unknown connection", code: "connection_not_found" }, 404),
      );

      const err = await newClient()
        .partition("someone-else")
        .getConnection(CID)
        .catch((e) => e);
      expect(err).toBeInstanceOf(AetherApiError);
      expect(err.status).toBe(404);
      expect(err.errorCode).toBe("connection_not_found");
    });

    it("an unscoped call to an end-user-scoped connection gets partition_required", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            error:
              'This connection was set up for an end user in partition "priya", so ' +
              "reading, resyncing, browsing, updating the selection of, or " +
              "disconnecting it may only be done by a call scoped to that partition.",
            code: "partition_required",
          },
          400,
        ),
      );

      const err = await newClient()
        .getConnection(CID)
        .catch((e) => e);
      expect(err).toBeInstanceOf(AetherApiError);
      expect(err.status).toBe(400);
      expect(err.errorCode).toBe("partition_required");
    });

    it("rejects an empty id with no HTTP call", async () => {
      await expect(newClient().getConnection("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── deleteConnection ──────────────────────────────────────────────

  describe("deleteConnection", () => {
    it("parses the purge summary", async () => {
      mockFetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
        expect(url).toBe(`http://localhost:9000/v1/connections/${CID}`);
        expect(init.method).toBe("DELETE");
        return jsonResponse({
          connection_id: CID,
          status: "revoked",
          purge: {
            receipt_id: "r1",
            documents_purged: 5,
            merkle_root: "deadbeef",
            completed_at: "2026-08-15T00:00:00Z",
            signer_node_id: "node-1",
          },
        });
      });

      const result = await newClient().deleteConnection(CID);
      expect(result.connectionId).toBe(CID);
      expect(result.status).toBe("revoked");
      expect(result.purge).toBeDefined();
      expect(result.purge?.documentsPurged).toBe(5);
      expect(result.purge?.receiptId).toBe("r1");
      expect(result.purge?.merkleRoot).toBe("deadbeef");
      expect(result.purge?.signerNodeId).toBe("node-1");
    });

    it("an idempotent no-op has no purge", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ connection_id: CID, status: "revoked", purge: null }),
      );

      const result = await newClient().deleteConnection(CID);
      expect(result.purge).toBeUndefined();
    });

    it("rejects an empty id with no HTTP call", async () => {
      await expect(newClient().deleteConnection("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("on a handle sends the partition query param", async () => {
      mockFetch.mockImplementationOnce(async (url: string) => {
        expect(url).toContain(`partition=priya`);
        return jsonResponse({ connection_id: CID, status: "revoked", purge: null });
      });

      await newClient().partition("priya").deleteConnection(CID);
    });
  });

  // ── resyncConnection ──────────────────────────────────────────────

  describe("resyncConnection", () => {
    it("posts then refetches the full Connection", async () => {
      const calls: Array<[string, string]> = [];
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const parsed = new URL(url);
        calls.push([init?.method ?? "GET", parsed.pathname]);
        if (parsed.pathname === `/v1/connections/${CID}/resync`) {
          expect(init?.method).toBe("POST");
          return jsonResponse({ connection_id: CID, status: "active" });
        }
        return jsonResponse({ ...RAW_CONNECTION, status: "active" });
      });

      const conn = await newClient().resyncConnection(CID);
      expect(conn.status).toBe("active");
      expect(calls).toContainEqual(["POST", `/v1/connections/${CID}/resync`]);
      expect(calls).toContainEqual(["GET", `/v1/connections/${CID}`]);
    });

    it("rejects an empty id with no HTTP call", async () => {
      await expect(newClient().resyncConnection("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── browseConnection / updateSelection ────────────────────────────

  describe("browseConnection", () => {
    it("sends path and cursor, and parses the page", async () => {
      mockFetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
        expect(url).toBe(`http://localhost:9000/v1/connections/${CID}/browse`);
        expect(init.method).toBe("POST");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ path: "/Reports", cursor: undefined });
        return jsonResponse({
          entries: [
            {
              name: "q3.txt",
              path_display: "/Reports/q3.txt",
              is_folder: false,
              size_bytes: 42,
            },
          ],
          next_cursor: "cursor-2",
        });
      });

      const page = await newClient().browseConnection(CID, { path: "/Reports" });
      expect(page.entries[0].name).toBe("q3.txt");
      expect(page.entries[0].pathDisplay).toBe("/Reports/q3.txt");
      expect(page.entries[0].isFolder).toBe(false);
      expect(page.entries[0].sizeBytes).toBe(42);
      expect(page.nextCursor).toBe("cursor-2");
    });

    it("rejects an empty id with no HTTP call", async () => {
      await expect(newClient().browseConnection("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("updateSelection", () => {
    it("replaces the paths and returns the normalized list", async () => {
      mockFetch.mockImplementationOnce(async (url: string, init: RequestInit) => {
        expect(url).toBe(`http://localhost:9000/v1/connections/${CID}/selection`);
        expect(init.method).toBe("PUT");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ selected_paths: ["/Reports"] });
        return jsonResponse({ connection_id: CID, selected_paths: ["/Reports"] });
      });

      const paths = await newClient().updateSelection(CID, ["/Reports"]);
      expect(paths).toEqual(["/Reports"]);
    });

    it("rejects an empty id with no HTTP call", async () => {
      await expect(newClient().updateSelection("", ["/x"])).rejects.toThrow(
        AetherError,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── getPurgeReceipt ───────────────────────────────────────────────

  describe("getPurgeReceipt", () => {
    it("parses the full shape", async () => {
      mockFetch.mockImplementationOnce(async (url: string) => {
        expect(url).toBe(
          "http://localhost:9000/v1/connections/purge-receipts/r1",
        );
        return jsonResponse({
          version: "1",
          receipt_id: "r1",
          tenant_id: "t1",
          connection_id: "c1",
          provider: "dropbox",
          owner: "external_user:priya",
          provider_account_id: "dbid:priya",
          documents_purged: 5,
          documents_failed: 0,
          merkle_root: "deadbeef",
          merkle_leaf_count: 5,
          purged_document_ids: ["d1", "d2"],
          partitions_touched: ["priya"],
          default_partition_touched: false,
          credential_revocation: "revoked",
          credential_deleted: true,
          started_at: "2026-08-15T00:00:00Z",
          completed_at: "2026-08-15T00:00:01Z",
          signer_node_id: "node-1",
          signer_public_key: "pub-1",
          signature: "sig-1",
          verified: true,
        });
      });

      const receipt = await newClient().getPurgeReceipt("r1");
      expect(receipt.documentsPurged).toBe(5);
      expect(receipt.partitionsTouched).toEqual(["priya"]);
      expect(receipt.purgedDocumentIds).toEqual(["d1", "d2"]);
      expect(receipt.verified).toBe(true);
    });

    it("rejects an empty id with no HTTP call", async () => {
      await expect(newClient().getPurgeReceipt("")).rejects.toThrow(AetherError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── verifyConnectRedirectSignature (pure, offline) ────────────────

  describe("verifyConnectRedirectSignature", () => {
    function referenceSig(
      clientSecret: string,
      session: string,
      status: string,
      connectionId: string,
    ): string {
      const key = createHash("sha256").update(clientSecret, "utf8").digest();
      const message = `${session}|${status}|${connectionId}`;
      return createHmac("sha256", key).update(message, "utf8").digest("hex");
    }

    it("accepts a correct signature", () => {
      const secret = "acsec_the-real-secret";
      const sig = referenceSig(secret, "acs_tok", "active", "conn-1");
      expect(
        verifyConnectRedirectSignature(secret, {
          session: "acs_tok",
          status: "active",
          connectionId: "conn-1",
          sig,
        }),
      ).toBe(true);
    });

    it("rejects a tampered param", () => {
      const secret = "acsec_the-real-secret";
      const sig = referenceSig(secret, "acs_tok", "active", "conn-1");
      expect(
        verifyConnectRedirectSignature(secret, {
          session: "acs_tok",
          status: "error",
          connectionId: "conn-1",
          sig,
        }),
      ).toBe(false);
    });

    it("rejects the wrong secret", () => {
      const sig = referenceSig("acsec_the-real-secret", "acs_tok", "active", "conn-1");
      expect(
        verifyConnectRedirectSignature("acsec_a-different-secret", {
          session: "acs_tok",
          status: "active",
          connectionId: "conn-1",
          sig,
        }),
      ).toBe(false);
    });

    it("rejects a signature of the wrong length without throwing", () => {
      expect(
        verifyConnectRedirectSignature("acsec_x", {
          session: "acs_tok",
          status: "active",
          connectionId: "conn-1",
          sig: "deadbeef",
        }),
      ).toBe(false);
    });
  });
});
