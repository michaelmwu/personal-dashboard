import { describe, expect, test } from "bun:test";

import { appDeepLink } from "../apps/web/src/app-links.js";

describe("dashboard app links", () => {
  test("prefers an explicit browser UI URL", () => {
    expect(
      appDeepLink(
        {
          id: "hotel-rate-finder",
          baseUrl: "http://127.0.0.1:8720",
          uiUrl: "https://rates.example.ts.net:9443/",
          deepLink: "/history"
        },
        "https://dashboard.example.ts.net:8811/travel"
      )
    ).toBe("https://rates.example.ts.net:9443/history");
  });

  test("maps a legacy loopback app URL onto the browser host during rolling deploys", () => {
    expect(
      appDeepLink(
        {
          id: "hotel-rate-finder",
          baseUrl: "http://127.0.0.1:8720",
          deepLink: "/"
        },
        "https://moo-tokyo-minibox.example.ts.net:8811/travel"
      )
    ).toBe("https://moo-tokyo-minibox.example.ts.net:8720/");
  });

  test("keeps explicit empty UI URLs disabled and rejects unsafe schemes", () => {
    expect(
      appDeepLink(
        {
          id: "hotel-rate-finder",
          baseUrl: "http://127.0.0.1:8720",
          uiUrl: "",
          deepLink: "/"
        },
        "https://dashboard.example.ts.net:8811/travel"
      )
    ).toBe("");
    expect(appDeepLink({ baseUrl: "javascript:alert(1)", deepLink: "/" })).toBe("");
  });
});
