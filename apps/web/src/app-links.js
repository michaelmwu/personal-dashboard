const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function locationUrl(browserLocation) {
  if (!browserLocation) {
    return null;
  }
  try {
    return new URL(browserLocation.href ?? String(browserLocation));
  } catch {
    return null;
  }
}

export function appDeepLink(manifest, browserLocation = globalThis.location) {
  const hasUiUrl = Object.hasOwn(manifest ?? {}, "uiUrl");
  const configuredBaseUrl = String(
    hasUiUrl ? (manifest?.uiUrl ?? "") : (manifest?.baseUrl ?? "")
  ).trim();
  if (!/^https?:\/\//i.test(configuredBaseUrl)) {
    return "";
  }

  try {
    const baseUrl = new URL(configuredBaseUrl);
    const browserUrl = locationUrl(browserLocation);
    if (
      !hasUiUrl &&
      loopbackHosts.has(baseUrl.hostname) &&
      browserUrl &&
      ["http:", "https:"].includes(browserUrl.protocol) &&
      !loopbackHosts.has(browserUrl.hostname)
    ) {
      baseUrl.protocol = browserUrl.protocol;
      baseUrl.hostname = browserUrl.hostname;
    }
    return new URL(manifest?.deepLink || "/", baseUrl).toString();
  } catch {
    return "";
  }
}
