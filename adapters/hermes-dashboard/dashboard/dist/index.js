// biome-ignore lint/complexity/useArrowFunction: Hermes loads this as a classic script.
(function () {
  // biome-ignore lint/suspicious/noRedundantUseStrict: Hermes loads this as a classic script.
  "use strict";

  const PLUGIN_NAME = "personal-dashboard";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const registry = window.__HERMES_PLUGINS__;

  if (!SDK || !registry || !SDK.React || !SDK.hooks || !SDK.fetchJSON) {
    return;
  }

  const { React } = SDK;
  const { useCallback, useEffect, useState } = SDK.hooks;
  const create = React.createElement;
  const VIEWPORTS = [
    {
      id: "overview",
      label: "Overview",
      endpoint: "/api/plugins/personal-dashboard/overview"
    },
    {
      id: "hotel-rate-finder",
      label: "Hotel Rate Finder",
      endpoint: "/api/plugins/personal-dashboard/hotel-rate-finder"
    },
    {
      id: "asia-travel-deals",
      label: "Asia Travel Deals",
      endpoint: "/api/plugins/personal-dashboard/asia-travel-deals"
    },
    {
      id: "award-flights",
      label: "Award Flights",
      endpoint: "/api/plugins/personal-dashboard/flight-searches"
    }
  ];

  function readable(value, fallback) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return fallback || "—";
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isSource(source) {
    return (
      isRecord(source) &&
      typeof source.id === "string" &&
      typeof source.status === "string" &&
      typeof source.summary === "string"
    );
  }

  function isViewport(value, viewport) {
    if (
      !isRecord(value) ||
      value.version !== "host-dashboard-viewport.v1" ||
      value.viewport !== viewport ||
      typeof value.generatedAt !== "string" ||
      !isRecord(value.health) ||
      typeof value.health.level !== "string" ||
      typeof value.health.summary !== "string" ||
      !isSource(value.source)
    ) {
      return false;
    }

    if (viewport === "overview") {
      return ["metrics", "alerts", "travel", "tasks"].every((key) => Array.isArray(value[key]));
    }
    return Array.isArray(value.items);
  }

  function isFlightFeed(value) {
    return (
      isRecord(value) &&
      typeof value.ok === "boolean" &&
      value.emailAccess === false &&
      Array.isArray(value.searches)
    );
  }

  function itemTitle(item, fallback) {
    if (!isRecord(item)) {
      return fallback;
    }
    return readable(item.title || item.label || item.name || item.id, fallback);
  }

  function itemDetail(item) {
    if (!isRecord(item)) {
      return "";
    }
    return readable(
      item.detail ||
        item.summary ||
        item.description ||
        item.status ||
        item.source ||
        item.severity,
      ""
    );
  }

  function SourceState(props) {
    const source = props.source;
    return create(
      "section",
      {
        className: "personal-dashboard-hermes-source",
        "data-status": readable(source.status, "unknown")
      },
      create("strong", null, readable(source.status, "Unknown")),
      create("span", null, readable(source.summary)),
      source.updatedAt
        ? create(
            "small",
            { className: "personal-dashboard-hermes-source-updated" },
            `Freshness: ${readable(source.updatedAt)}`
          )
        : null
    );
  }

  function SummaryList(props) {
    const { heading, items, emptyLabel } = props;
    const list = Array.isArray(items) ? items.slice(0, 6) : [];

    return create(
      "section",
      { className: "personal-dashboard-hermes-section" },
      create("h2", { className: "personal-dashboard-hermes-section-title" }, heading),
      list.length
        ? create(
            "ul",
            { className: "personal-dashboard-hermes-list" },
            list.map((item, index) =>
              create(
                "li",
                { className: "personal-dashboard-hermes-list-item", key: `${heading}-${index}` },
                create(
                  "span",
                  { className: "personal-dashboard-hermes-item-title" },
                  itemTitle(item, "Untitled item")
                ),
                create(
                  "span",
                  { className: "personal-dashboard-hermes-item-detail" },
                  itemDetail(item)
                )
              )
            )
          )
        : create("p", { className: "personal-dashboard-hermes-empty" }, emptyLabel)
    );
  }

  function Metrics(props) {
    const metrics = Array.isArray(props.metrics) ? props.metrics.slice(0, 6) : [];
    if (!metrics.length) {
      return create(
        "p",
        { className: "personal-dashboard-hermes-empty" },
        "No live metrics have been received yet."
      );
    }
    return create(
      "section",
      { className: "personal-dashboard-hermes-metrics", "aria-label": "Dashboard metrics" },
      metrics.map((metric, index) =>
        create(
          "article",
          { className: "personal-dashboard-hermes-metric", key: `metric-${index}` },
          create(
            "span",
            { className: "personal-dashboard-hermes-metric-label" },
            itemTitle(metric, "Metric")
          ),
          create(
            "strong",
            { className: "personal-dashboard-hermes-metric-value" },
            readable(isRecord(metric) ? metric.value : undefined)
          ),
          isRecord(metric) && metric.delta
            ? create(
                "span",
                { className: "personal-dashboard-hermes-metric-delta" },
                readable(metric.delta)
              )
            : null
        )
      )
    );
  }

  function OverviewViewport(props) {
    const viewport = props.viewport;
    return create(
      React.Fragment,
      null,
      create(Metrics, { metrics: viewport.metrics }),
      create(
        "div",
        { className: "personal-dashboard-hermes-grid" },
        create(SummaryList, {
          heading: "Alerts",
          items: viewport.alerts,
          emptyLabel: "No active alerts."
        }),
        create(SummaryList, {
          heading: "Travel",
          items: viewport.travel,
          emptyLabel: "No travel items need attention."
        }),
        create(SummaryList, {
          heading: "Tasks",
          items: viewport.tasks,
          emptyLabel: "No active tasks."
        })
      )
    );
  }

  function hotelRateDetail(item) {
    const dates = [item.checkIn, item.checkOut].filter(Boolean).join(" to ");
    const rates = [];
    if (typeof item.bestRate === "number") {
      rates.push(`Best ${item.currency || "USD"} ${item.bestRate}`);
    }
    if (typeof item.targetRate === "number") {
      rates.push(`Target ${item.currency || "USD"} ${item.targetRate}`);
    }
    return [item.location, dates, rates.join(" · "), item.status].filter(Boolean).join(" · ");
  }

  function asiaTravelDealDetail(item) {
    const price = typeof item.price === "number" ? `${item.currency || "USD"} ${item.price}` : "";
    const score = typeof item.score === "number" ? `Score ${item.score}` : "";
    return [item.route, price, score, item.verificationStatus || item.status]
      .filter(Boolean)
      .join(" · ");
  }

  function SourceItemList(props) {
    const { heading, items, emptyLabel, detail } = props;
    const list = Array.isArray(items) ? items.slice(0, 12) : [];
    return create(
      "section",
      { className: "personal-dashboard-hermes-section" },
      create("h2", { className: "personal-dashboard-hermes-section-title" }, heading),
      list.length
        ? create(
            "ul",
            { className: "personal-dashboard-hermes-list" },
            list.map((item, index) =>
              create(
                "li",
                { className: "personal-dashboard-hermes-list-item", key: item.id || index },
                create(
                  "span",
                  { className: "personal-dashboard-hermes-item-title" },
                  readable(item.property || item.title, "Untitled item")
                ),
                create("span", { className: "personal-dashboard-hermes-item-detail" }, detail(item))
              )
            )
          )
        : create("p", { className: "personal-dashboard-hermes-empty" }, emptyLabel)
    );
  }

  function ViewportContent(props) {
    const viewport = props.viewport;
    if (viewport.viewport === "overview") {
      return create(OverviewViewport, { viewport });
    }
    if (viewport.viewport === "hotel-rate-finder") {
      return create(SourceItemList, {
        heading: "Hotel rate watches",
        items: viewport.items,
        emptyLabel: "No hotel rate watches have been received yet.",
        detail: hotelRateDetail
      });
    }
    return create(SourceItemList, {
      heading: "Asia deal candidates",
      items: viewport.items,
      emptyLabel: "No Asia Travel Deals candidates have been received yet.",
      detail: asiaTravelDealDetail
    });
  }

  function flightRoute(request) {
    if (!isRecord(request)) return "Award search";
    const origins = Array.isArray(request.origins) ? request.origins.join(", ") : "?";
    const destinations = Array.isArray(request.destinations)
      ? request.destinations.join(", ")
      : "?";
    const dates = [request.departureStart, request.departureEnd]
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index)
      .join(" – ");
    return `${origins} → ${destinations}${dates ? ` · ${dates}` : ""}`;
  }

  function providerLabel(provider) {
    return provider === "seats_aero"
      ? "Seats.aero"
      : provider === "eva"
        ? "EVA"
        : String(provider || "provider").toUpperCase();
  }

  function FlightChallenge(props) {
    const { challenge, jobId, refresh } = props;
    const [value, setValue] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const directEntry = ["sms_otp", "email_otp", "captcha"].includes(challenge.kind);
    const base = `/api/plugins/personal-dashboard/flight-searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challenge.id)}`;

    async function submit(event) {
      event.preventDefault();
      if (!value.trim() || submitting) return;
      setSubmitting(true);
      setError("");
      try {
        await SDK.fetchJSON(`${base}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: value.trim() })
        });
        setValue("");
        await refresh();
      } catch (submitError) {
        setError(submitError?.message ? submitError.message : "Submission failed.");
      } finally {
        setSubmitting(false);
      }
    }

    return create(
      "section",
      { className: "personal-dashboard-hermes-challenge" },
      create("strong", null, `${providerLabel(challenge.provider)} needs you`),
      create("p", null, readable(challenge.prompt, "Complete the verification step.")),
      challenge.screenshotAvailable
        ? create("img", {
            alt: `${providerLabel(challenge.provider)} verification preview`,
            className: "personal-dashboard-hermes-challenge-image",
            src: `${base}/screenshot?t=${Date.now()}`
          })
        : null,
      directEntry
        ? create(
            "form",
            { className: "personal-dashboard-hermes-challenge-form", onSubmit: submit },
            create(
              "label",
              { htmlFor: `challenge-${challenge.id}` },
              challenge.kind === "captcha" ? "CAPTCHA" : "Verification code"
            ),
            create("input", {
              autoComplete: challenge.kind === "captcha" ? "off" : "one-time-code",
              id: `challenge-${challenge.id}`,
              inputMode: challenge.kind === "captcha" ? "text" : "numeric",
              maxLength: 256,
              onChange: (event) => setValue(event.target.value),
              spellCheck: false,
              type: "text",
              value
            }),
            create(
              "button",
              { disabled: !value.trim() || submitting, type: "submit" },
              submitting ? "Submitting…" : "Submit"
            ),
            error
              ? create(
                  "span",
                  { className: "personal-dashboard-hermes-inline-error", role: "alert" },
                  error
                )
              : null
          )
        : create(
            "a",
            {
              className: "personal-dashboard-hermes-link",
              href: `https://${window.location.hostname}:8811/flights`,
              rel: "noreferrer",
              target: "_blank"
            },
            "Open browser controls"
          )
    );
  }

  function AwardFlightsViewport(props) {
    const { feed, refresh } = props;
    const searches = Array.isArray(feed.searches) ? feed.searches : [];

    async function cancel(jobId) {
      await SDK.fetchJSON(
        `/api/plugins/personal-dashboard/flight-searches/${encodeURIComponent(jobId)}/cancel`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
      );
      await refresh();
    }

    return create(
      "div",
      { className: "personal-dashboard-hermes-flight-list" },
      searches.length
        ? searches.map((search) => {
            const providers = Object.entries(isRecord(search.providers) ? search.providers : {});
            const active = ["queued", "running", "waiting_human"].includes(search.status);
            return create(
              "article",
              { className: "personal-dashboard-hermes-flight", key: search.id },
              create(
                "header",
                null,
                create(
                  "div",
                  null,
                  create("h2", null, flightRoute(search.request)),
                  create("small", null, readable(search.id))
                ),
                create(
                  "span",
                  { "data-state": readable(search.status, "unknown") },
                  readable(search.status, "unknown")
                ),
                active
                  ? create(
                      "button",
                      { onClick: () => void cancel(search.id), type: "button" },
                      "Cancel"
                    )
                  : null
              ),
              create(
                "div",
                { className: "personal-dashboard-hermes-provider-grid" },
                providers.map(([provider, run]) =>
                  create(
                    "section",
                    {
                      className: "personal-dashboard-hermes-provider",
                      key: provider,
                      "data-state": readable(run.state, "unknown")
                    },
                    create("strong", null, providerLabel(provider)),
                    create("span", null, readable(run.state, "unknown")),
                    run.queuePosition
                      ? create("small", null, `${run.queuePosition} in queue`)
                      : null,
                    typeof run.resultCount === "number"
                      ? create(
                          "small",
                          null,
                          `${run.resultCount} result${run.resultCount === 1 ? "" : "s"}`
                        )
                      : null,
                    run.message ? create("small", null, readable(run.message)) : null,
                    run.challenge
                      ? create(FlightChallenge, {
                          challenge: run.challenge,
                          jobId: search.id,
                          refresh
                        })
                      : null
                  )
                )
              ),
              Array.isArray(search.results) && search.results.length
                ? create(
                    "details",
                    null,
                    create(
                      "summary",
                      null,
                      `${search.results.length} result${search.results.length === 1 ? "" : "s"}`
                    ),
                    create(
                      "ul",
                      { className: "personal-dashboard-hermes-flight-results" },
                      search.results
                        .slice(0, 10)
                        .map((result, index) =>
                          create(
                            "li",
                            { key: result.id || index },
                            create(
                              "strong",
                              null,
                              `${readable(result.origin, "?")} → ${readable(result.destination, "?")}`
                            ),
                            create(
                              "span",
                              null,
                              [
                                result.date || result.departureDate,
                                result.cabin,
                                result.mileage ? `${result.mileage} points` : "",
                                result.taxes !== null && result.taxes !== undefined
                                  ? `+ ${result.taxes} ${result.taxCurrency || ""}`.trim()
                                  : "",
                                result.provider ? providerLabel(result.provider) : ""
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            )
                          )
                        )
                    )
                  )
                : null
            );
          })
        : create("p", { className: "personal-dashboard-hermes-empty" }, "No recent award searches.")
    );
  }

  function PersonalDashboardPage() {
    const [activeViewport, setActiveViewport] = useState("overview");
    const [viewports, setViewports] = useState({});
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    const load = useCallback(async (viewportId) => {
      const selected = VIEWPORTS.find((viewport) => viewport.id === viewportId) || VIEWPORTS[0];
      setLoading(true);
      setFailed(false);
      try {
        const response = await SDK.fetchJSON(selected.endpoint);
        if (
          (selected.id === "award-flights" && !isFlightFeed(response)) ||
          (selected.id !== "award-flights" && !isViewport(response, selected.id))
        ) {
          throw new Error("invalid_viewport_contract");
        }
        setViewports((current) => ({ ...current, [selected.id]: response }));
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      void load(activeViewport);
    }, [activeViewport, load]);

    useEffect(() => {
      if (activeViewport !== "award-flights") return undefined;
      const timer = window.setInterval(() => void load("award-flights"), 5000);
      return () => window.clearInterval(timer);
    }, [activeViewport, load]);

    const current = viewports[activeViewport];
    const activeDefinition =
      VIEWPORTS.find((viewport) => viewport.id === activeViewport) || VIEWPORTS[0];

    return create(
      "main",
      { className: "personal-dashboard-hermes-page", "aria-busy": loading ? "true" : undefined },
      create(
        "header",
        { className: "personal-dashboard-hermes-header" },
        create(
          "div",
          null,
          create("h1", { className: "personal-dashboard-hermes-title" }, "MooHQ"),
          create(
            "p",
            { className: "personal-dashboard-hermes-updated" },
            current
              ? current.generatedAt
                ? `Updated ${readable(current.generatedAt)}`
                : "Live status refreshes every 5 seconds"
              : "Loading live dashboard data…"
          )
        ),
        current?.health
          ? create(
              "div",
              {
                className: "personal-dashboard-hermes-health",
                "data-level": readable(current.health.level, "unknown")
              },
              create("strong", null, readable(current.health.level, "Unknown")),
              create("span", null, readable(current.health.summary))
            )
          : null
      ),
      create(
        "div",
        {
          className: "personal-dashboard-hermes-tabs",
          role: "tablist",
          "aria-label": "Dashboard viewports"
        },
        VIEWPORTS.map((viewport) =>
          create(
            "button",
            {
              className: "personal-dashboard-hermes-tab",
              "aria-selected": viewport.id === activeViewport ? "true" : "false",
              key: viewport.id,
              onClick: () => setActiveViewport(viewport.id),
              role: "tab",
              type: "button"
            },
            viewport.label
          )
        )
      ),
      failed
        ? create(
            "section",
            { className: "personal-dashboard-hermes-status", role: "alert" },
            create(
              "p",
              null,
              `The ${activeDefinition.label} viewport is unavailable. Confirm that the local dashboard API is running, then retry.`
            ),
            create(
              "button",
              {
                className: "personal-dashboard-hermes-retry",
                onClick: () => load(activeViewport),
                type: "button"
              },
              "Retry"
            )
          )
        : loading && !current
          ? create(
              "p",
              { className: "personal-dashboard-hermes-status" },
              `Loading ${activeDefinition.label}…`
            )
          : current
            ? create(
                "div",
                { className: "personal-dashboard-hermes-viewport", role: "tabpanel" },
                activeViewport === "award-flights"
                  ? create(AwardFlightsViewport, {
                      feed: current,
                      refresh: () => load("award-flights")
                    })
                  : create(
                      React.Fragment,
                      null,
                      create(SourceState, { source: current.source }),
                      create(ViewportContent, { viewport: current })
                    )
              )
            : null
    );
  }

  registry.register(PLUGIN_NAME, PersonalDashboardPage);
})();
