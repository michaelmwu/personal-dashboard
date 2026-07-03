import { Configuration, CountryCode, PlaidApi, PlaidEnvironments, Products } from "plaid";

const PLAID_ENV_URLS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com"
};

const PRODUCT_MAP = {
  transactions: Products.Transactions
};

const COUNTRY_CODE_MAP = {
  US: CountryCode.Us
};

export function plaidConfig(env = process.env) {
  const plaidEnv = env.PLAID_ENV ?? "sandbox";
  return {
    clientId: env.PLAID_CLIENT_ID ?? "",
    secret: env.PLAID_SECRET ?? "",
    env: plaidEnv,
    baseUrl: env.PLAID_BASE_URL ?? PLAID_ENV_URLS[plaidEnv] ?? PLAID_ENV_URLS.sandbox,
    clientName: env.PLAID_CLIENT_NAME ?? "Personal Dashboard",
    products: (env.PLAID_PRODUCTS ?? "transactions")
      .split(",")
      .map((product) => product.trim())
      .filter(Boolean),
    countryCodes: (env.PLAID_COUNTRY_CODES ?? "US")
      .split(",")
      .map((countryCode) => countryCode.trim())
      .filter(Boolean),
    language: env.PLAID_LANGUAGE ?? "en",
    daysRequested: Number.parseInt(env.PLAID_DAYS_REQUESTED ?? "730", 10),
    webhook: env.PLAID_WEBHOOK_URL ?? ""
  };
}

export function isPlaidConfigured(config = plaidConfig()) {
  return Boolean(config.clientId && config.secret);
}

export function createPlaidClient(config = plaidConfig()) {
  return new PlaidApi(
    new Configuration({
      basePath: config.baseUrl ?? PlaidEnvironments[config.env] ?? PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": config.clientId,
          "PLAID-SECRET": config.secret
        }
      }
    })
  );
}

function sdkProducts(products) {
  return products.map((product) => PRODUCT_MAP[product] ?? product);
}

function sdkCountryCodes(countryCodes) {
  return countryCodes.map((countryCode) => COUNTRY_CODE_MAP[countryCode] ?? countryCode);
}

function responseData(response) {
  return response?.data ?? response ?? {};
}

function errorResponse(error) {
  return {
    ok: false,
    status: error?.response?.status ?? 0,
    body: error?.response?.data ?? {
      error: error instanceof Error ? error.message : String(error)
    }
  };
}

async function plaidSdkCall(methodName, body, options = {}) {
  const config = options.config ?? plaidConfig();
  if (!isPlaidConfigured(config)) {
    return { ok: false, status: 0, body: { error: "missing_plaid_config" } };
  }

  const client = options.client ?? createPlaidClient(config);
  try {
    const response = await client[methodName](body);
    return { ok: true, status: response?.status ?? 200, body: responseData(response) };
  } catch (error) {
    return errorResponse(error);
  }
}

export async function createPlaidLinkToken({ userId = "personal-dashboard" } = {}, options = {}) {
  const config = options.config ?? plaidConfig();
  const response = await plaidSdkCall(
    "linkTokenCreate",
    {
      client_name: config.clientName,
      country_codes: sdkCountryCodes(config.countryCodes),
      language: config.language,
      products: sdkProducts(config.products),
      user: {
        client_user_id: userId
      },
      ...(config.webhook ? { webhook: config.webhook } : {})
    },
    { ...options, config }
  );
  return {
    created: response.ok,
    statusCode: response.status,
    linkToken: response.body.link_token,
    expiration: response.body.expiration,
    requestId: response.body.request_id,
    response: response.body
  };
}

export async function exchangePlaidPublicToken(publicToken, options = {}) {
  const response = await plaidSdkCall(
    "itemPublicTokenExchange",
    { public_token: publicToken },
    options
  );
  return {
    exchanged: response.ok,
    statusCode: response.status,
    accessToken: response.body.access_token,
    itemId: response.body.item_id,
    requestId: response.body.request_id,
    response: response.body
  };
}

export async function syncPlaidTransactions({ accessToken, cursor } = {}, options = {}) {
  const config = options.config ?? plaidConfig();
  const client = options.client ?? createPlaidClient(config);
  const count = options.count ?? 500;
  let nextCursor = cursor;
  let hasMore = true;
  const added = [];
  const modified = [];
  const removed = [];
  const accounts = [];
  const requestIds = [];

  while (hasMore) {
    const response = await plaidSdkCall(
      "transactionsSync",
      {
        access_token: accessToken,
        cursor: nextCursor,
        count,
        options: {
          include_personal_finance_category: true,
          days_requested: config.daysRequested
        }
      },
      { config, client }
    );

    if (!response.ok) {
      return {
        synced: false,
        statusCode: response.status,
        cursor: nextCursor,
        added,
        modified,
        removed,
        accounts,
        response: response.body
      };
    }

    added.push(...(response.body.added ?? []));
    modified.push(...(response.body.modified ?? []));
    removed.push(...(response.body.removed ?? []));
    accounts.push(...(response.body.accounts ?? []));
    requestIds.push(response.body.request_id);
    nextCursor = response.body.next_cursor;
    hasMore = Boolean(response.body.has_more);
  }

  return {
    synced: true,
    cursor: nextCursor,
    added,
    modified,
    removed,
    accounts,
    requestIds
  };
}

export function normalizePlaidAccount(account) {
  const balance = account.balances?.current ?? account.balances?.available;
  return {
    id: account.account_id,
    name: account.name ?? account.official_name ?? "Unknown account",
    kind: account.subtype ?? account.type ?? "unknown",
    last4: account.mask ?? "----",
    syncStatus: "synced",
    institutionName: account.institution_name,
    source: "plaid",
    balance: typeof balance === "number" ? balance : undefined
  };
}

export function normalizePlaidTransaction(transaction) {
  return {
    id: transaction.transaction_id,
    accountId: transaction.account_id,
    merchant: transaction.merchant_name ?? transaction.name ?? "Unknown merchant",
    amount: Number(transaction.amount ?? 0),
    category:
      transaction.personal_finance_category?.primary ?? transaction.category?.[0] ?? "Unclassified",
    card: transaction.account_owner ?? transaction.accountName ?? "Unknown account",
    status: transaction.pending ? "pending" : "posted",
    date: transaction.date,
    authorizedDate: transaction.authorized_date,
    pendingTransactionId: transaction.pending_transaction_id,
    source: "plaid"
  };
}

export function normalizeRemovedPlaidTransaction(transaction) {
  return {
    id: transaction.transaction_id,
    accountId: transaction.account_id,
    status: "removed",
    source: "plaid"
  };
}
