import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertEnabledGatewayConfig,
  emailGatewayConfig,
  GMAIL_READONLY_SCOPE,
  gatewayEnvironment,
  parseStrictDotenv
} from "../apps/email-gateway/config.mjs";
import { gmailHistory } from "../apps/email-gateway/gmail-client.mjs";
import {
  compileEmailSearch,
  createSearchReceipt,
  parseTransactionCandidate,
  sanitizedMessageText
} from "../apps/email-gateway/policy.mjs";
import { decryptGatewayRecord, encryptGatewayRecord } from "../apps/email-gateway/secure-store.mjs";
import { createEmailGatewayServer } from "../apps/email-gateway/server.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function gatewayConfig(dataDirectory) {
  return emailGatewayConfig({
    EMAIL_GATEWAY_ENABLED: "true",
    EMAIL_GATEWAY_HOST: "127.0.0.1",
    EMAIL_GATEWAY_ALLOWED_EMAIL: "only-me@example.test",
    EMAIL_GATEWAY_OAUTH_CLIENT_ID: "oauth-client-id",
    EMAIL_GATEWAY_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    EMAIL_GATEWAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    EMAIL_GATEWAY_ADMIN_TOKEN: "admin-token",
    EMAIL_GATEWAY_CONSUMER_TOKEN: "consumer-token",
    EMAIL_GATEWAY_DATA_DIR: dataDirectory
  });
}

