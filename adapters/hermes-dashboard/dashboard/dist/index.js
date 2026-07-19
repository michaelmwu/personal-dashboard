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

  function isSummary(value) {
    return (
      isRecord(value) &&
      typeof value.version === "string" &&
      typeof value.generatedAt === "string" &&
      isRecord(value.health) &&
      typeof value.health.level === "string" &&
      typeof value.health.summary === "string" &&
      Array.isArray(value.metrics) &&
      Array.isArray(value.alerts) &&
      Array.isArray(value.travel) &&
      Array.isArray(value.tasks)
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

  function PersonalDashboardPage() {
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    const load = useCallback(async () => {
      setLoading(true);
      setFailed(false);
      try {
        const response = await SDK.fetchJSON("/api/plugins/personal-dashboard/summary");
        if (!isSummary(response)) {
          throw new Error("invalid_summary_contract");
        }
        setSummary(response);
      } catch {
        setSummary(null);
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    if (loading) {
      return create(
        "main",
        { className: "personal-dashboard-hermes-page", "aria-busy": "true" },
        create(
          "p",
          { className: "personal-dashboard-hermes-status" },
          "Loading Personal Dashboard…"
        )
      );
    }

    if (failed || !summary) {
      return create(
        "main",
        { className: "personal-dashboard-hermes-page" },
        create("h1", { className: "personal-dashboard-hermes-title" }, "Personal Dashboard"),
        create(
          "p",
          { className: "personal-dashboard-hermes-status", role: "alert" },
          "The dashboard summary is unavailable. Confirm that the local dashboard API is running, then retry."
        ),
        create(
          "button",
          { className: "personal-dashboard-hermes-retry", onClick: load, type: "button" },
          "Retry"
        )
      );
    }

    return create(
      "main",
      { className: "personal-dashboard-hermes-page" },
      create(
        "header",
        { className: "personal-dashboard-hermes-header" },
        create(
          "div",
          null,
          create("h1", { className: "personal-dashboard-hermes-title" }, "Personal Dashboard")
        ),
        create(
          "div",
          {
            className: "personal-dashboard-hermes-health",
            "data-level": readable(summary.health.level, "unknown")
          },
          create("strong", null, readable(summary.health.level, "Unknown")),
          create("span", null, readable(summary.health.summary))
        )
      ),
      create(
        "p",
        { className: "personal-dashboard-hermes-updated" },
        `Updated ${readable(summary.generatedAt)}`
      ),
      create(Metrics, { metrics: summary.metrics }),
      create(
        "div",
        { className: "personal-dashboard-hermes-grid" },
        create(SummaryList, {
          heading: "Alerts",
          items: summary.alerts,
          emptyLabel: "No active alerts."
        }),
        create(SummaryList, {
          heading: "Travel",
          items: summary.travel,
          emptyLabel: "No travel items need attention."
        }),
        create(SummaryList, {
          heading: "Tasks",
          items: summary.tasks,
          emptyLabel: "No active tasks."
        })
      )
    );
  }

  registry.register(PLUGIN_NAME, PersonalDashboardPage);
})();
