(() => {
  // biome-ignore lint/suspicious/noRedundantUseStrict: WebUI injects this as a classic script.
  "use strict";

  const EXTENSION_ID = "personal-dashboard";
  const PANEL_ID = "personal-dashboard-webui-panel";
  const BUTTON_ID = "personal-dashboard-webui-toggle";
  let runtime = window.__personalDashboardWebuiExtension;
  if (!runtime) {
    runtime = {};
    window.__personalDashboardWebuiExtension = runtime;
  }

  if (runtime.initialized) {
    return;
  }
  runtime.initialized = true;

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

  function text(value, fallback = "—") {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    return fallback;
  }

  function createElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (value !== undefined) {
      element.textContent = value;
    }
    return element;
  }

  function itemTitle(item, fallback) {
    if (!isRecord(item)) {
      return fallback;
    }
    return text(item.title || item.label || item.name || item.id, fallback);
  }

  function itemDetail(item) {
    if (!isRecord(item)) {
      return "";
    }
    return text(
      item.detail ||
        item.summary ||
        item.description ||
        item.status ||
        item.source ||
        item.severity,
      ""
    );
  }

  function formattedGeneratedAt(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? text(value) : date.toLocaleString();
  }

  function mount() {
    const main = document.querySelector("main");
    if (!main || document.getElementById(PANEL_ID)) {
      return Boolean(main);
    }

    const button = createElement("button", "personal-dashboard-webui-toggle", "Dashboard");
    button.id = BUTTON_ID;
    button.type = "button";
    button.setAttribute("aria-controls", PANEL_ID);
    button.setAttribute("aria-expanded", "false");

    const panel = createElement("section", "main-view personal-dashboard-webui-panel");
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.setAttribute("aria-labelledby", `${PANEL_ID}-title`);

    const header = createElement("header", "personal-dashboard-webui-header");
    const title = createElement("h1", "personal-dashboard-webui-title", "Personal Dashboard");
    title.id = `${PANEL_ID}-title`;
    const controls = createElement("div", "personal-dashboard-webui-controls");
    const refresh = createElement("button", "personal-dashboard-webui-button", "Refresh");
    refresh.type = "button";
    const close = createElement("button", "personal-dashboard-webui-button", "Back to Hermes");
    close.type = "button";
    controls.append(refresh, close);
    header.append(title, controls);

    const status = createElement(
      "p",
      "personal-dashboard-webui-status",
      "Open the panel to load a summary."
    );
    status.setAttribute("aria-live", "polite");
    const content = createElement("div", "personal-dashboard-webui-content");
    panel.append(header, status, content);
    document.body.appendChild(button);
    main.appendChild(panel);

    const originalHidden = new Map();

    function hidePanel() {
      if (panel.hidden) {
        return;
      }
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      originalHidden.forEach((wasHidden, view) => {
        view.hidden = wasHidden;
      });
      originalHidden.clear();
      button.focus({ preventScroll: true });
    }

    function showPanel() {
      main.querySelectorAll(":scope > .main-view").forEach((view) => {
        if (view === panel) {
          return;
        }
        if (!originalHidden.has(view)) {
          originalHidden.set(view, view.hidden);
        }
        view.hidden = true;
      });
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
      panel.focus({ preventScroll: true });
      void loadSummary();
    }

    function renderEmpty(message) {
      const empty = createElement("p", "personal-dashboard-webui-empty", message);
      content.replaceChildren(empty);
    }

    function renderItems(titleText, items, emptyText) {
      const section = createElement("section", "personal-dashboard-webui-section");
      section.append(createElement("h2", "personal-dashboard-webui-section-title", titleText));
      const visibleItems = Array.isArray(items) ? items.slice(0, 6) : [];
      if (!visibleItems.length) {
        section.append(createElement("p", "personal-dashboard-webui-empty", emptyText));
        return section;
      }

      const list = createElement("ul", "personal-dashboard-webui-list");
      visibleItems.forEach((item) => {
        const listItem = createElement("li", "personal-dashboard-webui-list-item");
        listItem.append(
          createElement(
            "strong",
            "personal-dashboard-webui-item-title",
            itemTitle(item, "Untitled item")
          )
        );
        const detail = itemDetail(item);
        if (detail) {
          listItem.append(createElement("span", "personal-dashboard-webui-item-detail", detail));
        }
        list.append(listItem);
      });
      section.append(list);
      return section;
    }

    function renderSummary(summary) {
      const fragment = document.createDocumentFragment();
      const health = createElement("section", "personal-dashboard-webui-health");
      health.dataset.level = text(summary.health.level, "unknown");
      health.append(
        createElement(
          "strong",
          "personal-dashboard-webui-health-level",
          text(summary.health.level, "Unknown")
        ),
        createElement(
          "span",
          "personal-dashboard-webui-health-summary",
          text(summary.health.summary)
        )
      );
      fragment.append(health);

      const metrics = createElement("section", "personal-dashboard-webui-metrics");
      metrics.setAttribute("aria-label", "Dashboard metrics");
      summary.metrics.slice(0, 6).forEach((metric) => {
        const card = createElement("article", "personal-dashboard-webui-metric");
        card.append(
          createElement(
            "span",
            "personal-dashboard-webui-metric-label",
            itemTitle(metric, "Metric")
          ),
          createElement(
            "strong",
            "personal-dashboard-webui-metric-value",
            text(isRecord(metric) ? metric.value : undefined)
          )
        );
        if (isRecord(metric) && metric.delta) {
          card.append(
            createElement("span", "personal-dashboard-webui-metric-delta", text(metric.delta))
          );
        }
        metrics.append(card);
      });
      if (summary.metrics.length) {
        fragment.append(metrics);
      }

      const grid = createElement("div", "personal-dashboard-webui-grid");
      grid.append(
        renderItems("Alerts", summary.alerts, "No active alerts."),
        renderItems("Travel", summary.travel, "No travel items need attention."),
        renderItems("Tasks", summary.tasks, "No active tasks.")
      );
      fragment.append(grid);
      content.replaceChildren(fragment);
      status.textContent = `Updated ${formattedGeneratedAt(summary.generatedAt)}`;
    }

    function renderFailure(message) {
      renderEmpty(message);
      status.textContent = "Summary unavailable.";
    }

    async function loadSummary() {
      refresh.disabled = true;
      status.textContent = "Loading Personal Dashboard…";
      try {
        const response = await fetch(
          "/api/extensions/personal-dashboard/sidecar/api/host-dashboard/summary",
          {
            method: "GET",
            credentials: "same-origin",
            headers: { Accept: "application/json" },
            cache: "no-store"
          }
        );
        if (!response.ok) {
          renderFailure(
            "The Personal Dashboard summary is unavailable. In Settings → Extensions, approve the Personal Dashboard sidecar proxy, then retry."
          );
          return;
        }
        const summary = await response.json();
        if (!isSummary(summary)) {
          renderFailure("The Personal Dashboard returned an unsupported summary contract.");
          return;
        }
        renderSummary(summary);
      } catch {
        renderFailure(
          "The Personal Dashboard summary is unavailable. Confirm that the local dashboard API is running and proxy consent is enabled."
        );
      } finally {
        refresh.disabled = false;
      }
    }

    button.addEventListener("click", () => {
      if (panel.hidden) {
        showPanel();
      } else {
        hidePanel();
      }
    });
    close.addEventListener("click", hidePanel);
    refresh.addEventListener("click", () => {
      void loadSummary();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hidePanel();
      }
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest(`#${PANEL_ID}, #${BUTTON_ID}`)) {
        return;
      }
      if (target.closest("nav a, [role='tab'], .sidebar a")) {
        hidePanel();
      }
    });

    runtime.hidePanel = hidePanel;
    runtime.extensionId = EXTENSION_ID;
    return true;
  }

  if (mount()) {
    return;
  }

  const observer = new MutationObserver(() => {
    if (mount()) {
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
