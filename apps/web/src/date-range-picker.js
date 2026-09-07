const DAY_MS = 86_400_000;
const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC"
});
const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC"
});
const accessibleDayFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC"
});

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return toIsoDate(date) === match[0] ? date : null;
}

function toIsoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function localToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function addDays(date, count) {
  return new Date(date.getTime() + count * DAY_MS);
}

function startOfMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date, count) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
}

function addCalendarMonths(date, count) {
  const targetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const lastDay = new Date(
    Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)
  ).getUTCDate();
  targetMonth.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return targetMonth;
}

function sameDate(left, right) {
  return Boolean(left && right && left.getTime() === right.getTime());
}

function rangeLength(start, end) {
  return Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
}

function formattedRange(start, end) {
  if (sameDate(start, end)) return dayFormatter.format(start);
  if (typeof dayFormatter.formatRange === "function") return dayFormatter.formatRange(start, end);
  return `${dayFormatter.format(start)} – ${dayFormatter.format(end)}`;
}

class DateRangePicker {
  constructor(root, options = {}) {
    this.root = root;
    this.options = options;
    this.trigger = root.querySelector(".date-range-trigger");
    this.value = root.querySelector("[data-range-value]");
    this.meta = root.querySelector("[data-range-meta]");
    this.startInput = root.querySelector(`[name="${options.startName}"]`);
    this.endInput = root.querySelector(`[name="${options.endName}"]`);
    this.min = parseIsoDate(options.min) ?? localToday();
    this.start = null;
    this.end = null;
    this.draftStart = null;
    this.draftEnd = null;
    this.month = startOfMonth(this.min);
    this.createPopover();
    this.bindEvents();
    this.setRange(options.start, options.end);
  }

  createPopover() {
    this.popover = document.createElement("div");
    this.popover.className = "date-range-popover";
    this.popover.id = `${this.root.dataset.dateRangePicker}-range-dialog`;
    this.popover.hidden = true;
    this.popover.setAttribute("role", "dialog");
    this.popover.setAttribute("aria-modal", "false");
    this.popover.setAttribute("aria-label", `${this.options.label} calendar`);
    this.popover.innerHTML = `
      <div class="calendar-heading">
        <button class="calendar-nav" type="button" data-calendar-previous aria-label="Previous month">‹</button>
        <strong data-calendar-month></strong>
        <button class="calendar-nav" type="button" data-calendar-next aria-label="Next month">›</button>
      </div>
      <div class="calendar-weekdays" aria-hidden="true">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="calendar-days" data-calendar-days></div>
      <p class="calendar-status" data-calendar-status aria-live="polite"></p>
      <div class="calendar-footer">
        <button class="text-button calendar-clear" type="button" data-calendar-clear ${this.options.optional ? "" : "hidden"}>Clear</button>
        <button class="primary-button calendar-apply" type="button" data-calendar-apply>Apply dates</button>
      </div>`;
    this.trigger.setAttribute("aria-controls", this.popover.id);
    this.root.append(this.popover);
    this.monthLabel = this.popover.querySelector("[data-calendar-month]");
    this.days = this.popover.querySelector("[data-calendar-days]");
    this.status = this.popover.querySelector("[data-calendar-status]");
    this.applyButton = this.popover.querySelector("[data-calendar-apply]");
    this.previousButton = this.popover.querySelector("[data-calendar-previous]");
  }

