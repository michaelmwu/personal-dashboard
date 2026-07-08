const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function asString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function normalizedText(value) {
  return asString(value).trim().toLowerCase();
}

function numericValue(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function dateValue(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function transactionDate(transaction) {
  return transaction.date ?? transaction.authorizedDate ?? "";
}

function accountLabel(transaction, accountById = new Map()) {
  const account = accountById.get(transaction.accountId);
  return transaction.card ?? account?.name ?? transaction.accountId ?? "Unknown account";
}

function matchesList(value, accepted) {
  if (!accepted?.length) {
    return true;
  }
  const normalized = normalizedText(value);
  return accepted.some((item) => normalized === normalizedText(item));
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined && item !== null && String(item).trim());
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function transactionQueryFromSearchParams(searchParams) {
  return {
    q: searchParams.get("q") ?? searchParams.get("search") ?? "",
    accountId: parseList(searchParams.get("accountId") ?? searchParams.get("account")),
    card: parseList(searchParams.get("card")),
    category: parseList(searchParams.get("category")),
    status: parseList(searchParams.get("status")),
    paymentChannel: parseList(searchParams.get("paymentChannel")),
    startDate: searchParams.get("startDate") ?? searchParams.get("from") ?? "",
    endDate: searchParams.get("endDate") ?? searchParams.get("to") ?? "",
    minAmount: searchParams.get("minAmount") ?? "",
    maxAmount: searchParams.get("maxAmount") ?? "",
    sort: searchParams.get("sort") ?? "date",
    direction: searchParams.get("direction") ?? "desc",
    limit: searchParams.get("limit"),
    offset: searchParams.get("offset")
  };
}

export function transactionAggregateQueryFromSearchParams(searchParams) {
  return {
    ...transactionQueryFromSearchParams(searchParams),
    groupBy: searchParams.get("groupBy") ?? "category"
  };
}

export function transactionFacets(transactions, accounts = []) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const facets = {
    accounts: new Map(),
    categories: new Map(),
    statuses: new Map()
  };
  for (const transaction of transactions) {
    const accountId = transaction.accountId ?? "";
    const label = accountLabel(transaction, accountById);
    if (accountId) {
      facets.accounts.set(accountId, {
        id: accountId,
        label,
        count: (facets.accounts.get(accountId)?.count ?? 0) + 1
      });
    }
    const category = transaction.category ?? "Unclassified";
    facets.categories.set(category, {
      id: category,
      label: category,
      count: (facets.categories.get(category)?.count ?? 0) + 1
    });
    const status = transaction.status ?? "posted";
    facets.statuses.set(status, {
      id: status,
      label: status,
      count: (facets.statuses.get(status)?.count ?? 0) + 1
    });
  }
  return Object.fromEntries(
    Object.entries(facets).map(([key, values]) => [
      key,
      [...values.values()].sort(
        (left, right) => right.count - left.count || left.label.localeCompare(right.label)
      )
    ])
  );
}

export function filterTransactions(transactions, query = {}, accounts = []) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const search = normalizedText(query.q);
  const accountIds = parseList(query.accountId);
  const cards = parseList(query.card);
  const categories = parseList(query.category);
  const statuses = parseList(query.status);
  const paymentChannels = parseList(query.paymentChannel);
  const startDate = query.startDate ? Date.parse(query.startDate) : undefined;
  const endDate = query.endDate ? Date.parse(query.endDate) : undefined;
  const minAmount = numericValue(query.minAmount);
  const maxAmount = numericValue(query.maxAmount);

  return transactions.filter((transaction) => {
    const date = transactionDate(transaction);
    const time = Date.parse(date);
    const amount = Math.abs(Number(transaction.amount ?? 0));
    const label = accountLabel(transaction, accountById);
    const searchable = [
      transaction.merchant,
      transaction.name,
      transaction.category,
      transaction.categoryDetailed,
      label,
      transaction.paymentChannel
    ]
      .map(normalizedText)
      .join(" ");

    return (
      (!search || searchable.includes(search)) &&
      matchesList(transaction.accountId, accountIds) &&
      matchesList(label, cards) &&
      matchesList(transaction.category, categories) &&
      matchesList(transaction.status, statuses) &&
      matchesList(transaction.paymentChannel, paymentChannels) &&
      (startDate === undefined || (Number.isFinite(time) && time >= startDate)) &&
      (endDate === undefined || (Number.isFinite(time) && time <= endDate)) &&
      (minAmount === undefined || amount >= minAmount) &&
      (maxAmount === undefined || amount <= maxAmount)
    );
  });
}

