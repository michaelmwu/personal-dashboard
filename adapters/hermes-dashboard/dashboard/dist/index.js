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
        if (!isViewport(response, selected.id)) {
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
          create("h1", { className: "personal-dashboard-hermes-title" }, "Personal Dashboard"),
          create(
            "p",
            { className: "personal-dashboard-hermes-updated" },
            current ? `Updated ${readable(current.generatedAt)}` : "Loading live dashboard data…"
          )
        ),
        current
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
                create(SourceState, { source: current.source }),
                create(ViewportContent, { viewport: current })
              )
            : null
    );
  }

  registry.register(PLUGIN_NAME, PersonalDashboardPage);
})();
