import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialError,
  readSecretReference,
  runOnePassword,
  runtimeServiceToken,
  validateSecretReference
} from "../packages/integrations/onepassword.mjs";
import {
  plaidConnectionCapabilities,
  resolvePlaidAccessToken
} from "../packages/integrations/plaid-credentials.mjs";
import { syncPlaidTransactions } from "../packages/integrations/plaid.mjs";
import { dashboardFixture } from "../packages/fixtures/dashboard.mjs";
import {
  listPlaidItems,
  loadDashboard,
  upsertPlaidItem
} from "../packages/storage/dashboard-store.mjs";
import {
  migratePlaidCredentials,
  provisionPlaidCredential,
  provisioningIdentity
} from "../scripts/lib/plaid-provisioning.mjs";
import { createPlaidOnboardingServer } from "../scripts/lib/plaid-onboarding.mjs";

const vaultEnv = {
  PERSONAL_DASHBOARD_OP_VAULT: "Personal AI",
  PLAID_TOKEN_STORAGE: "onepassword",
  OP_SERVICE_ACCOUNT_TOKEN: "reader-test"
};
const ownerEnv = { ...vaultEnv, PERSONAL_DASHBOARD_OP_WRITER_TOKEN: "writer-test" };
const itemId = "a".repeat(26);
const reference = `op://Personal AI/${itemId}/access_token`;

