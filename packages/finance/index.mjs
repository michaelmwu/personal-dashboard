const CREDIT_ACCOUNT_TYPE = "credit";
const DEPOSITORY_ACCOUNT_TYPE = "depository";
const SUPPORTED_ACCOUNT_TYPES = new Set([CREDIT_ACCOUNT_TYPE, DEPOSITORY_ACCOUNT_TYPE]);

const FEE_TRANSACTION_CODES = new Map([
  ["late fee", "late"],
  ["membership fee", "annual"],
  ["bank charge", "bank"],
  ["returned item fee", "returned-item"],
  ["interest", "interest"]
]);

const FEE_PATTERNS = [
  ["late", /\blate (?:payment )?fee\b/i],
  ["annual", /\b(?:annual|membership|cardmember) fee\b/i],
  ["overdraft", /\b(?:overdraft|insufficient funds|nsf) fee\b/i],
  ["foreign-transaction", /\b(?:foreign transaction|fx|international) fee\b/i],
  ["atm", /\batm (?:usage )?fee\b/i],
  ["returned-item", /\b(?:returned item|returned payment|return(?:ed)? check) fee\b/i],
  ["interest", /\b(?:interest charge|finance charge)\b/i],
  ["bank", /\b(?:service|bank) charge\b/i]
];

const CREDIT_PATTERNS = /\b(?:statement credit|reimbursement|benefit credit|credit adjustment)\b/i;
const REFUND_PATTERNS = /\b(?:refund|return)\b/i;
const PAYMENT_PATTERNS = /\b(?:payment|autopay|auto payment)\b/i;
const TRANSFER_PATTERNS = /\b(?:transfer|zelle|venmo|cash app)\b/i;

function asString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function normalizedText(value) {
  return asString(value).trim().toLowerCase();
}

function numericValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dateKey(value) {
  const candidate = asString(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

function transactionDate(transaction) {
  return dateKey(transaction?.date ?? transaction?.authorizedDate);
}

function transactionText(transaction) {
  return [
    transaction?.merchant,
    transaction?.name,
    transaction?.originalDescription,
    transaction?.transactionCode,
    transaction?.category,
    transaction?.categoryDetailed
  ]
    .map(asString)
    .join(" ");
}

function transactionCategoryText(transaction) {
  return [transaction?.category, transaction?.categoryDetailed].map(normalizedText).join(" ");
}

function isPosted(transaction) {
  return (transaction?.status ?? "posted") !== "pending" && transaction?.status !== "removed";
}

function matchesDateRange(transaction, { startDate, endDate } = {}) {
  const date = transactionDate(transaction);
  return Boolean(date) && (!startDate || date >= startDate) && (!endDate || date <= endDate);
}

function toUtcDate(value = new Date()) {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  return new Date(value);
}

function utcDateKey(year, monthIndex, day = 1) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function lastDayOfUtcMonth(year, monthIndex) {
  return utcDateKey(year, monthIndex + 1, 0);
}

function descriptorMatches(transaction, patterns) {
  const text = normalizedText(transactionText(transaction));
  return patterns.some((pattern) => text.includes(normalizedText(pattern)));
}

function financeAccountTypeQuery(value) {
  const values = Array.isArray(value) ? value : [value];
  return (
    values.map(normalizedText).find((accountType) => SUPPORTED_ACCOUNT_TYPES.has(accountType)) ?? ""
  );
}

export function financeAccountType(account = {}) {
  const type = normalizedText(account.type);
  if (SUPPORTED_ACCOUNT_TYPES.has(type)) {
    return type;
  }

  const legacy = `${normalizedText(account.kind)} ${normalizedText(account.subtype)}`;
  if (/\b(?:credit|charge card)\b/.test(legacy)) {
    return CREDIT_ACCOUNT_TYPE;
  }
  if (/\b(?:checking|savings|depository|cash|money market|prepaid)\b/.test(legacy)) {
    return DEPOSITORY_ACCOUNT_TYPE;
  }
  return "other";
}

export function financeAccountLabel(account = {}) {
  const name = account.name ?? "Unknown account";
  const last4 = account.last4 && account.last4 !== "----" ? ` • ${account.last4}` : "";
  return `${name}${last4}`;
}

export function oneYearAgoDate(now = new Date()) {
  const date = toUtcDate(now);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

export function classifyFinanceTransaction(transaction = {}) {
  const amount = numericValue(transaction.amount);
  const transactionCode = normalizedText(transaction.transactionCode);
  const category = transactionCategoryText(transaction);
  const text = transactionText(transaction);
  const codeFeeType = FEE_TRANSACTION_CODES.get(transactionCode);
  const patternFee = FEE_PATTERNS.find(([, pattern]) => pattern.test(text));
  const categoryIndicatesFee = /\b(?:bank fees?|fees?)\b/i.test(category);
  const isFee = Boolean(codeFeeType || patternFee || categoryIndicatesFee);
  const feeType = codeFeeType ?? patternFee?.[0] ?? (categoryIndicatesFee ? "bank" : undefined);

  if (isFee) {
    return {
      kind: "fee",
      feeType,
      severity:
        feeType === "late" || feeType === "overdraft" || feeType === "returned-item"
          ? "high"
          : feeType === "interest" || feeType === "annual"
            ? "medium"
            : "low",
      isFee: true,
      isCredit: false
    };
  }

  const looksLikePayment =
    transactionCode === "payment" ||
    /credit.?card payment|loan payments?/.test(category) ||
    PAYMENT_PATTERNS.test(text);
  const looksLikeTransfer =
    transactionCode === "transfer" || /\btransfer\b/.test(category) || TRANSFER_PATTERNS.test(text);
  const looksLikeRefund = /\brefund\b/.test(category) || REFUND_PATTERNS.test(text);
  const looksLikeStatementCredit = CREDIT_PATTERNS.test(text);
  const looksLikeIncome = /\b(?:income|payroll|deposit)\b/.test(category);

  if (looksLikePayment) {
    return { kind: "payment", isFee: false, isCredit: amount < 0 };
  }
  if (looksLikeTransfer) {
    return { kind: "transfer", isFee: false, isCredit: amount < 0 };
  }
  if (looksLikeRefund) {
    return { kind: "refund", isFee: false, isCredit: amount < 0 };
  }
  if (looksLikeStatementCredit) {
    return { kind: "statement-credit", isFee: false, isCredit: amount < 0 };
  }
  if (looksLikeIncome) {
    return { kind: "income", isFee: false, isCredit: amount < 0 };
  }
  if (amount < 0) {
    return { kind: "credit", isFee: false, isCredit: true };
  }
  return { kind: "purchase", isFee: false, isCredit: false };
}

export function financeFeeWatch(transactions = [], accounts = [], query = {}) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountType = financeAccountTypeQuery(query.accountType);

  return transactions
    .filter((transaction) => {
      const account = accountById.get(transaction.accountId);
      return (
        isPosted(transaction) &&
        matchesDateRange(transaction, query) &&
        (!accountType || financeAccountType(account ?? transaction) === accountType) &&
        classifyFinanceTransaction(transaction).isFee
      );
    })
    .map((transaction) => {
      const account = accountById.get(transaction.accountId);
      const classification = classifyFinanceTransaction(transaction);
      return {
        id: transaction.id,
        date: transactionDate(transaction),
        merchant: transaction.merchant ?? transaction.name ?? "Unknown charge",
        amount: numericValue(transaction.amount),
        currency: transaction.isoCurrencyCode ?? transaction.unofficialCurrencyCode ?? "USD",
        accountId: transaction.accountId,
        account: account ? financeAccountLabel(account) : (transaction.card ?? "Unknown account"),
        classification,
        source: transaction.source
      };
    })
    .sort((left, right) => right.date.localeCompare(left.date));
}

export function financeBenefitPeriod(benefit = {}, now = new Date()) {
  const date = toUtcDate(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const period = benefit.period ?? "annual";

  if (period === "monthly") {
    return { startDate: utcDateKey(year, month), endDate: lastDayOfUtcMonth(year, month) };
  }
  if (period === "quarterly") {
    const quarterStart = Math.floor(month / 3) * 3;
    return {
      startDate: utcDateKey(year, quarterStart),
      endDate: lastDayOfUtcMonth(year, quarterStart + 2)
    };
  }
  if (period === "cardmember-year") {
    const configuredMonth =
      Math.min(Math.max(numericValue(benefit.periodStartMonth, 1), 1), 12) - 1;
    const startsThisYear = utcDateKey(year, configuredMonth);
    const startYear = date.toISOString().slice(0, 10) < startsThisYear ? year - 1 : year;
    return {
      startDate: utcDateKey(startYear, configuredMonth),
      endDate: utcDateKey(startYear + 1, configuredMonth, 0)
    };
  }
  return { startDate: utcDateKey(year, 0), endDate: utcDateKey(year, 11, 31) };
}

export function financeBenefitStatus(
  benefits = [],
  transactions = [],
  accounts = [],
  now = new Date()
) {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const assignedCreditIds = new Set();

  return benefits
    .filter((benefit) => benefit?.enabled !== false)
    .map((benefit) => {
      const period = financeBenefitPeriod(benefit, now);
      const patterns = Array.isArray(benefit.descriptorPatterns)
        ? benefit.descriptorPatterns.map((pattern) => asString(pattern).trim()).filter(Boolean)
        : [];
      const matches = patterns.length
        ? transactions
            .filter((transaction) => {
              const classification = classifyFinanceTransaction(transaction);
              return (
                !assignedCreditIds.has(transaction.id) &&
                transaction.accountId === benefit.accountId &&
                isPosted(transaction) &&
                transactionDate(transaction) >= period.startDate &&
                transactionDate(transaction) <= period.endDate &&
                numericValue(transaction.amount) < 0 &&
                classification.kind !== "payment" &&
                classification.kind !== "transfer" &&
                descriptorMatches(transaction, patterns)
              );
            })
            .sort((left, right) => transactionDate(left).localeCompare(transactionDate(right)))
        : [];
      for (const match of matches) {
        assignedCreditIds.add(match.id);
      }
      const creditedAmount = matches.reduce(
        (sum, transaction) => sum + Math.abs(numericValue(transaction.amount)),
        0
      );
      const amount = Math.max(numericValue(benefit.amount), 0);
      const remainingAmount = Math.max(amount - creditedAmount, 0);
      const status =
        patterns.length === 0
          ? "needs-setup"
          : creditedAmount === 0
            ? "available"
            : remainingAmount > 0
              ? "partial"
              : "credited";
      const account = accountById.get(benefit.accountId);
      return {
        ...benefit,
        amount,
        account: account ? financeAccountLabel(account) : "Unknown account",
        currency: benefit.currency ?? "USD",
        period,
        creditedAmount,
        remainingAmount,
        status,
        matches: matches.map((transaction) => ({
          id: transaction.id,
          date: transactionDate(transaction),
          merchant: transaction.merchant ?? transaction.name ?? "Unknown credit",
          amount: Math.abs(numericValue(transaction.amount))
        }))
      };
    })
    .sort(
      (left, right) =>
        left.account.localeCompare(right.account) || left.name.localeCompare(right.name)
    );
}

export function financeOverview(
  { accounts = [], transactions = [], benefits = [], sync = {} } = {},
  query = {},
  now = new Date()
) {
  const accountType = financeAccountTypeQuery(query.accountType);
  const scopedAccounts = accountType
    ? accounts.filter((account) => financeAccountType(account) === accountType)
    : accounts;
  const scopedAccountIds = new Set(scopedAccounts.map((account) => account.id));
  const scopedTransactions = transactions.filter(
    (transaction) =>
      (!accountType || scopedAccountIds.has(transaction.accountId)) &&
      ((!query.startDate && !query.endDate) || matchesDateRange(transaction, query))
  );
  const scopedBenefits = accountType
    ? benefits.filter((benefit) => scopedAccountIds.has(benefit.accountId))
    : benefits;
  const posted = scopedTransactions.filter(isPosted);
  const fees = financeFeeWatch(scopedTransactions, scopedAccounts, query);
  const credits = posted.filter((transaction) => {
    const classification = classifyFinanceTransaction(transaction);
    return (
      numericValue(transaction.amount) < 0 &&
      classification.kind !== "payment" &&
      classification.kind !== "transfer"
    );
  });
  const spending = posted.reduce((sum, transaction) => {
    const classification = classifyFinanceTransaction(transaction);
    return classification.kind === "purchase" && numericValue(transaction.amount) > 0
      ? sum + numericValue(transaction.amount)
      : sum;
  }, 0);

  return {
    version: "finance-overview.v1",
    accountType: accountType || "all",
    period: {
      startDate: query.startDate ?? "",
      endDate: query.endDate ?? ""
    },
    sync,
    accounts: scopedAccounts,
    summary: {
      transactionCount: posted.length,
      spend: spending,
      feeCount: fees.length,
      feeAmount: fees.reduce((sum, fee) => sum + Math.abs(fee.amount), 0),
      creditCount: credits.length,
      creditAmount: credits.reduce(
        (sum, transaction) => sum + Math.abs(numericValue(transaction.amount)),
        0
      )
    },
    feeWatch: fees,
    benefits: financeBenefitStatus(scopedBenefits, scopedTransactions, scopedAccounts, now),
    recentCredits: credits
      .map((transaction) => ({
        id: transaction.id,
        date: transactionDate(transaction),
        merchant: transaction.merchant ?? transaction.name ?? "Unknown credit",
        amount: Math.abs(numericValue(transaction.amount)),
        currency: transaction.isoCurrencyCode ?? transaction.unofficialCurrencyCode ?? "USD",
        classification: classifyFinanceTransaction(transaction)
      }))
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, 12)
  };
}