export function sortTransactions(transactions, query = {}, accounts = []) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const sort = query.sort ?? "date";
  const direction = query.direction === "asc" ? 1 : -1;
  const valueFor = (transaction) => {
    switch (sort) {
      case "merchant":
        return normalizedText(transaction.merchant);
      case "amount":
        return Number(transaction.amount ?? 0);
      case "category":
        return normalizedText(transaction.category);
      case "card":
      case "account":
        return normalizedText(accountLabel(transaction, accountById));
      case "status":
        return normalizedText(transaction.status);
      default:
        return dateValue(transactionDate(transaction));
    }
  };
  return [...transactions].sort((left, right) => {
    const leftValue = valueFor(left);
    const rightValue = valueFor(right);
    if (leftValue < rightValue) {
      return -1 * direction;
    }
    if (leftValue > rightValue) {
      return direction;
    }
    return normalizedText(left.id).localeCompare(normalizedText(right.id));
  });
}

export function queryTransactions(transactions, query = {}, accounts = []) {
  const filtered = filterTransactions(transactions, query, accounts);
  const sorted = sortTransactions(filtered, query, accounts);
  const limit = Math.min(
    Math.max(Number.parseInt(query.limit ?? DEFAULT_LIMIT, 10) || DEFAULT_LIMIT, 1),
    MAX_LIMIT
  );
  const offset = Math.max(Number.parseInt(query.offset ?? 0, 10) || 0, 0);
  return {
    items: sorted.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
    sort: query.sort ?? "date",
    direction: query.direction === "asc" ? "asc" : "desc",
    facets: transactionFacets(transactions, accounts)
  };
}

export function aggregateTransactions(transactions, query = {}, accounts = []) {
  const filtered = filterTransactions(transactions, query, accounts);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const groupBy = query.groupBy ?? "category";
  const groups = new Map();
  const keyFor = (transaction) => {
    switch (groupBy) {
      case "card":
      case "account":
        return accountLabel(transaction, accountById);
      case "month":
        return transactionDate(transaction).slice(0, 7) || "Unknown month";
      case "status":
        return transaction.status ?? "posted";
      default:
        return transaction.category ?? "Unclassified";
    }
  };

  for (const transaction of filtered) {
    const key = keyFor(transaction);
    const existing = groups.get(key) ?? { key, count: 0, spend: 0, credits: 0, net: 0 };
    const amount = Number(transaction.amount ?? 0);
    existing.count += 1;
    existing.net += amount;
    if (amount >= 0) {
      existing.spend += amount;
    } else {
      existing.credits += Math.abs(amount);
    }
    groups.set(key, existing);
  }

  return {
    groupBy,
    total: filtered.length,
    groups: [...groups.values()].sort((left, right) => Math.abs(right.net) - Math.abs(left.net))
  };
}

export function transactionSummary(transactions, accounts = []) {
  const posted = transactions.filter((transaction) => transaction.status !== "removed");
  const pending = posted.filter((transaction) => transaction.status === "pending");
  const credits = posted.filter((transaction) => Number(transaction.amount ?? 0) < 0);
  const spend = posted.reduce((sum, transaction) => {
    const amount = Number(transaction.amount ?? 0);
    return amount > 0 ? sum + amount : sum;
  }, 0);
  const latestDate = posted
    .map((transaction) => transactionDate(transaction))
    .filter(Boolean)
    .sort()
    .at(-1);
  return {
    transactionCount: posted.length,
    accountCount: accounts.length,
    pendingCount: pending.length,
    creditCount: credits.length,
    totalSpend: spend,
    latestDate
  };
}
