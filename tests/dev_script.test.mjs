import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawned = new Set();
let occupiedServer;

function waitForListening(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function runDevWithEnv(env) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["scripts/dev.mjs"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    spawned.add(child);
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("exit", (code, signal) => {
      spawned.delete(child);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function runShellDevWithEnv(env) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ...env };
    for (const [key, value] of Object.entries(childEnv)) {
      if (value === undefined) {
        delete childEnv[key];
      }
    }
    const child = spawn("sh", ["scripts/dev.sh"], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });

    spawned.add(child);
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("exit", (code, signal) => {
      spawned.delete(child);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const child of spawned) {
    child.kill("SIGTERM");
  }
  spawned.clear();

  if (occupiedServer) {
    await new Promise((resolve) => occupiedServer.close(resolve));
    occupiedServer = undefined;
  }
});

describe("dev script", () => {
  test("returns non-zero when a child service fails to start", async () => {
    occupiedServer = http.createServer((_request, response) => response.end("occupied"));
    await waitForListening(occupiedServer, 19980);

    const result = await runDevWithEnv({
      API_PORT: "19980",
      WEB_PORT: "19981"
    });

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("[api] exited with 1");
  });

  test("isolates gateway configuration from dashboard children", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "personal-dashboard-dev-script-"));
    const fakeBinDir = join(tempDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const gatewayEnvFile = join(tempDir, ".env.email-gateway");
    const shellSideEffect = join(tempDir, "shell-source-side-effect");

    try {
      await mkdir(fakeBinDir);
      await writeFile(
        gatewayEnvFile,
        [
          "EMAIL_GATEWAY_DASHBOARD_EVENT_TOKEN=gateway-event-token",
          "GOOGLE_CLIENT_SECRET=private-google-secret",
          `UNSAFE=$(touch ${shellSideEffect})`
        ].join("\n")
      );
      await writeFile(
        fakeBun,
        `#!/usr/bin/env sh
set -eu
role="$(basename "$(dirname "$1")")"
capture_dir="\${FAKE_CAPTURE_DIR:-$(dirname "$EMAIL_GATEWAY_ENV_FILE")}"
env | sort > "$capture_dir/$role.env"
`,
        { mode: 0o755 }
      );
      await chmod(fakeBun, 0o755);

      const result = await runShellDevWithEnv({
        CONDUCTOR_PORT: "23970",
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        FAKE_CAPTURE_DIR: tempDir,
        EMAIL_GATEWAY_ENABLED: "true",
        EMAIL_GATEWAY_ENV_FILE: gatewayEnvFile,
        EMAIL_GATEWAY_EVENT_TOKEN: "dashboard-event-token",
        EMAIL_GATEWAY_DASHBOARD_TOKEN: "scoped-reader-token",
        PERSONAL_DASHBOARD_API_TOKEN: "dashboard-api-token",
        EMAIL_GATEWAY_API_BASE_URL: undefined,
        EMAIL_GATEWAY_ADMIN_TOKEN: "outer-admin-token",
        EMAIL_GATEWAY_DASHBOARD_EVENT_TOKEN: "outer-event-token",
        GOOGLE_CLIENT_SECRET: "outer-google-secret",
        GMAIL_TEST_SECRET: "outer-gmail-secret"
      });

      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(await exists(shellSideEffect)).toBe(false);

      const [apiEnv, webEnv, gatewayEnv] = await Promise.all([
        readFile(join(tempDir, "api.env"), "utf8"),
        readFile(join(tempDir, "web.env"), "utf8"),
        readFile(join(tempDir, "email-gateway.env"), "utf8")
      ]);

      expect(apiEnv).toContain("EMAIL_GATEWAY_EVENT_TOKEN=dashboard-event-token");
      expect(apiEnv).toContain("EMAIL_GATEWAY_DASHBOARD_TOKEN=scoped-reader-token");
      expect(apiEnv).toContain("EMAIL_GATEWAY_API_BASE_URL=http://127.0.0.1:23972");
      expect(apiEnv).toContain("PERSONAL_DASHBOARD_API_TOKEN=dashboard-api-token");
      expect(apiEnv).not.toContain("EMAIL_GATEWAY_ADMIN_TOKEN=outer-admin-token");
      expect(apiEnv).not.toContain("EMAIL_GATEWAY_DASHBOARD_EVENT_TOKEN=outer-event-token");
      expect(apiEnv).not.toContain("GOOGLE_CLIENT_SECRET=outer-google-secret");
      expect(apiEnv).not.toContain("GMAIL_TEST_SECRET=outer-gmail-secret");

      expect(webEnv).not.toContain("EMAIL_GATEWAY_EVENT_TOKEN=dashboard-event-token");
      expect(webEnv).not.toContain("EMAIL_GATEWAY_DASHBOARD_TOKEN=scoped-reader-token");
      expect(webEnv).not.toContain("EMAIL_GATEWAY_API_BASE_URL=http://127.0.0.1:23972");
      expect(webEnv).not.toContain("PERSONAL_DASHBOARD_API_TOKEN=dashboard-api-token");
      expect(webEnv).not.toContain("GOOGLE_CLIENT_SECRET=outer-google-secret");
      expect(webEnv).not.toContain("GMAIL_TEST_SECRET=outer-gmail-secret");

      expect(gatewayEnv).toContain(`EMAIL_GATEWAY_ENV_FILE=${gatewayEnvFile}`);
      expect(gatewayEnv).toContain("EMAIL_GATEWAY_ENABLED=true");
      expect(gatewayEnv).toContain("EMAIL_GATEWAY_PORT=23972");
      expect(gatewayEnv).toContain("PERSONAL_DASHBOARD_API_BASE_URL=http://127.0.0.1:23970");
      expect(gatewayEnv).not.toContain("EMAIL_GATEWAY_EVENT_TOKEN=dashboard-event-token");
      expect(gatewayEnv).not.toContain("EMAIL_GATEWAY_DASHBOARD_TOKEN=scoped-reader-token");
      expect(gatewayEnv).not.toContain("EMAIL_GATEWAY_ADMIN_TOKEN=outer-admin-token");
      expect(gatewayEnv).not.toContain("GOOGLE_CLIENT_SECRET=outer-google-secret");
      expect(gatewayEnv).not.toContain("GMAIL_TEST_SECRET=outer-gmail-secret");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
