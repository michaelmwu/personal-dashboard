import { describe, expect, test } from "bun:test";

import {
  gmailGatewayConfig,
  readGmailGatewayMessages,
  searchGmailGateway
} from "../packages/integrations/gmail-proxy.mjs";

describe("Gmail gateway dashboard client", () => {
  test("requires a secure or loopback gateway base URL and a distinct token", () => {
    expect(
      gmailGatewayConfig({
        EMAIL_GATEWAY_API_BASE_URL: "http://gateway.example.test",
        EMAIL_GATEWAY_DASHBOARD_TOKEN: "gateway-token"
      }).configured
    ).toBe(false);

    expect(
      gmailGatewayConfig({
        EMAIL_GATEWAY_API_BASE_URL: "https://gateway.example.test/",
        EMAIL_GATEWAY_DASHBOARD_TOKEN: "gateway-token"
      })
    ).toMatchObject({
      configured: true,
      baseUrl: "https://gateway.example.test",
      token: "gateway-token"
    });
  });

  test("calls only the fixed search and receipt-bound message routes", async () => {
    const requests = [];
    const options = {
      config: {
        configured: true,
        baseUrl: "http://127.0.0.1:9911",
        token: "gateway-token",
        timeoutMs: 500
      },
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({ receiptId: "receipt_123", messages: [] });
      }
    };

    const search = await searchGmailGateway(
      { purpose: "interactive-search", filters: { keywords: ["receipt"] } },
      options
    );
    const read = await readGmailGatewayMessages(
      { receipt: "receipt_123", handle: "message_handle_123" },
      options
    );

    expect(search).toMatchObject({ ok: true, status: 200, body: { receiptId: "receipt_123" } });
    expect(read).toMatchObject({ ok: true, status: 200, body: { receiptId: "receipt_123" } });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/search",
      "/v1/messages/read"
    ]);
    expect(requests[0].init.headers.Authorization).toBe("Bearer gateway-token");
    expect(requests[0].init.method).toBe("POST");
  });

  test("fails closed when the gateway is unconfigured", async () => {
    await expect(
      searchGmailGateway(
        { purpose: "interactive-search", filters: { keywords: ["receipt"] } },
        { config: { configured: false, baseUrl: "", token: "", timeoutMs: 100 } }
      )
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      body: { error: "email_gateway_unavailable" }
    });
  });
});
