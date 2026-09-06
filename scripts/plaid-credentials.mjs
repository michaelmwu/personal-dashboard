import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CredentialError } from "../packages/integrations/onepassword.mjs";
import { createPlaidOnboardingServer } from "./lib/plaid-onboarding.mjs";
import { migratePlaidCredentials, provisioningIdentity } from "./lib/plaid-provisioning.mjs";

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command, ...flags] = args;
  if (command === "--help") {
    console.log(
      "Usage: bun scripts/plaid-credentials.mjs <link|migrate> --offline --store <dashboard-store.json>\nStop the dashboard API and worker before running. Requires separate owner writer credentials; never run under the shared service identity."
    );
    return;
  }
  if (
    !["link", "migrate"].includes(command) ||
    flags.length !== 3 ||
    flags[0] !== "--offline" ||
    flags[1] !== "--store" ||
    !flags[2]
  ) {
    throw new CredentialError(
      "invalid_arguments",
      "Use <link|migrate> --offline --store <path>. Stop the API and worker before editing their shared store."
    );
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const filePath = resolve(root, flags[2]);
  await provisioningIdentity(env);
  if (command === "migrate") {
    const results = await migratePlaidCredentials(filePath, { env });
    console.log(
      `Credential migration complete: ${results.filter((item) => item.status === "migrated").length} migrated, ${results.filter((item) => item.status === "already-referenced").length} already referenced.`
    );
    return;
  }
  let shutdownTimer;
  const { server, nonce } = createPlaidOnboardingServer({
    filePath,
    env,
    onComplete: () => {
      console.log("Connection saved in 1Password. Restart the dashboard services to sync.");
      clearTimeout(shutdownTimer);
      server.close();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  console.log(
    `Open this one-time owner setup URL on this host: http://127.0.0.1:${server.address().port}/#${nonce}`
  );
  shutdownTimer = setTimeout(
    () => {
      console.log("Owner setup expired. Restart the tool if needed.");
      server.closeAllConnections();
      server.close();
    },
    15 * 60 * 1000
  );
  await new Promise((resolveClose) => server.once("close", resolveClose));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      error instanceof CredentialError
        ? error.message
        : "Credential setup failed. Check configuration and retry; no secret values are printed."
    );
    process.exitCode = 1;
  });
}
