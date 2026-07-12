import { createHash } from "node:crypto";

import { appItem } from "../contracts/index.mjs";

export const PERSONAL_MEMORY_APP_ID = "personal-memory";
export const PERSONAL_MEMORY_KINDS = ["fact", "preference", "decision", "session-summary"];
export const PERSONAL_MEMORY_SENSITIVITIES = ["personal", "private", "restricted"];
export const PERSONAL_MEMORY_STATUSES = ["pending", "active", "rejected"];

function text(value) {
  return String(value ?? "").trim();
}

function slug(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function list(value) {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : text(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function memoryPayload(item) {
  return item?.payload ?? item ?? {};
}

export function personalMemoryConfig(env = process.env) {
  return {
    recallLimit: Math.round(boundedNumber(env.PERSONAL_MEMORY_RECALL_LIMIT, 8, 1, 20)),
    curatedObsidianPaths: list(env.PERSONAL_MEMORY_OBSIDIAN_PATHS),
    gbrain: {
      source: text(env.GBRAIN_PERSONAL_MEMORY_SOURCE) || undefined,
      configured: Boolean(text(env.GBRAIN_PERSONAL_MEMORY_SOURCE)),
      writeMode: "proposal-only"
    }
  };
}

export function planPersonalMemoryProposal(input = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const title = text(input.title);
  const content = text(input.content ?? input.value ?? input.detail);
  const kind = text(input.kind || "fact").toLowerCase();
  const sensitivity = text(input.sensitivity || "private").toLowerCase();
  const errors = [];
  if (!title) {
    errors.push("missing_memory_title");
  }
  if (!content) {
    errors.push("missing_memory_content");
  }
  if (!PERSONAL_MEMORY_KINDS.includes(kind)) {
    errors.push("unsupported_memory_kind");
  }
  if (!PERSONAL_MEMORY_SENSITIVITIES.includes(sensitivity)) {
    errors.push("unsupported_memory_sensitivity");
  }
  if (errors.length) {
    return { ok: false, statusCode: 400, reason: errors[0], errors };
  }

  const source = input.provenance ?? input.source ?? {};
  const id =
    text(input.memoryId ?? input.memory_id ?? input.id) ||
    `memory_${slug(title) || "proposal"}_${createHash("sha256")
      .update(`${title}\n${content}\n${now}`)
      .digest("hex")
      .slice(0, 12)}`;
  const confidence = boundedNumber(input.confidence, 0.5, 0, 1);
  const memory = {
    id,
    kind,
    title,
    content,
    scope: "personal",
    sensitivity,
    status: "pending",
    confidence,
    tags: list(input.tags),
    expiresAt: text(input.expiresAt ?? input.expires_at) || undefined,
    provenance: {
      sourceType: text(source.sourceType ?? source.type ?? input.sourceType ?? "hermes"),
      sourceId: text(source.sourceId ?? source.id ?? input.sourceId) || undefined,
      sourceUri: text(source.sourceUri ?? source.uri ?? input.sourceUri) || undefined,
      capturedAt: text(source.capturedAt ?? input.capturedAt) || now
    },
    proposedBy: text(input.proposedBy ?? input.proposed_by ?? "hermes"),
    proposedAt: now
  };
  const item = appItem({
    id,
    app: PERSONAL_MEMORY_APP_ID,
    type: "memory",
    externalId: id,
    ts: now,
    status: "pending",
    title,
    detail: content,
    payload: memory
  });
  return { ok: true, statusCode: 202, memory, item };
}

export function applyPersonalMemoryDecision(existing, input = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const memory = memoryPayload(existing);
  const action = text(input.action ?? input.decision ?? "approve").toLowerCase();
  if (!memory.id || !PERSONAL_MEMORY_STATUSES.includes(memory.status)) {
    return { ok: false, statusCode: 404, reason: "personal_memory_not_found" };
  }
  if (memory.status !== "pending") {
    return { ok: false, statusCode: 409, reason: "personal_memory_not_pending" };
  }
  if (!["approve", "reject"].includes(action)) {
    return { ok: false, statusCode: 400, reason: "unsupported_memory_decision" };
  }
  const reviewedBy = text(input.approvedBy ?? input.approved_by ?? input.reviewedBy);
  const approvalId = text(input.approvalId ?? input.approval_id);
  if (!reviewedBy || !approvalId) {
    return { ok: false, statusCode: 409, reason: "memory_decision_approval_required" };
  }
  const status = action === "approve" ? "active" : "rejected";
  const nextMemory = {
    ...memory,
    status,
    review: {
      action,
      reviewedBy,
      approvalId,
      reason: text(input.reason) || undefined,
      reviewedAt: now
    }
  };
  const item = appItem({
    ...existing,
    id: existing.id ?? memory.id,
    app: PERSONAL_MEMORY_APP_ID,
    type: "memory",
    externalId: existing.externalId ?? memory.id,
    ts: now,
    status,
    title: nextMemory.title,
    detail: nextMemory.content,
    payload: nextMemory
  });
  return { ok: true, statusCode: 202, memory: nextMemory, item };
}

function recallTerms(query) {
  return [
    ...new Set(
      text(query)
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9'-]*/g) ?? []
    )
  ];
}

function isExpired(memory, now) {
  const expiresAt = Date.parse(memory.expiresAt ?? "");
  return Number.isFinite(expiresAt) && expiresAt <= Date.parse(now);
}

export function recallPersonalMemories(items = [], query, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const terms = recallTerms(query);
  const limit = Math.round(boundedNumber(options.limit, 8, 1, 20));
  const memories = items
    .map(memoryPayload)
    .filter(
      (memory) =>
        memory.status === "active" && memory.scope === "personal" && !isExpired(memory, now)
    )
    .map((memory) => {
      const haystack = [memory.title, memory.content, ...(memory.tags ?? [])]
        .join(" ")
        .toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { memory, score };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        String(right.memory.proposedAt).localeCompare(String(left.memory.proposedAt))
    )
    .slice(0, limit)
    .map(({ memory, score }) => ({
      id: memory.id,
      kind: memory.kind,
      title: memory.title,
      content: memory.content,
      confidence: memory.confidence,
      sensitivity: memory.sensitivity,
      provenance: memory.provenance,
      score
    }));
  return { query: text(query), retrievedAt: now, memories };
}