describe("email gateway policy", () => {
  test("parses gateway dotenv values as data rather than shell instructions", () => {
    expect(parseStrictDotenv("TOKEN=abc\nUNSAFE=$(touch /tmp/nope)\n")).toEqual({
      TOKEN: "abc",
      UNSAFE: "$(touch /tmp/nope)"
    });
    expect(() => parseStrictDotenv("export TOKEN=abc\n")).toThrow("Use only KEY=VALUE");
  });

  test("requires a private gateway dotenv file", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "personal-dashboard-email-gateway-env-"));
    const envFile = join(dataDirectory, ".env.email-gateway");
    try {
      await writeFile(envFile, "PRIVATE_VALUE=from-file\n", { mode: 0o600 });
      await chmod(envFile, 0o600);
      await expect(
        gatewayEnvironment({ EMAIL_GATEWAY_ENV_FILE: envFile, PRIVATE_VALUE: "from-runtime" })
      ).resolves.toMatchObject({ PRIVATE_VALUE: "from-runtime" });

      await chmod(envFile, 0o644);
      await expect(gatewayEnvironment({ EMAIL_GATEWAY_ENV_FILE: envFile })).rejects.toThrow(
        "must not be readable by group or others"
      );
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  test("requires a gateway-owned state directory when enabled", () => {
    const config = emailGatewayConfig({
      EMAIL_GATEWAY_ENABLED: "true",
      EMAIL_GATEWAY_HOST: "127.0.0.1",
      EMAIL_GATEWAY_ALLOWED_EMAIL: "only-me@example.test",
      EMAIL_GATEWAY_OAUTH_CLIENT_ID: "oauth-client-id",
      EMAIL_GATEWAY_OAUTH_CLIENT_SECRET: "oauth-client-secret",
      EMAIL_GATEWAY_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      EMAIL_GATEWAY_ADMIN_TOKEN: "admin-token",
      EMAIL_GATEWAY_CONSUMER_TOKEN: "consumer-token"
    });
    expect(() => assertEnabledGatewayConfig(config)).toThrow("EMAIL_GATEWAY_DATA_DIR");
  });

  test("compiles bounded structured Gmail searches without accepting raw syntax", () => {
    expect(
      compileEmailSearch(
        {
          purpose: "interactive-search",
          filters: {
            keywords: ["hotel receipt"],
            from: ["reservations@example.test"],
            after: "2026-08-01T00:00:00+09:00",
            before: "2026-08-02T00:00:00+09:00",
            labels: ["INBOX"]
          },
          limit: 5
        },
        { maxResults: 25 }
      )
    ).toMatchObject({
      purpose: "interactive-search",
      limit: 5,
      query: expect.stringContaining("from:reservations@example.test")
    });

    expect(() =>
      compileEmailSearch({ purpose: "interactive-search", query: "in:anywhere" })
    ).toThrow("Raw Gmail query strings are not accepted.");
    expect(() =>
      compileEmailSearch({
        purpose: "scheduled-scan",
        filters: { keywords: ["receipt"] }
      })
    ).toThrow("scheduled-scan requires an after timestamp.");
  });

  test("omits text attachments, including nested attachment parts, and redacts authentication material", () => {
    const message = {
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: Buffer.from(
                "Your verification code is 123456. https://example.test/password/reset?id=1"
              ).toString("base64url")
            }
          },
          {
            mimeType: "text/plain",
            body: {
              attachmentId: "never-fetch-this",
              data: Buffer.from("private attachment text").toString("base64url")
            }
          },
          {
            mimeType: "text/plain",
            filename: "also-private.txt",
            body: {
              data: Buffer.from("small inline attachment text").toString("base64url")
            }
          },
          {
            mimeType: "text/plain",
            headers: [{ name: "Content-Disposition", value: "attachment" }],
            body: {
              data: Buffer.from("disposition attachment text").toString("base64url")
            }
          },
          {
            mimeType: "multipart/mixed",
            filename: "nested-message.eml",
            parts: [
              {
                mimeType: "text/plain",
                body: {
                  data: Buffer.from("nested attachment text").toString("base64url")
                }
              }
            ]
          }
        ]
      }
    };
    const text = sanitizedMessageText(message);
    expect(text).toContain("[REDACTED AUTH CODE]");
    expect(text).toContain("[REDACTED RESET LINK]");
    expect(text).not.toContain("private attachment text");
    expect(text).not.toContain("small inline attachment text");
    expect(text).not.toContain("disposition attachment text");
    expect(text).not.toContain("nested attachment text");
  });

  test("keeps raw Gmail message ids inside opaque receipts only", () => {
    const receipt = createSearchReceipt(
      [
        {
          id: "gmail-internal-message-id",
          internalDate: "1785542400000",
          labelIds: ["INBOX"],
          snippet: "A receipt",
          payload: { headers: [{ name: "Subject", value: "Receipt" }] }
        }
      ],
      { ttlSeconds: 900, now: 0 }
    );
    expect(receipt.results[0]).not.toHaveProperty("id");
    expect(receipt.results[0].handle).not.toBe("gmail-internal-message-id");
    expect(receipt.handles.get(receipt.results[0].handle)).toBe("gmail-internal-message-id");
  });

  test("requires Gmail-verified DMARC before creating a transaction candidate", () => {
    const parser = {
      id: "issuer-notification.v1",
      senders: ["alerts@issuer.example"],
      authenticatedDomains: ["issuer.example"],
      amountPattern: "Amount: \\$([0-9.]+)",
      merchantPattern: "Merchant: ([A-Za-z ]+)",
      currency: "USD"
    };
    const message = {
      id: "gmail-internal-message-id",
      internalDate: "1785542400000",
      payload: {
        headers: [
          {
            name: "Authentication-Results",
            value: "mx.google.com; dmarc=pass header.from=issuer.example"
          },
          { name: "From", value: "Issuer Alerts <alerts@issuer.example>" },
          { name: "Subject", value: "Card purchase" }
        ],
        mimeType: "text/plain",
        body: {
          data: Buffer.from("Merchant: Neighborhood Market\\nAmount: $42.50").toString("base64url")
        }
      }
    };

    expect(parseTransactionCandidate(message, [parser])).toMatchObject({
      merchant: "Neighborhood Market",
      amount: 42.5,
      currency: "USD",
      externalId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
    });
    expect(
      parseTransactionCandidate(
        {
          ...message,
          payload: {
            ...message.payload,
            headers: [
              {
                name: "Authentication-Results",
                value: "mx.google.com; dmarc=fail header.from=issuer.example"
              },
              ...message.payload.headers.slice(1)
            ]
          }
        },
        [parser]
      )
    ).toBeUndefined();
    expect(
      parseTransactionCandidate(message, [{ ...parser, authenticatedDomains: undefined }])
    ).toBeUndefined();
  });

  test("uses authenticated encryption for local credential records", () => {
    const key = Buffer.alloc(32, 9);
    const encrypted = encryptGatewayRecord({ refreshToken: "secret" }, key);
    expect(JSON.stringify(encrypted)).not.toContain("secret");
    expect(decryptGatewayRecord(encrypted, key)).toEqual({ refreshToken: "secret" });
    expect(() =>
      decryptGatewayRecord({ ...encrypted, tag: "a".repeat(encrypted.tag.length) }, key)
    ).toThrow();
  });

  test("passes a persisted Gmail history page token without advancing its cursor", async () => {
    const requests = [];
    await gmailHistory(
      {},
      {
        read: async () => ({
          accessToken: "access-token",
          scope: GMAIL_READONLY_SCOPE,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        }),
        write: async () => {}
      },
      "12345",
      { pageToken: "next-page-token" },
      async (url) => {
        requests.push(new URL(url));
        return Response.json({ history: [], historyId: "12346" });
      }
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("startHistoryId")).toBe("12345");
    expect(requests[0].searchParams.get("pageToken")).toBe("next-page-token");
  });
});

describe("email gateway HTTP boundary", () => {
  test("exposes fixed read-only endpoints and separates admin from consumer authority", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "personal-dashboard-email-gateway-"));
    const config = gatewayConfig(dataDirectory);
    assertEnabledGatewayConfig(config);
    const server = createEmailGatewayServer({ config });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        status: "ok",
        connected: false,
        scope: GMAIL_READONLY_SCOPE
      });

      const unauthorizedSearch = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "interactive-search", filters: { keywords: ["receipt"] } })
      });
      expect(unauthorizedSearch.status).toBe(401);

      const adminCannotSearch = await fetch(`${baseUrl}/v1/search`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "interactive-search", filters: { keywords: ["receipt"] } })
      });
      expect(adminCannotSearch.status).toBe(401);

      const oauthStart = await fetch(`${baseUrl}/v1/oauth/start`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-token" }
      });
      const oauth = await oauthStart.json();
      expect(oauthStart.status).toBe(200);
      expect(new URL(oauth.authorizationUrl).searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);

      const forbiddenMutation = await fetch(`${baseUrl}/v1/messages/delete`, {
        method: "POST",
        headers: { Authorization: "Bearer admin-token" }
      });
      expect(forbiddenMutation.status).toBe(404);
    } finally {
      await close(server);
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
