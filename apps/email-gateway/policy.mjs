import { createHash, randomUUID } from "node:crypto";

const SEARCH_PURPOSES = new Set(["interactive-search", "scheduled-scan", "finance-ingest"]);
const MAX_KEYWORDS = 6;
const MAX_KEYWORD_LENGTH = 80;
const MAX_SENDERS = 8;
const MAX_LABELS = 6;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function hasAsciiControl(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function stripTextControls(value) {
  return Array.from(String(value ?? ""))
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 || character === "\n" || character === "\r" || character === "\t";
    })
    .join("");
}

function replaceHeaderControls(value) {
  return Array.from(String(value ?? ""))
    .map((character) => (hasAsciiControl(character) ? " " : character))
    .join("");
}

function validationError(message) {
  const error = new Error(message);
  error.code = "invalid_email_search";
  return error;
}

function stringList(value, field, maximum, itemValidator) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw validationError(`${field} must contain no more than ${maximum} values.`);
  }
  return value.map((item) => {
    const text = nonEmptyString(item);
    if (!text || !itemValidator(text)) {
      throw validationError(`${field} contains an invalid value.`);
    }
    return text;
  });
}

function literalKeyword(value) {
  return (
    value.length <= MAX_KEYWORD_LENGTH &&
    !hasAsciiControl(value) &&
    !/["{}():]/.test(value) &&
    !/\b(?:in|from|to|label|after|before):/i.test(value)
  );
}

function emailOrDomain(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._+%-]*(?:@[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}

function labelName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_/-]{0,99}$/.test(value);
}

function epochSeconds(value, field) {
  if (value === undefined) return undefined;
  const text = nonEmptyString(value);
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw validationError(`${field} must be an ISO-8601 date or timestamp.`);
  }
  return Math.floor(Date.parse(text) / 1000);
}

/**
 * Compile a deliberately small structured search language. No caller can pass
 * raw Gmail search syntax, preventing an agent from bypassing label/date/result
 * policy with arbitrary operators.
 */
export function compileEmailSearch(payload = {}, { maxResults = 25 } = {}) {
  const request = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const purpose = nonEmptyString(request.purpose);
  if (!SEARCH_PURPOSES.has(purpose)) {
    throw validationError("purpose must be interactive-search, scheduled-scan, or finance-ingest.");
  }
  const filters =
    request.filters && typeof request.filters === "object" && !Array.isArray(request.filters)
      ? request.filters
      : {};
  if (Object.hasOwn(request, "query") || Object.hasOwn(filters, "query")) {
    throw validationError("Raw Gmail query strings are not accepted.");
  }
  const keywords = stringList(filters.keywords, "keywords", MAX_KEYWORDS, literalKeyword);
  const from = stringList(filters.from, "from", MAX_SENDERS, emailOrDomain);
  const labels = stringList(filters.labels, "labels", MAX_LABELS, labelName);
  const after = epochSeconds(filters.after, "after");
  const before = epochSeconds(filters.before, "before");
  if (after && before && after >= before) {
    throw validationError("after must be earlier than before.");
  }
  if (purpose === "scheduled-scan" && !after) {
    throw validationError("scheduled-scan requires an after timestamp.");
  }

  const requestedLimit = request.limit === undefined ? 10 : Number(request.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > maxResults) {
    throw validationError(`limit must be between 1 and ${maxResults}.`);
  }
  const terms = [
    ...keywords.map((keyword) => `"${keyword}"`),
    ...from.map((sender) => `from:${sender}`),
    ...labels.map((label) => `label:${label}`),
    ...(after ? [`after:${after}`] : []),
    ...(before ? [`before:${before}`] : [])
  ];
  return {
    purpose,
    query: terms.join(" "),
    limit: requestedLimit,
    queryFingerprint: createHash("sha256").update(terms.join(" ")).digest("base64url")
  };
}

