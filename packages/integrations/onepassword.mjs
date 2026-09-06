import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class CredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

export function onePasswordConfig(env = process.env) {
  const vault = env.PERSONAL_DASHBOARD_OP_VAULT || "Personal AI";
  if (!vault.trim() || vault !== vault.trim() || /[/\\?#%\p{Cc}]/u.test(vault)) {
    throw new CredentialError(
      "invalid_secret_vault",
      "The credential vault configuration is invalid."
    );
  }
  return { vault, binary: env.PERSONAL_DASHBOARD_OP_BINARY || "/usr/local/bin/op" };
}

export function validateSecretReference(reference, env = process.env) {
  const { vault } = onePasswordConfig(env);
  if (typeof reference !== "string" || !reference.startsWith(`op://${vault}/`)) {
    throw new CredentialError(
      "invalid_secret_reference",
      "The bank credential must reference the configured vault."
    );
  }
  const parts = reference.slice(5).split("/");
  if (
    parts.length !== 3 ||
    parts.some(
      (part) =>
        !part.trim() ||
        part !== part.trim() ||
        [".", ".."].includes(part) ||
        /[\\?#%\p{Cc}]/u.test(part)
    )
  ) {
    throw new CredentialError(
      "invalid_secret_reference",
      "The bank credential reference must name a vault, item, and field."
    );
  }
  return reference;
}

export async function runtimeServiceToken(env = process.env) {
  if (env.OP_SERVICE_ACCOUNT_TOKEN?.trim()) return env.OP_SERVICE_ACCOUNT_TOKEN.trim();
  // op run may remove its own authentication from the child environment. Read
  // only the credential already granted to this service by systemd instead.
  if (env.CREDENTIALS_DIRECTORY) {
    try {
      const token = (
        await readFile(join(env.CREDENTIALS_DIRECTORY, "op-service-account-token"), "utf8")
      ).trim();
      if (token) return token;
    } catch {
      // Never return OS errors containing deployment details or CLI output.
    }
  }
  throw new CredentialError(
    "credential_access_unavailable",
    "1Password access is unavailable. Check the service credential."
  );
}

export function runOnePassword(
  args,
  { env = process.env, token, input = "", timeoutMs = 15000, maxOutputBytes = 262144 } = {}
) {
  const { binary } = onePasswordConfig(env);
  if (typeof token !== "string" || !token.trim()) {
    throw new CredentialError(
      "credential_access_unavailable",
      "1Password service authentication is required."
    );
  }
  const childEnv = { OP_SERVICE_ACCOUNT_TOKEN: token, OP_CACHE: "false" };
  for (const name of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "OP_CONFIG_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ]) {
    if (env[name]) childEnv[name] = env[name];
  }
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child?.kill("SIGKILL");
        reject(error);
      } else resolve(output);
    };
    const failure = () =>
      finish(
        new CredentialError(
          "credential_access_failed",
          "1Password could not access the bank credential. Check access and try again."
        )
      );
    try {
      child = spawn(binary, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"], shell: false });
      timer = setTimeout(failure, timeoutMs);
      child.on("error", failure);
      child.stdin.on("error", failure);
      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) return failure();
        output += chunk.toString("utf8");
      });
      // Drain but never retain/forward stderr: provider tools can echo secrets.
      child.stderr.on("data", () => {});
      child.on("close", (code) => (code === 0 ? finish() : failure()));
      child.stdin.end(input);
    } catch {
      failure();
    }
  });
}

export async function readSecretReference(
  reference,
  { env = process.env, run = runOnePassword, token } = {}
) {
  validateSecretReference(reference, env);
  const resolved = await run(["read", "--no-newline", reference], {
    env,
    token: token ?? (await runtimeServiceToken(env)),
    maxOutputBytes: 8192
  });
  const secret = resolved.trim();
  if (!secret || secret.length > 4096 || /[\s\p{Cc}]/u.test(secret) || secret.startsWith("op://")) {
    throw new CredentialError(
      "invalid_bank_credential",
      "The bank credential in 1Password is empty or invalid."
    );
  }
  return secret;
}