  bindEvents() {
    this.trigger.addEventListener("click", () => {
      if (this.popover.hidden) this.open();
      else this.close();
    });
    this.popover.addEventListener("click", (event) => {
      const dateButton = event.target.closest("[data-date]");
      if (dateButton) {
        this.selectDate(dateButton.dataset.date);
        return;
      }
      if (event.target.closest("[data-calendar-previous]")) {
        this.month = addMonths(this.month, -1);
        this.renderCalendar();
      } else if (event.target.closest("[data-calendar-next]")) {
        this.month = addMonths(this.month, 1);
        this.renderCalendar();
      } else if (event.target.closest("[data-calendar-apply]")) {
        this.apply();
      } else if (event.target.closest("[data-calendar-clear]")) {
        this.clear();
      }
    });
    this.days.addEventListener("keydown", (event) => this.handleCalendarKey(event));
    document.addEventListener("pointerdown", (event) => {
      if (!this.root.contains(event.target)) this.close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.popover.hidden) {
        this.close();
        this.trigger.focus();
      }
    });
  }

  open() {
    this.draftStart = this.start;
    this.draftEnd = this.end;
    this.month = startOfMonth(this.start ?? this.min);
    this.popover.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.root.classList.add("open");
    this.renderCalendar();
    queueMicrotask(() => {
      const preferred = this.days.querySelector(
        `[data-date="${toIsoDate(this.draftStart ?? this.min)}"]:not(:disabled)`
      );
      (preferred ?? this.days.querySelector("[data-date]:not(:disabled)"))?.focus();
    });
  }

  close() {
    if (this.popover.hidden) return;
    this.popover.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    this.root.classList.remove("open");
    this.draftStart = this.start;
    this.draftEnd = this.end;
  }

  selectDate(value) {
    const selected = parseIsoDate(value);
    if (!selected || selected < this.min) return;
    if (!this.draftStart || this.draftEnd) {
      this.draftStart = selected;
      this.draftEnd = null;
    } else if (selected < this.draftStart) {
      this.draftStart = selected;
    } else {
      this.draftEnd = selected;
    }
    this.renderCalendar();
    queueMicrotask(() => this.days.querySelector(`[data-date="${value}"]`)?.focus());
  }

  apply() {
    if (!this.draftStart || !this.draftEnd) return;
    this.setRange(toIsoDate(this.draftStart), toIsoDate(this.draftEnd), { emit: true });
    this.close();
    this.trigger.focus();
  }

  clear() {
    if (!this.options.optional) return;
    this.setRange("", "", { emit: true });
    this.close();
    this.trigger.focus();
  }

  setRange(startValue, endValue, { emit = false } = {}) {
    const start = parseIsoDate(startValue);
    const end = parseIsoDate(endValue);
    if (start && end && start >= this.min && end >= start) {
      this.start = start;
      this.end = end;
    } else {
      this.start = null;
      this.end = null;
    }
    this.startInput.value = this.start ? toIsoDate(this.start) : "";
    this.endInput.value = this.end ? toIsoDate(this.end) : "";
    this.renderValue();
    if (emit) {
      this.startInput.dispatchEvent(new Event("change", { bubbles: true }));
      this.options.onChange?.(this.getRange());
    }
  }

  setMin(value) {
    const min = parseIsoDate(value);
    if (!min) return;
    this.min = min;
    if (this.start && (this.start < min || this.end < min)) {
      this.setRange("", "", { emit: true });
    }
    if (!this.popover.hidden) {
      if (this.month < startOfMonth(min)) this.month = startOfMonth(min);
      this.renderCalendar();
    }
  }

  getRange() {
    return {
      start: this.start ? toIsoDate(this.start) : "",
      end: this.end ? toIsoDate(this.end) : ""
    };
  }

  renderValue() {
    if (!this.start || !this.end) {
      this.value.textContent = this.options.emptyLabel;
      this.meta.textContent = this.options.emptyMeta;
      this.root.classList.remove("has-value");
      return;
    }
    const count = rangeLength(this.start, this.end);
    this.value.textContent = formattedRange(this.start, this.end);
    this.meta.textContent = `${count}-day search window`;
    this.root.classList.add("has-value");
  }

  renderCalendar() {
    this.monthLabel.textContent = monthFormatter.format(this.month);
    const minimumMonth = startOfMonth(this.min);
    this.previousButton.disabled = addMonths(this.month, -1) < minimumMonth;
    this.days.replaceChildren();
    const leading = this.month.getUTCDay();
    for (let index = 0; index < leading; index += 1) {
      const spacer = document.createElement("span");
      spacer.className = "calendar-spacer";
      this.days.append(spacer);
    }
    const lastDay = new Date(
      Date.UTC(this.month.getUTCFullYear(), this.month.getUTCMonth() + 1, 0)
    ).getUTCDate();
    const today = localToday();
    for (let day = 1; day <= lastDay; day += 1) {
      const date = new Date(Date.UTC(this.month.getUTCFullYear(), this.month.getUTCMonth(), day));
      const iso = toIsoDate(date);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "calendar-day";
      button.dataset.date = iso;
      button.textContent = String(day);
      button.setAttribute("aria-label", accessibleDayFormatter.format(date));
      button.disabled = date < this.min;
      const selected = Boolean(
        this.draftStart &&
          (sameDate(date, this.draftStart) ||
            sameDate(date, this.draftEnd) ||
            (this.draftEnd && date > this.draftStart && date < this.draftEnd))
      );
      button.setAttribute("aria-pressed", String(selected));
      if (sameDate(date, today)) {
        button.classList.add("today");
        button.setAttribute("aria-current", "date");
      }
      if (sameDate(date, this.draftStart)) button.classList.add("range-start");
      if (sameDate(date, this.draftEnd)) button.classList.add("range-end");
      if (this.draftStart && this.draftEnd && date > this.draftStart && date < this.draftEnd) {
        button.classList.add("in-range");
      }
      this.days.append(button);
    }
    this.applyButton.disabled = !this.draftStart || !this.draftEnd;
    if (this.draftStart && this.draftEnd) {
      const count = rangeLength(this.draftStart, this.draftEnd);
      this.status.textContent = `${formattedRange(this.draftStart, this.draftEnd)} · ${count}-day search window`;
    } else if (this.draftStart) {
      this.status.textContent = `Start: ${dayFormatter.format(this.draftStart)}. Choose the last date.`;
    } else {
      this.status.textContent = `Choose a first date on or after ${dayFormatter.format(this.min)}.`;
    }
  }

  handleCalendarKey(event) {
    const button = event.target.closest("[data-date]");
    if (!button) return;
    const current = parseIsoDate(button.dataset.date);
    let target = null;
    if (event.key === "ArrowLeft") target = addDays(current, -1);
    else if (event.key === "ArrowRight") target = addDays(current, 1);
    else if (event.key === "ArrowUp") target = addDays(current, -7);
    else if (event.key === "ArrowDown") target = addDays(current, 7);
    else if (event.key === "Home") target = addDays(current, -current.getUTCDay());
    else if (event.key === "End") target = addDays(current, 6 - current.getUTCDay());
    else if (event.key === "PageUp") target = addCalendarMonths(current, -1);
    else if (event.key === "PageDown") target = addCalendarMonths(current, 1);
    if (!target) return;
    event.preventDefault();
    if (target < this.min) target = this.min;
    this.month = startOfMonth(target);
    this.renderCalendar();
    queueMicrotask(() => this.days.querySelector(`[data-date="${toIsoDate(target)}"]`)?.focus());
  }
}

export function createDateRangePicker(root, options) {
  return new DateRangePicker(root, options);
}

export function futureDateValue(offsetDays, now = new Date()) {
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  return toIsoDate(addDays(today, offsetDays));
}