function decodeBody(data) {
  if (typeof data !== "string" || !data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function htmlToText(value) {
  return value
    .replace(/<\/(?:p|div|li|tr|h[1-6]|br)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"');
}

function isAttachmentPart(part, body) {
  const disposition = Array.isArray(part?.headers)
    ? part.headers.find(
        (header) => String(header?.name ?? "").toLowerCase() === "content-disposition"
      )?.value
    : "";
  return (
    Boolean(body.attachmentId) ||
    Boolean(nonEmptyString(part?.filename)) ||
    /(?:^|;)\s*attachment\b/i.test(String(disposition ?? ""))
  );
}

function collectTextParts(part, textParts, htmlParts) {
  if (!part || typeof part !== "object") return;
  const mimeType = String(part.mimeType ?? "").toLowerCase();
  const body = part.body && typeof part.body === "object" ? part.body : {};
  // A Gmail attachment can be identified by an attachment id, filename, or
  // MIME disposition. Never fetch or return it, even when it is small enough
  // for Gmail to inline its text data. An attachment container can itself be
  // multipart, so do not descend into its children either.
  if (isAttachmentPart(part, body)) return;
  if (typeof body.data === "string") {
    if (mimeType === "text/plain") textParts.push(decodeBody(body.data));
    if (mimeType === "text/html") htmlParts.push(decodeBody(body.data));
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    collectTextParts(child, textParts, htmlParts);
  }
}

function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(
      /\b(?:one[- ]?time|verification|security|login|passcode|OTP)\s*(?:code)?\s*(?:is|:)?\s*\d{4,10}\b/gi,
      "[REDACTED AUTH CODE]"
    )
    .replace(
      /\b\d{4,10}\b(?=\s+(?:is\s+)?(?:your\s+)?(?:one[- ]?time|verification|security|login|passcode|OTP)\s*(?:code)?\b)/gi,
      "[REDACTED AUTH CODE]"
    )
    .replace(/https?:\/\/[^\s]+(?:reset|password|recover)[^\s]*/gi, "[REDACTED RESET LINK]");
}

export function sanitizedMessageText(message, { maxChars = 12_000 } = {}) {
  const textParts = [];
  const htmlParts = [];
  collectTextParts(message?.payload, textParts, htmlParts);
  const raw = textParts.filter(Boolean).join("\n\n") || htmlParts.map(htmlToText).join("\n\n");
  const normalized = stripTextControls(redactSensitiveText(raw))
    .replace(/\r\n?/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return normalized.slice(0, maxChars);
}

function headerValue(message, name) {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const header = headers.find(
    (candidate) => String(candidate?.name).toLowerCase() === name.toLowerCase()
  );
  return nonEmptyString(header?.value);
}

function safeHeader(value, maxChars) {
  return replaceHeaderControls(nonEmptyString(value)).replace(/\s+/g, " ").slice(0, maxChars);
}

export function messageSummary(message) {
  const receivedAt = Number.isFinite(Number(message?.internalDate))
    ? new Date(Number(message.internalDate)).toISOString()
    : undefined;
  return {
    from: safeHeader(headerValue(message, "From"), 320),
    to: safeHeader(headerValue(message, "To"), 320),
    subject: safeHeader(redactSensitiveText(headerValue(message, "Subject")), 500),
    receivedAt,
    labels: Array.isArray(message?.labelIds) ? message.labelIds.slice(0, 20) : [],
    snippet: safeHeader(redactSensitiveText(message?.snippet), 500)
  };
}

export function createSearchReceipt(messages, { ttlSeconds, now = Date.now() } = {}) {
  const receipt = randomUUID();
  const handles = new Map();
  const results = messages.map((message) => {
    const handle = randomUUID();
    handles.set(handle, String(message.id));
    return { handle, ...messageSummary(message) };
  });
  return {
    receipt,
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    handles,
    reads: 0,
    results
  };
}

export function opaqueMessageId(rawId) {
  return createHash("sha256").update(String(rawId)).digest("base64url");
}

export function parsedSender(value) {
  const match = nonEmptyString(value).match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function senderDomain(sender) {
  const at = sender.lastIndexOf("@");
  const domain = at >= 1 ? sender.slice(at + 1) : "";
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
    domain
  )
    ? domain.toLowerCase()
    : "";
}

function configuredDomains(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return [];
  return value
    .map((domain) => parserString(domain, 253).toLowerCase())
    .filter((domain) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
        domain
      )
    );
}

function domainMatches(value, expected) {
  return value === expected || value.endsWith(`.${expected}`);
}

function authenticationResultsHeader(message) {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  // Gmail prepends its evaluated Authentication-Results header. Deliberately
  // examine only that first header so a sender-supplied duplicate cannot turn
  // a failed authentication result into a finance event.
  const first = headers.find(
    (candidate) => String(candidate?.name).toLowerCase() === "authentication-results"
  );
  return nonEmptyString(first?.value);
}

function dmarcAuthenticatedForDomains(message, domains) {
  const results = authenticationResultsHeader(message);
  if (!/^mx\.google\.com\s*;/i.test(results) || !/\bdmarc=pass\b/i.test(results)) {
    return false;
  }
  const authenticatedFromDomains = [...results.matchAll(/\bheader\.from=([A-Za-z0-9.-]+)/gi)].map(
    (match) => match[1].toLowerCase()
  );
  return authenticatedFromDomains.some((domain) =>
    domains.some((expected) => domainMatches(domain, expected))
  );
}

function parserString(value, maximum = 800) {
  const text = nonEmptyString(value);
  return text && text.length <= maximum ? text : "";
}

function parserPattern(value) {
  const pattern = parserString(value, 300);
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return undefined;
  }
}

function parserSenderMatches(sender, parser) {
  const allowed = Array.isArray(parser.senders) ? parser.senders : [];
  return allowed.some((candidate) => {
    const expected = parserString(candidate, 320).toLowerCase();
    return (
      expected && (sender === expected || (expected.startsWith("@") && sender.endsWith(expected)))
    );
  });
}

function parserTransactionSourceIsTrusted(message, sender, parser) {
  const domains = configuredDomains(parser.authenticatedDomains);
  const fromDomain = senderDomain(sender);
  return (
    domains.length > 0 &&
    fromDomain &&
    domains.some((domain) => domainMatches(fromDomain, domain)) &&
    dmarcAuthenticatedForDomains(message, domains)
  );
}

function matchCapture(pattern, text) {
  const match = pattern?.exec(text);
  return nonEmptyString(match?.[1] ?? match?.[0]);
}

/**
 * Transaction parsing is owner-configured, deterministic, and sender-gated.
 * Unknown messages are not financial events; they remain available for review.
 */
export function parseTransactionCandidate(message, parsers = [], { maxBodyChars = 12_000 } = {}) {
  const summary = messageSummary(message);
  const sender = parsedSender(summary.from);
  const body = sanitizedMessageText(message, { maxChars: maxBodyChars });
  const source = `${summary.subject}\n${body}`;
  for (const parser of parsers) {
    if (
      !parser ||
      typeof parser !== "object" ||
      !parserSenderMatches(sender, parser) ||
      !parserTransactionSourceIsTrusted(message, sender, parser)
    ) {
      continue;
    }
    const amountText = matchCapture(parserPattern(parser.amountPattern), source).replace(/,/g, "");
    const amount = Number(amountText.replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(amount)) continue;
    const merchant = matchCapture(parserPattern(parser.merchantPattern), source);
    const cardLast4 = matchCapture(parserPattern(parser.cardLast4Pattern), source).match(
      /\b(\d{4})\b/
    )?.[1];
    const parserId = parserString(parser.id, 100);
    const currency = parserString(parser.currency, 3).toUpperCase();
    if (!parserId || !/^[A-Za-z0-9._-]+$/.test(parserId) || !/^[A-Z]{3}$/.test(currency)) continue;
    return {
      version: "gmail-transaction-notification.v1",
      type: "transaction-notification",
      externalId: opaqueMessageId(message.id),
      merchant: safeHeader(merchant || "Unknown merchant", 160),
      amount,
      currency,
      cardLast4: cardLast4 ?? undefined,
      occurredAt: summary.receivedAt,
      parserId,
      confidence: 1
    };
  }
  return undefined;
}