async function scratch(run) {
  const dir = await mkdtemp(join(tmpdir(), "dashboard-credentials-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeVault({ failCreate = false, failRead = false, existingToken } = {}) {
  let saved = existingToken;
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    if (args[1] === "list")
      return JSON.stringify(saved ? [{ id: itemId, title: "Plaid connection item_test" }] : []);
    if (args[1] === "create") {
      if (failCreate) throw new CredentialError("credential_access_failed", "Test write failure.");
      saved = JSON.parse(options.input).fields[0].value;
      return JSON.stringify({ id: itemId });
    }
    if (args[0] === "read") {
      if (failRead) throw new CredentialError("credential_access_failed", "Test read failure.");
      return saved;
    }
    throw new Error("unexpected CLI command");
  };
  return { run, calls };
}

async function withOnboarding(options, run) {
  const { server, nonce } = createPlaidOnboardingServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: base, "Content-Type": "application/json", "X-Onboarding-Token": nonce };
  const post = (path, body = {}, overrides = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers, ...overrides },
      body: JSON.stringify(body)
    });
  try {
    await run({ base, post, nonce });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("read-only Plaid credentials", () => {
  test("production defaults to references and cannot select local plaintext storage", () => {
    expect(plaidConnectionCapabilities({ ENVIRONMENT: "production" })).toMatchObject({
      browserLinkEnabled: false,
      onboarding: "owner-tool"
    });
    expect(() =>
      plaidConnectionCapabilities({ PLAID_ENV: "production", PLAID_TOKEN_STORAGE: "local" })
    ).toThrow("require 1Password");
    for (const env of [{ PLAID_ENV: " Production " }, { ENVIRONMENT: "PROD" }]) {
      expect(plaidConnectionCapabilities(env).tokenStorage).toBe("onepassword");
    }
    expect(plaidConnectionCapabilities({})).toMatchObject({
      browserLinkEnabled: true,
      tokenStorage: "local"
    });
    expect(() => plaidConnectionCapabilities({ PLAID_TOKEN_STORAGE: "typo" })).toThrow();
  });
  test("references are limited to one configured vault and cannot carry CLI flags or transforms", () => {
    expect(validateSecretReference(reference, vaultEnv)).toBe(reference);
    for (const invalid of [
      "op://Private/id/password",
      "op://Personal AI/id/password?attribute=otp",
      "op://Personal AI/id/field/extra",
      "op://Personal AI//field",
      "op://Personal AI/../field",
      "op://Personal AI/id/field\n",
      "--out-file=/tmp/leak",
      "op://Personal AI/id/%66ield"
    ]) {
      expect(() => validateSecretReference(invalid, vaultEnv)).toThrow();
    }
  });
  test("runtime takes environment authentication or the existing systemd credential", async () => {
    expect(await runtimeServiceToken(vaultEnv)).toBe("reader-test");
    await scratch(async (dir) => {
      await writeFile(join(dir, "op-service-account-token"), "reader-file-test\n");
      expect(await runtimeServiceToken({ CREDENTIALS_DIRECTORY: dir })).toBe("reader-file-test");
    });
    await expect(runtimeServiceToken({})).rejects.toMatchObject({
      code: "credential_access_unavailable"
    });
  });
  test("sync resolves tokens anew and refuses plaintext fallback when a reference fails", async () => {
    const calls = [];
    let value = "access-rotated-1";
    const run = async (args, options) => {
      calls.push({ args, options });
      return value;
    };
    const read = (ref, options) => readSecretReference(ref, { ...options, run });
    const item = { accessTokenRef: reference, accessToken: "must-not-be-used" };
    expect(await resolvePlaidAccessToken(item, { env: vaultEnv, read })).toBe(value);
    value = "access-rotated-2";
    expect(await resolvePlaidAccessToken(item, { env: vaultEnv, read })).toBe(value);
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(["read", "--no-newline", reference]);
    expect(calls[0].options.token).toBe("reader-test");
    await expect(
      resolvePlaidAccessToken({ accessToken: "legacy" }, { env: vaultEnv })
    ).rejects.toMatchObject({ code: "plaid_token_migration_required" });
    await expect(
      resolvePlaidAccessToken(item, {
        env: vaultEnv,
        read: async () => {
          throw new CredentialError("credential_access_failed", "no access");
        }
      })
    ).rejects.toMatchObject({ code: "credential_access_failed" });
  });
  test("empty, multiline and unresolved vault values are rejected", async () => {
    for (const value of ["", "op://Personal AI/other/field", "secret\nsecond", "a".repeat(4097)]) {
      await expect(
        readSecretReference(reference, { env: vaultEnv, run: async () => value })
      ).rejects.toMatchObject({ code: "invalid_bank_credential" });
    }
  });
  test("provider error messages cannot echo credentials into API responses or stored sync errors", async () => {
    const result = await syncPlaidTransactions(
      { accessToken: "bank-secret-test" },
      {
        config: { clientId: "client-id-test", secret: "app-secret-test" },
        client: {
          transactionsSync: async () => {
            throw {
              response: {
                status: 400,
                data: {
                  error_code: "INVALID_ACCESS_TOKEN",
                  error_message: "bank-secret-test app-secret-test client-id-test",
                  details: ["bank-secret-test"]
                }
              }
            };
          }
        }
      }
    );
    expect(result.synced).toBe(false);
    expect(result.response.error_code).toBe("INVALID_ACCESS_TOKEN");
    for (const secret of ["bank-secret-test", "app-secret-test", "client-id-test"])
      expect(JSON.stringify(result)).not.toContain(secret);
  });
  test("CLI subprocesses receive only their credential and never inherited application or writer secrets", async () => {
    const output = await runOnePassword(
      [
        "-e",
        "process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({reader:process.env.OP_SERVICE_ACCOUNT_TOKEN,writer:process.env.PERSONAL_DASHBOARD_OP_WRITER_TOKEN,plaid:process.env.PLAID_SECRET,cache:process.env.OP_CACHE})))"
      ],
      {
        env: {
          ...ownerEnv,
          PERSONAL_DASHBOARD_OP_BINARY: process.execPath,
          PLAID_SECRET: "must-not-inherit"
        },
        token: "reader-test"
      }
    );
    expect(JSON.parse(output)).toEqual({ reader: "reader-test", cache: "false" });
  });
  test("CLI failures, oversized output and timeouts expose no secret output", async () => {
    for (const [source, options] of [
      ["console.error('secret-stderr'); console.log('secret-stdout'); process.exit(1)", {}],
      ["process.stdout.write('secret-output'.repeat(1000))", { maxOutputBytes: 16 }],
      ["setInterval(()=>{},1000)", { timeoutMs: 30 }]
    ]) {
      try {
        await runOnePassword(["-e", source], {
          env: { PERSONAL_DASHBOARD_OP_BINARY: process.execPath },
          token: "reader-test",
          ...options
        });
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(CredentialError);
        expect(String(error)).not.toContain("secret-");
        expect(String(error)).not.toContain("reader-test");
      }
    }
  });
});

describe("owner provisioning and migration", () => {
  test("provisioning requires an explicit separate identity", async () => {
    await expect(provisioningIdentity(vaultEnv)).rejects.toMatchObject({ code: "writer_required" });
    await expect(
      provisioningIdentity({ ...vaultEnv, PERSONAL_DASHBOARD_OP_WRITER_TOKEN: "reader-test" })
    ).rejects.toMatchObject({ code: "shared_writer_rejected" });
  });
  test("migration writes concealed values over stdin, verifies them, then replaces plaintext while retaining metadata", async () => {
    await scratch(async (dir) => {
      const filePath = join(dir, "store.json");
      await upsertPlaidItem(filePath, {
        id: "item_test",
        accessToken: "access-legacy",
        cursor: "cursor-4",
        institutionName: "Test bank",
        linkedAt: "2026-01-01"
      });
      const vault = fakeVault();
      expect(await migratePlaidCredentials(filePath, { env: ownerEnv, run: vault.run })).toEqual([
        { itemId: "item_test", status: "migrated" }
      ]);
      const text = await readFile(filePath, "utf8");
      expect(text).not.toContain("access-legacy");
      expect(text).not.toContain('"accessToken":');
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect(await listPlaidItems(filePath)).toMatchObject([
        {
          id: "item_test",
          accessTokenRef: reference,
          cursor: "cursor-4",
          institutionName: "Test bank",
          linkedAt: "2026-01-01"
        }
      ]);
      const create = vault.calls.find((call) => call.args[1] === "create");
      expect(create.args).not.toContain("access-legacy");
      expect(JSON.parse(create.options.input).fields[0]).toMatchObject({
        type: "CONCEALED",
        value: "access-legacy"
      });
      expect(create.options.token).toBe("writer-test");
      const snapshot = JSON.stringify(await loadDashboard(dashboardFixture(), filePath));
      expect(snapshot).not.toContain(reference);
      expect(snapshot).not.toContain("cursor-4");
      expect(snapshot).not.toContain("access-legacy");
      const before = vault.calls.length;
      expect(await migratePlaidCredentials(filePath, { env: ownerEnv, run: vault.run })).toEqual([
        { itemId: "item_test", status: "already-referenced" }
      ]);
      expect(vault.calls.length).toBe(before);
    });
  });
  test("failed writes, failed verification and conflicting existing secrets preserve the original store", async () => {
    for (const settings of [
      { failCreate: true },
      { failRead: true },
      { existingToken: "different-token" }
    ]) {
      await scratch(async (dir) => {
        const filePath = join(dir, "store.json");
        await upsertPlaidItem(filePath, {
          id: "item_test",
          accessToken: "access-legacy",
          cursor: "keep"
        });
        const before = await readFile(filePath, "utf8");
        await expect(
          migratePlaidCredentials(filePath, { env: ownerEnv, run: fakeVault(settings).run })
        ).rejects.toBeInstanceOf(CredentialError);
        expect(await readFile(filePath, "utf8")).toBe(before);
      });
    }
  });
  test("retry reuses a verified vault item after an interrupted local store write", async () => {
    await scratch(async (dir) => {
      const vault = fakeVault({ existingToken: "access-legacy" });
      await provisionPlaidCredential(
        { filePath: join(dir, "store.json"), itemId: "item_test", accessToken: "access-legacy" },
        { env: ownerEnv, run: vault.run }
      );
      expect(vault.calls.map((call) => call.args[0])).toEqual(["item", "read"]);
      expect(vault.calls.some((call) => call.args[1] === "create")).toBe(false);
    });
  });
});

describe("owner Link session", () => {
  test("loopback onboarding requires its capability and same-origin requests; secrets never enter responses", async () => {
    let linkCalls = 0;
    let saved;
    await withOnboarding(
      {
        link: async () => {
          linkCalls++;
          return { created: true, linkToken: "link-test" };
        },
        exchange: async () => ({
          exchanged: true,
          itemId: "item_test",
          accessToken: "access-owner-secret"
        }),
        provision: async (value) => {
          saved = value;
        }
      },
      async ({ base, post, nonce }) => {
        const html = await (await fetch(base)).text();
        expect(html).not.toContain(nonce);
        expect((await post("/link-token", {}, { "X-Onboarding-Token": "" })).status).toBe(403);
        expect((await post("/link-token", {}, { Origin: "https://hostile.example" })).status).toBe(
          403
        );
        expect((await post("/link-token", {}, { Host: "hostile.example" })).status).toBe(403);
        expect(linkCalls).toBe(0);
        expect(await (await post("/link-token")).json()).toEqual({ linkToken: "link-test" });
        const response = await post("/exchange", {
          publicToken: "public-test",
          institutionName: "Test bank"
        });
        expect(await response.json()).toEqual({ accepted: true });
        expect(saved).toMatchObject({
          itemId: "item_test",
          accessToken: "access-owner-secret",
          institutionName: "Test bank"
        });
        expect((await post("/exchange", { publicToken: "public-test" })).status).toBe(409);
      }
    );
  });
  test("failed vault writes can retry without exchanging the single-use public token again", async () => {
    let exchanges = 0;
    let saves = 0;
    await withOnboarding(
      {
        exchange: async () => {
          exchanges++;
          return { exchanged: true, itemId: "item_test", accessToken: "private-token" };
        },
        provision: async () => {
          if (++saves === 1) throw new Error("private-token raw provider error");
        }
      },
      async ({ post }) => {
        const first = await post("/exchange", { publicToken: "public-test" });
        expect(first.status).toBe(503);
        expect(await first.text()).not.toContain("private-token");
        expect((await post("/link-token")).status).toBe(409);
        expect((await post("/exchange", { publicToken: "public-test" })).status).toBe(200);
        expect(exchanges).toBe(1);
        expect(saves).toBe(2);
      }
    );
  });
  test("expired sessions refuse provider calls", async () => {
    await withOnboarding(
      {
        ttlMs: -1,
        link: async () => {
          throw new Error("must not run");
        }
      },
      async ({ post }) => {
        expect((await post("/link-token")).status).toBe(403);
      }
    );
  });
});

describe("deployed API credential boundary", () => {
  test("sync resolves references through read-only CLI, isolates failures and rejects browser exchanges before Plaid calls", async () => {
    await scratch(async (dir) => {
      const filePath = join(dir, "store.json");
      await upsertPlaidItem(filePath, {
        id: "item_test",
        accessTokenRef: reference,
        cursor: "cursor-old"
      });
      await upsertPlaidItem(filePath, { id: "item_legacy", accessToken: "legacy-test-token" });
      const binary = join(dir, "fake-op.mjs");
      await writeFile(
        binary,
        `#!${process.execPath}\nif(process.argv.slice(2).join('|') !== ${JSON.stringify(`read|--no-newline|${reference}`)} || process.env.OP_SERVICE_ACCOUNT_TOKEN !== 'reader-test' || process.env.PLAID_SECRET) process.exit(1); process.stdout.write('bank-test-token');\n`,
        { mode: 0o700 }
      );
      const providerCalls = [];
      const provider = http.createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        providerCalls.push({ path: request.url, body: JSON.parse(raw) });
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            accounts: [],
            added: [],
            modified: [],
            removed: [],
            next_cursor: "cursor-new",
            has_more: false,
            request_id: "request-test"
          })
        );
      });
      await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
      const child = spawn(
        process.execPath,
        [
          "--eval",
          "const {createApiServer}=await import('./apps/api/server.mjs');const server=createApiServer({apiToken:'test-dashboard-token'});server.listen(0,'127.0.0.1',()=>console.log(server.address().port));"
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            ENVIRONMENT: "production",
            DASHBOARD_FIXTURES_ENABLED: "false",
            DASHBOARD_DATA_FILE: filePath,
            PLAID_TOKEN_STORAGE: "onepassword",
            PERSONAL_DASHBOARD_OP_VAULT: "Personal AI",
            PERSONAL_DASHBOARD_OP_BINARY: binary,
            OP_SERVICE_ACCOUNT_TOKEN: "reader-test",
            PLAID_CLIENT_ID: "client-test",
            PLAID_SECRET: "client-secret-test",
            PLAID_ENV: "sandbox",
            PLAID_BASE_URL: `http://127.0.0.1:${provider.address().port}`
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics += chunk;
      });
      try {
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("test API startup timeout")), 5000);
          child.stdout.once("data", (chunk) => {
            clearTimeout(timer);
            resolve(Number(chunk.toString().trim()));
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("test API exited"));
          });
        });
        const base = `http://127.0.0.1:${port}`;
        const headers = {
          Authorization: "Bearer test-dashboard-token",
          "Content-Type": "application/json"
        };
        expect(
          await (await fetch(`${base}/api/integrations/plaid/connection-settings`)).json()
        ).toEqual({
          tokenStorage: "onepassword",
          browserLinkEnabled: false,
          onboarding: "owner-tool"
        });
        for (const path of ["link-token", "exchange-public-token"]) {
          expect(
            (
              await fetch(`${base}/api/integrations/plaid/${path}`, {
                method: "POST",
                headers,
                body: JSON.stringify({ publicToken: "public-test" })
              })
            ).status
          ).toBe(409);
        }
        expect(providerCalls).toHaveLength(0);
        expect(
          (
            await fetch(`${base}/api/integrations/plaid/sync`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}"
            })
          ).status
        ).toBe(401);
        expect(providerCalls).toHaveLength(0);
        const response = await fetch(`${base}/api/integrations/plaid/sync`, {
          method: "POST",
          headers,
          body: "{}"
        });
        expect(response.status).toBe(207);
        const payload = await response.json();
        expect(payload.results).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ itemId: "item_test", synced: true }),
            expect.objectContaining({
              itemId: "item_legacy",
              synced: false,
              reason: "plaid_token_migration_required"
            })
          ])
        );
        expect(providerCalls).toHaveLength(1);
        expect(providerCalls[0]).toMatchObject({
          path: "/transactions/sync",
          body: { access_token: "bank-test-token", cursor: "cursor-old" }
        });
        const dashboard = await (await fetch(`${base}/api/dashboard`)).text();
        for (const secret of [
          "bank-test-token",
          "reader-test",
          reference,
          "cursor-new",
          "legacy-test-token"
        ])
          expect(dashboard).not.toContain(secret);
        expect(JSON.stringify(payload)).not.toContain("bank-test-token");
        expect(diagnostics).not.toContain("bank-test-token");
        const items = await listPlaidItems(filePath);
        expect(items.find((item) => item.id === "item_test")).toMatchObject({
          accessTokenRef: reference,
          cursor: "cursor-new"
        });
        expect(items.find((item) => item.id === "item_test").accessToken).toBeUndefined();
      } finally {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        if (child.exitCode === null && child.signalCode === null) await exited;
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
    });
  });
});
