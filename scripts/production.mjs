import { spawn } from "node:child_process";

const workerEnabled = process.env.PERSONAL_DASHBOARD_WORKER_ENABLED !== "false";
const services = [
  { name: "api", args: ["apps/api/server.mjs"], essential: true },
  { name: "web", args: ["apps/web/server.mjs"], essential: true },
  ...(workerEnabled
    ? [{ name: "worker", args: ["scripts/integration-worker.mjs"], essential: false }]
    : [])
];

const children = new Map();
const restartTimers = new Set();
let shuttingDown = false;

function start(service) {
  const child = spawn("bun", service.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  children.set(service.name, child);

  child.stdout.on("data", (chunk) => process.stdout.write(`[${service.name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${service.name}] ${chunk}`));
  child.on("error", (error) => {
    console.error(`[${service.name}] failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (children.get(service.name) === child) {
      children.delete(service.name);
    }
    if (shuttingDown) {
      return;
    }
    if (service.essential) {
      console.error(`[${service.name}] exited with ${signal ?? code}; stopping dashboard`);
      shutdown(code ?? 1);
      return;
    }
    console.error(`[${service.name}] exited with ${signal ?? code}; restarting in 5 seconds`);
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      if (!shuttingDown) {
        start(service);
      }
    }, 5_000);
    restartTimers.add(timer);
  });
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const timer of restartTimers) {
    clearTimeout(timer);
  }
  restartTimers.clear();
  for (const child of children.values()) {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children.values()) {
      child.kill("SIGKILL");
    }
    process.exit(code);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

for (const service of services) {
  start(service);
}
