import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function safeRunId(runId) {
  return String(runId ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function runEvidenceRoot(root, env = process.env) {
  const configured = String(env.CODING_AGENT_RUN_EVIDENCE_DIR ?? "").trim();
  return configured || join(root, ".data", "runs");
}

export function runEvidenceDir(root, runId, env = process.env) {
  return join(runEvidenceRoot(root, env), safeRunId(runId));
}

export async function appendRunEvidenceEvent(root, runId, event, metadata = {}) {
  const dir = runEvidenceDir(root, runId, metadata.env);
  await mkdir(dir, { recursive: true });
  const record = {
    ts: metadata.ts ?? new Date().toISOString(),
    runId,
    taskId: metadata.taskId,
    event
  };
  await appendFile(join(dir, "events.ndjson"), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

export async function writeRunEvidenceArtifact(root, runId, name, content, metadata = {}) {
  const dir = runEvidenceDir(root, runId, metadata.env);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

export async function readRunEvidenceEvents(root, runId, env = process.env) {
  const text = await readFile(join(runEvidenceDir(root, runId, env), "events.ndjson"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function captureRunGitDiff(root, runId, worktreeDir, options = {}) {
  if (!worktreeDir) {
    return { captured: false, reason: "missing_worktree_dir" };
  }
  try {
    const command = options.command ?? execFileAsync;
    const commandOptions = {
      cwd: worktreeDir,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024
    };
    const chunks = [];
    if (options.baseRef) {
      const { stdout } = await command(
        "git",
        ["diff", "--no-ext-diff", "--binary", `${options.baseRef}...HEAD`],
        commandOptions
      );
      chunks.push(stdout);
    }
    const { stdout: trackedDiff } = await command(
      "git",
      ["diff", "--no-ext-diff", "--binary", "HEAD"],
      commandOptions
    );
    chunks.push(trackedDiff);

    const { stdout: untrackedFiles } = await command(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      commandOptions
    );
    for (const file of untrackedFiles.split("\n").filter(Boolean)) {
      try {
        const { stdout } = await command(
          "git",
          ["diff", "--no-index", "--binary", "--", "/dev/null", file],
          commandOptions
        );
        chunks.push(stdout);
      } catch (error) {
        if (error?.code !== 1) {
          throw error;
        }
        chunks.push(error.stdout ?? "");
      }
    }

    const content = chunks.filter(Boolean).join("\n");
    const path = await writeRunEvidenceArtifact(root, runId, "final.diff", content, options);
    return { captured: true, path, bytes: Buffer.byteLength(content) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeRunEvidenceArtifact(root, runId, "final-diff-error.txt", `${message}\n`, options);
    return { captured: false, reason: "git_diff_failed", error: message };
  }
}

export async function deleteRunEvidence(root, runId, env = process.env) {
  await rm(runEvidenceDir(root, runId, env), { recursive: true, force: true });
}
