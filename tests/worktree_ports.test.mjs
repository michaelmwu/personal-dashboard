import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

function worktreePortsEnv(env) {
  const result = spawnSync("python3", ["scripts/worktree_ports.py", "env"], {
    env: { ...process.env, ...env },
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }

  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.split("=", 2))
  );
}

describe("worktree port allocation", () => {
  test("skips browser-restricted Conductor API base ports", () => {
    expect(worktreePortsEnv({ CONDUCTOR_PORT: "6000" })).toMatchObject({
      API_PORT: "6001",
      WEB_PORT: "6002",
      PERSONAL_DASHBOARD_API_BASE_URL: "http://127.0.0.1:6001",
      PERSONAL_DASHBOARD_WEB_BASE_URL: "http://127.0.0.1:6002"
    });

    expect(worktreePortsEnv({ CONDUCTOR_PORT: "10080" })).toMatchObject({
      API_PORT: "10081",
      WEB_PORT: "10082",
      PERSONAL_DASHBOARD_API_BASE_URL: "http://127.0.0.1:10081",
      PERSONAL_DASHBOARD_WEB_BASE_URL: "http://127.0.0.1:10082"
    });
  });
});
