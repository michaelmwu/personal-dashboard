import { timingSafeEqual } from "node:crypto";
import {
  CredentialError,
  onePasswordConfig,
  readSecretReference,
  runOnePassword,
  runtimeServiceToken,
  validateSecretReference
} from "../../packages/integrations/onepassword.mjs";
import {
  listPlaidItems,
  replacePlaidItemCredential
} from "../../packages/storage/dashboard-store.mjs";

function validItemId(itemId) {
  if (typeof itemId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(itemId)) {
    throw new CredentialError("invalid_plaid_item", "A valid Plaid Item ID is required.");
  }
}

function sameSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function provisioningIdentity(env = process.env) {
  const writer = env.PERSONAL_DASHBOARD_OP_WRITER_TOKEN?.trim();
  if (!writer)
    throw new CredentialError(
      "writer_required",
      "Owner setup requires a separate 1Password writer token in PERSONAL_DASHBOARD_OP_WRITER_TOKEN."
    );
  const reader = await runtimeServiceToken(env).catch(() => "");
  if (reader && sameSecret(writer, reader)) {
    throw new CredentialError(
      "shared_writer_rejected",
      "The shared read-only service token cannot be used for provisioning."
    );
  }
  return writer;
}

function parseCliJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new CredentialError(
      "invalid_secret_response",
      "1Password returned an invalid provisioning response."
    );
  }
}

export async function provisionPlaidCredential(
  { filePath, itemId, accessToken, institutionName },
  { env = process.env, run = runOnePassword } = {}
) {
  validItemId(itemId);
  if (
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    accessToken.length > 4096 ||
    /[\s\p{Cc}]/u.test(accessToken) ||
    accessToken.startsWith("op://")
  ) {
    throw new CredentialError("invalid_bank_credential", "A valid bank access token is required.");
  }
  const token = await provisioningIdentity(env);
  const { vault } = onePasswordConfig(env);
  const title = `Plaid connection ${itemId}`;
  // A stable title allows recovery if the vault write succeeded but the local
  // store write failed. Never overwrite a different secret during retry.
  const items = parseCliJson(
    await run(["item", "list", "--vault", vault, "--format", "json"], { env, token })
  );
  if (!Array.isArray(items))
    throw new CredentialError(
      "invalid_secret_response",
      "1Password returned an invalid item list."
    );
  const matches = items.filter((item) => item.title === title);
  if (matches.length > 1)
    throw new CredentialError(
      "ambiguous_bank_credential",
      "Multiple 1Password items match this bank connection. Resolve the duplicate items before retrying."
    );
  let secretItem = matches[0];
  if (!secretItem) {
    const template = {
      title,
      category: "SECURE_NOTE",
      fields: [
        { id: "access_token", label: "access_token", type: "CONCEALED", value: accessToken },
        { id: "plaid_item_id", label: "plaid_item_id", type: "STRING", value: itemId }
      ]
    };
    secretItem = parseCliJson(
      await run(["item", "create", "--vault", vault, "--format", "json", "-"], {
        env,
        token,
        input: JSON.stringify(template)
      })
    );
  }
  if (!/^[a-z0-9]{26}$/i.test(secretItem?.id ?? "")) {
    throw new CredentialError(
      "invalid_secret_response",
      "1Password did not return a valid item identifier."
    );
  }
  const accessTokenRef = validateSecretReference(
    `op://${vault}/${secretItem.id}/access_token`,
    env
  );
  const saved = await readSecretReference(accessTokenRef, { env, token, run });
  if (!sameSecret(saved, accessToken)) {
    throw new CredentialError(
      "bank_credential_mismatch",
      "The saved credential does not match this connection. The local store was not changed."
    );
  }
  await replacePlaidItemCredential(filePath, itemId, accessTokenRef, { institutionName });
  return { itemId, accessTokenRef };
}

export async function migratePlaidCredentials(filePath, options = {}) {
  await provisioningIdentity(options.env);
  const items = await listPlaidItems(filePath);
  const results = [];
  for (const item of items) {
    if (item.accessTokenRef && !item.accessToken && !item.encryptedAccessToken) {
      validateSecretReference(item.accessTokenRef, options.env);
      results.push({ itemId: item.id, status: "already-referenced" });
      continue;
    }
    if (item.encryptedAccessToken || !item.accessToken) {
      throw new CredentialError(
        "unsupported_legacy_credential",
        "A connection has no migratable plaintext token. Provision it separately before continuing."
      );
    }
    await provisionPlaidCredential(
      {
        filePath,
        itemId: item.id,
        accessToken: item.accessToken,
        institutionName: item.institutionName
      },
      options
    );
    results.push({ itemId: item.id, status: "migrated" });
  }
  return results;
}
