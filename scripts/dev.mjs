import { spawn } from "node:child_process";

const commands = [
  ["api", "bun", ["apps/api/server.mjs"]],
  ["web", "bun", ["apps/web/server.mjs"]]
];

const children = new Set();
let shuttingDown = false;

function start(name, command, args) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  children.add(child);

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`[${name}] exited with ${signal ?? code}`);
      shutdown(code ?? 1);
    }
  });
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(code);
  }, 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));

for (const command of commands) {
  start(...command);
}
