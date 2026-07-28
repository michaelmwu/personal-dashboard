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
      endpoint: "/api/plugins/personal-dashboard/overview"
    },
    {
      id: "hotel-rate-finder",
      endpoint: "/api/plugins/personal-dashboard/hotel-rate-finder"
    },
    {
      id: "asia-travel-deals",
      endpoint: "/api/plugins/personal-dashboard/asia-travel-deals"
    }
  ];

  const REVIEW_STATUSES = new Set(["action-needed", "blocked", "failed", "needs-review", "review"]);

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

  function normalizedStatus(value) {
    return readable(value, "unknown").toLowerCase().replaceAll("_", "-");
  }

  function humanizeStatus(value) {
    return normalizedStatus(value)
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  function needsReview(value) {
    return REVIEW_STATUSES.has(normalizedStatus(value));
  }

  function sourceFailed(viewport) {
    return (
      !viewport ||
      normalizedStatus(viewport.source?.status) === "error" ||
      normalizedStatus(viewport.health?.level) === "error"
    );
  }

  function formatMoney(value, currency) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "—";
    }
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: readable(currency, "USD"),
        maximumFractionDigits: 0
      }).format(value);
    } catch {
      return `${readable(currency, "USD")} ${value.toFixed(0)}`;
    }
  }

  function compactDate(value) {
    if (typeof value !== "string" || !value.trim()) {
      return "";
    }
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }

  function dateRange(start, end) {
    return [compactDate(start), compactDate(end)].filter(Boolean).join("–");
  }

  function rateSavings(item) {
    const targetRate = Number(item?.targetRate);
    const bestRate = Number(item?.bestRate);
    if (!Number.isFinite(targetRate) || !Number.isFinite(bestRate)) {
      return null;
    }
    return targetRate - bestRate;
  }

  function formatFreshness(value) {
    if (!value) {
      return "Not synced yet";
    }
    try {
      const relative = SDK.utils?.isoTimeAgo?.(value);
      if (relative) {
        return `Synced ${relative}`;
      }
    } catch {
      // Use the timestamp fallback below when the host utility rejects it.
    }
    return `Synced ${readable(value)}`;
  }

  function latestTimestamp(portholes) {
    const timestamps = portholes
      .map((porthole) => porthole.freshness)
      .filter((value) => typeof value === "string" && !Number.isNaN(Date.parse(value)))
      .sort();
    return timestamps.at(-1) || "";
  }

  function porthole({
    id,
    label,
    icon,
    state,
    summary,
    freshness,
    badge,
    highlight,
    items,
    action,
    featured
  }) {
    return {
      id,
      label,
      icon,
      state,
      summary,
      freshness,
      badge,
      highlight,
      items: Array.isArray(items) ? items.slice(0, 3) : [],
      action,
      featured: Boolean(featured)
    };
  }

  function unavailablePorthole({ id, label, icon, action }) {
    return porthole({
      id,
      label,
      icon,
      state: "degraded",
      summary: "This window could not be loaded. Its data may be stale.",
      freshness: "",
      badge: "Unavailable",
      action
    });
  }

  function financePorthole(overview, unavailable) {
    if (unavailable || sourceFailed(overview)) {
      return unavailablePorthole({
        id: "finance",
        label: "Finance",
        icon: "$",
        action: "Retry finance"
      });
    }

    const metrics = Array.isArray(overview?.metrics) ? overview.metrics : [];
    const alerts = Array.isArray(overview?.alerts) ? overview.alerts : [];
    const reviewAlerts = alerts.filter((alert) =>
      ["high", "critical"].includes(normalizedStatus(alert.severity))
    );
    const state = reviewAlerts.length ? "attention" : metrics.length ? "active" : "quiet";

    return porthole({
      id: "finance",
      label: "Finance",
      icon: "$",
      state,
      summary: reviewAlerts.length
        ? `${reviewAlerts.length} finance alert${reviewAlerts.length === 1 ? "" : "s"} needs review.`
        : "Finance is quiet.",
      freshness: overview?.generatedAt,
      badge: reviewAlerts.length ? `${reviewAlerts.length} to review` : "",
      items: reviewAlerts.length
        ? reviewAlerts.map((alert) => ({
            id: readable(alert.id, "finance-alert"),
            label: readable(alert.title, "Finance alert"),
            meta: humanizeStatus(alert.severity),
            detail: readable(alert.detail, "")
          }))
        : metrics.map((metric, index) => ({
            id: `finance-metric-${index}`,
            label: readable(metric.label, "Metric"),
            meta: readable(metric.value),
            detail: readable(metric.delta, "")
          })),
      action: reviewAlerts.length ? "Review alerts" : "Open finance"
    });
  }

  function tripsPorthole(overview, unavailable) {
    if (unavailable || sourceFailed(overview)) {
      return unavailablePorthole({ id: "trips", label: "Trips", icon: "↗", action: "Retry trips" });
    }

    const items = Array.isArray(overview?.travel) ? overview.travel : [];
    const reviewItems = items.filter((item) => needsReview(item.status));
    const state = reviewItems.length ? "attention" : items.length ? "active" : "quiet";

    return porthole({
      id: "trips",
      label: "Trips",
      icon: "↗",
      state,
      summary: reviewItems.length
        ? `${reviewItems.length} trip item${reviewItems.length === 1 ? "" : "s"} needs review.`
        : "Trips are quiet.",
      freshness: overview?.generatedAt,
      badge: reviewItems.length ? `${reviewItems.length} to review` : "",
      items: items.map((item) => ({
        id: readable(item.id, "trip-item"),
        label: readable(item.title, "Trip item"),
        meta: readable(item.detail, humanizeStatus(item.status)),
        detail: humanizeStatus(item.status)
      })),
      action: reviewItems.length ? "Review trips" : "Open trips"
    });
  }

  function ratesPorthole(viewport, unavailable) {
    if (unavailable || sourceFailed(viewport)) {
      return unavailablePorthole({ id: "rates", label: "Rates", icon: "↓", action: "Retry rates" });
    }

    const watches = Array.isArray(viewport?.items) ? viewport.items : [];
    const lowerRate = watches.find((watch) => rateSavings(watch) > 0);
    const state = lowerRate ? "attention" : watches.length ? "active" : "quiet";
    const savings = lowerRate ? rateSavings(lowerRate) : null;

    return porthole({
      id: "rates",
      label: "Rates",
      icon: "↓",
      state,
      summary: lowerRate
        ? `${readable(lowerRate.property, "A hotel watch")} is below your target rate.`
        : readable(viewport?.source?.summary, "Rates are quiet."),
      freshness: viewport?.source?.updatedAt || viewport?.generatedAt,
      badge: lowerRate ? "Needs review" : watches.length ? `${watches.length} watches` : "",
      highlight: lowerRate
        ? {
            value: `−${formatMoney(savings, lowerRate.currency)}`,
            label: "below your target rate"
          }
        : null,
      items: watches.map((watch) => {
        const saving = rateSavings(watch);
        return {
          id: readable(watch.id, "hotel-watch"),
          label: readable(watch.property, "Hotel watch"),
          meta:
            saving && saving > 0
              ? `−${formatMoney(saving, watch.currency)}`
              : humanizeStatus(watch.status),
          detail: [watch.location, dateRange(watch.checkIn, watch.checkOut)]
            .filter(Boolean)
            .join(" · ")
        };
      }),
      action: lowerRate ? "Review lower rate" : "Open rates",
      featured: Boolean(lowerRate)
    });
  }

  function dealsPorthole(viewport, unavailable) {
    if (unavailable || sourceFailed(viewport)) {
      return unavailablePorthole({
        id: "asia-deals",
        label: "Asia Deals",
        icon: "✦",
        action: "Retry Asia Deals"
      });
    }

    const deals = Array.isArray(viewport?.items) ? viewport.items : [];
    return porthole({
      id: "asia-deals",
      label: "Asia Deals",
      icon: "✦",
      state: deals.length ? "active" : "quiet",
      summary: readable(viewport?.source?.summary, "Asia Deals is quiet."),
      freshness: viewport?.source?.updatedAt || viewport?.generatedAt,
      badge: deals.length ? `${deals.length} new fare${deals.length === 1 ? "" : "s"}` : "",
      items: deals.map((deal) => ({
        id: readable(deal.id, "asia-deal"),
        label: readable(deal.route || deal.title, "Asia deal"),
        meta:
          typeof deal.price === "number"
            ? formatMoney(deal.price, deal.currency)
            : humanizeStatus(deal.status),
        detail: readable(deal.title, "")
      })),
      action: "See all fares"
    });
  }

  function codingPorthole(overview, unavailable) {
    if (unavailable || sourceFailed(overview)) {
      return unavailablePorthole({
        id: "coding",
        label: "Coding",
        icon: "<>",
        action: "Retry coding"
      });
    }

    const tasks = Array.isArray(overview?.tasks) ? overview.tasks : [];
    const reviewTasks = tasks.filter((task) => needsReview(task.status));
    const state = reviewTasks.length ? "attention" : tasks.length ? "active" : "quiet";

    return porthole({
      id: "coding",
      label: "Coding",
      icon: "<>",
      state,
      summary: reviewTasks.length
        ? `${reviewTasks.length} coding task${reviewTasks.length === 1 ? "" : "s"} needs review.`
        : "Coding is quiet.",
      freshness: overview?.generatedAt,
      badge: reviewTasks.length ? `${reviewTasks.length} to review` : "",
      items: tasks.map((task) => ({
        id: readable(task.id, "coding-task"),
        label: readable(task.title, "Coding task"),
        meta: humanizeStatus(task.status),
        detail: readable(task.detail, "")
      })),
      action: reviewTasks.length ? "Open queue" : "Open coding"
    });
  }

  function memoryPorthole() {
    return porthole({
      id: "memory",
      label: "Memory",
      icon: "◌",
      state: "quiet",
      summary: "Memory stays intentionally quiet until it needs your attention.",
      freshness: "",
      action: "Open memory"
    });
  }

  function buildPortholes(viewports, failed) {
    const overview = viewports.overview;
    return [
      ratesPorthole(viewports["hotel-rate-finder"], failed["hotel-rate-finder"]),
      codingPorthole(overview, failed.overview),
      financePorthole(overview, failed.overview),
      tripsPorthole(overview, failed.overview),
      dealsPorthole(viewports["asia-travel-deals"], failed["asia-travel-deals"]),
      memoryPorthole()
    ];
  }

  function attentionHeadline(count) {
    if (count === 0) {
      return "All clear";
    }
    if (count === 1) {
      return "One thing needs you";
    }
    return `${count} things need you`;
  }

  function PortholeIcon(props) {
    return create(
      "span",
      { className: "personal-dashboard-hermes-porthole-icon", "aria-hidden": "true" },
      props.icon
    );
  }

  function PortholeRows(props) {
    const items = Array.isArray(props.items) ? props.items : [];
    if (!items.length) {
      return null;
    }

    return create(
      "ul",
      { className: "personal-dashboard-hermes-porthole-list" },
      items.map((item, index) =>
        create(
          "li",
          { className: "personal-dashboard-hermes-porthole-row", key: item.id || index },
          create(
            "span",
            { className: "personal-dashboard-hermes-porthole-row-main" },
            create(
              "span",
              { className: "personal-dashboard-hermes-porthole-row-label" },
              item.label
            ),
            item.detail
              ? create(
                  "span",
                  { className: "personal-dashboard-hermes-porthole-row-detail" },
                  item.detail
                )
              : null
          ),
          item.meta
            ? create(
                "span",
                { className: "personal-dashboard-hermes-porthole-row-meta" },
                item.meta
              )
            : null
        )
      )
    );
  }

  function PortholeCard(props) {
    const porthole = props.porthole;
    const classes = [
      "personal-dashboard-hermes-porthole",
      `personal-dashboard-hermes-porthole--${porthole.state}`,
      porthole.featured ? "personal-dashboard-hermes-porthole--featured" : "",
      porthole.state === "quiet" ? "personal-dashboard-hermes-porthole--quiet" : ""
    ]
      .filter(Boolean)
      .join(" ");
    const action = porthole.state === "degraded" ? "Retry" : porthole.action;

    return create(
      "button",
      {
        className: classes,
        type: "button",
        onClick: () =>
          porthole.state === "degraded" ? props.onRefresh() : props.onOpen(porthole.id),
        "aria-label": `${porthole.label}. ${porthole.summary}. ${action}.`
      },
      create(
        "span",
        { className: "personal-dashboard-hermes-porthole-heading" },
        create(
          "span",
          { className: "personal-dashboard-hermes-porthole-heading-start" },
          create(PortholeIcon, { icon: porthole.icon }),
          create("span", { className: "personal-dashboard-hermes-porthole-title" }, porthole.label)
        ),
        porthole.badge
          ? create(
              "span",
              { className: "personal-dashboard-hermes-porthole-badge" },
              porthole.badge
            )
          : null
      ),
      porthole.highlight
        ? create(
            "span",
            { className: "personal-dashboard-hermes-porthole-highlight" },
            create("strong", null, porthole.highlight.value),
            create("span", null, porthole.highlight.label)
          )
        : null,
      porthole.state === "degraded"
        ? create(
            "span",
            { className: "personal-dashboard-hermes-porthole-message" },
            porthole.summary
          )
        : null,
      create(PortholeRows, { items: porthole.items }),
      create(
        "span",
        { className: "personal-dashboard-hermes-porthole-action" },
        action,
        create("span", { "aria-hidden": "true" }, "→")
      )
    );
  }

  function LoadingPortholes() {
    return create(
      "div",
      { className: "personal-dashboard-hermes-porthole-grid", "aria-label": "Loading MooHQ" },
      [0, 1, 2, 3, 4].map((index) =>
        create("div", {
          className: `personal-dashboard-hermes-porthole-skeleton ${index === 0 ? "is-featured" : ""}`,
          key: `loading-${index}`
        })
      )
    );
  }

  function DetailPage(props) {
    const { porthole, onBack, onRefresh, loading } = props;
    const isDegraded = porthole.state === "degraded";
    const hasItems = porthole.items.length > 0;

    return create(
      "main",
      { className: "personal-dashboard-hermes-page personal-dashboard-hermes-detail" },
      create(
        "button",
        {
          className: "personal-dashboard-hermes-back",
          type: "button",
          onClick: onBack
        },
        create("span", { "aria-hidden": "true" }, "←"),
        "Back to MooHQ"
      ),
      create(
        "header",
        { className: "personal-dashboard-hermes-detail-header" },
        create(PortholeIcon, { icon: porthole.icon }),
        create(
          "div",
          null,
          create("h1", { className: "personal-dashboard-hermes-title" }, porthole.label),
          create("p", { className: "personal-dashboard-hermes-detail-summary" }, porthole.summary),
          porthole.freshness
            ? create(
                "p",
                { className: "personal-dashboard-hermes-updated" },
                formatFreshness(porthole.freshness)
              )
            : null
        )
      ),
      isDegraded
        ? create(
            "section",
            { className: "personal-dashboard-hermes-detail-status", role: "alert" },
            create("p", null, "This porthole could not refresh. It is safer to treat it as stale."),
            create(
              "button",
              {
                className: "personal-dashboard-hermes-refresh",
                disabled: loading,
                type: "button",
                onClick: onRefresh
              },
              loading ? "Refreshing…" : "Retry"
            )
          )
        : hasItems
          ? create(
              "section",
              { className: "personal-dashboard-hermes-detail-card" },
              create(PortholeRows, { items: porthole.items })
            )
          : create(
              "section",
              { className: "personal-dashboard-hermes-detail-card" },
              create(
                "p",
                { className: "personal-dashboard-hermes-empty" },
                "Nothing needs your attention here right now. This window will become active when the connected app has useful, read-only context to show."
              )
            )
    );
  }

  function MooHQPage() {
    const [viewports, setViewports] = useState({});
    const [failed, setFailed] = useState({});
    const [loading, setLoading] = useState(true);
    const [screen, setScreen] = useState("home");

    const load = useCallback(async () => {
      setLoading(true);
      const responses = await Promise.all(
        VIEWPORTS.map(async (viewport) => {
          try {
            const response = await SDK.fetchJSON(viewport.endpoint);
            if (!isViewport(response, viewport.id)) {
              throw new Error("invalid_viewport_contract");
            }
            return { id: viewport.id, response };
          } catch {
            return { id: viewport.id, failed: true };
          }
        })
      );

      const nextViewports = {};
      const nextFailed = {};
      for (const result of responses) {
        if (result.failed) {
          nextFailed[result.id] = true;
        } else {
          nextViewports[result.id] = result.response;
        }
      }
      setViewports(nextViewports);
      setFailed(nextFailed);
      setLoading(false);
    }, []);

    useEffect(() => {
      void load();
    }, [load]);

    const hasResponse = Object.keys(viewports).length > 0 || Object.keys(failed).length > 0;
    const portholes = buildPortholes(viewports, failed);
    const attentionCount = portholes.filter((porthole) => porthole.state === "attention").length;
    const newest = latestTimestamp(portholes);

    if (screen !== "home") {
      const selected = portholes.find((porthole) => porthole.id === screen) || portholes[0];
      return create(DetailPage, {
        loading,
        onBack: () => setScreen("home"),
        onRefresh: load,
        porthole: selected
      });
    }

    return create(
      "main",
      {
        className: "personal-dashboard-hermes-page",
        "aria-busy": loading ? "true" : undefined
      },
      create(
        "header",
        { className: "personal-dashboard-hermes-header" },
        create(
          "div",
          null,
          create("p", { className: "personal-dashboard-hermes-eyebrow" }, "MooHQ"),
          create(
            "h1",
            { className: "personal-dashboard-hermes-title" },
            attentionHeadline(attentionCount)
          ),
          create(
            "p",
            { className: "personal-dashboard-hermes-intro" },
            "Each app keeps its own workflow. This is the shortest useful way in."
          )
        ),
        create(
          "div",
          { className: "personal-dashboard-hermes-header-actions" },
          newest
            ? create(
                "span",
                { className: "personal-dashboard-hermes-updated" },
                formatFreshness(newest)
              )
            : null,
          create(
            "button",
            {
              className: "personal-dashboard-hermes-refresh",
              disabled: loading,
              type: "button",
              onClick: load
            },
            loading ? "Refreshing…" : "Refresh"
          )
        )
      ),
      hasResponse
        ? create(
            "section",
            {
              className: "personal-dashboard-hermes-porthole-grid",
              "aria-label": "MooHQ portholes"
            },
            portholes.map((porthole) =>
              create(PortholeCard, {
                key: porthole.id,
                onOpen: setScreen,
                onRefresh: load,
                porthole
              })
            )
          )
        : create(LoadingPortholes)
    );
  }

  registry.register(PLUGIN_NAME, MooHQPage);
})();
