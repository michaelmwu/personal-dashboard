import { CredentialError, readSecretReference } from "./onepassword.mjs";

export function plaidTokenStorage(env = process.env) {
  const production =
    ["production", "prod"].includes(
      String(env.ENVIRONMENT ?? "")
        .trim()
        .toLowerCase()
    ) ||
    String(env.PLAID_ENV ?? "")
      .trim()
      .toLowerCase() === "production";
  const mode = env.PLAID_TOKEN_STORAGE || (production ? "onepassword" : "local");
  if (!["onepassword", "local"].includes(mode) || (production && mode === "local")) {
    throw new CredentialError(
      "invalid_plaid_token_storage",
      "Production bank connections require 1Password credential storage."
    );
  }
  return mode;
}

export function plaidConnectionCapabilities(env = process.env) {
  const tokenStorage = plaidTokenStorage(env);
  return {
    tokenStorage,
    browserLinkEnabled: tokenStorage === "local",
    onboarding: tokenStorage === "local" ? "browser" : "owner-tool"
  };
}

export async function resolvePlaidAccessToken(
  item,
  { env = process.env, read = readSecretReference } = {}
) {
  const mode = plaidTokenStorage(env);
  if (item.accessTokenRef) return read(item.accessTokenRef, { env });
  if (mode === "onepassword") {
    throw new CredentialError(
      "plaid_token_migration_required",
      "This bank connection needs credential migration before it can sync."
    );
  }
  if (!item.accessToken)
    throw new CredentialError(
      "missing_bank_credential",
      "This bank connection has no saved credential."
    );
  return item.accessToken;
}
