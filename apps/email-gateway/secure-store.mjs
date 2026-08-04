import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const STORE_VERSION = "email-gateway-encrypted-store.v1";
const STORE_AAD = Buffer.from(STORE_VERSION, "utf8");

function base64url(buffer) {
  return buffer.toString("base64url");
}

function fromBase64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid encrypted gateway store encoding.");
  }
  return Buffer.from(value, "base64url");
}

export function encryptGatewayRecord(record, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Gateway encryption key must be 32 bytes.");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(STORE_AAD);
  const plaintext = Buffer.from(JSON.stringify(record), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: STORE_VERSION,
    iv: base64url(iv),
    ciphertext: base64url(ciphertext),
    tag: base64url(cipher.getAuthTag())
  };
}

export function decryptGatewayRecord(envelope, key) {
  if (!envelope || envelope.version !== STORE_VERSION) {
    throw new Error("Unsupported encrypted gateway store version.");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Gateway encryption key must be 32 bytes.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, fromBase64url(envelope.iv));
  decipher.setAAD(STORE_AAD);
  decipher.setAuthTag(fromBase64url(envelope.tag));
  const plaintext = Buffer.concat([
    decipher.update(fromBase64url(envelope.ciphertext)),
    decipher.final()
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid encrypted gateway store record.");
  }
  return parsed;
}

async function writeOwnerOnly(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export async function readEncryptedGatewayRecord(path, key) {
  try {
    const contents = await readFile(path, "utf8");
    return decryptGatewayRecord(JSON.parse(contents), key);
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeEncryptedGatewayRecord(path, record, key) {
  await writeOwnerOnly(path, `${JSON.stringify(encryptGatewayRecord(record, key), null, 2)}\n`);
}

export async function appendGatewayAudit(path, entry) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await writeFile(path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
    await chmod(path, 0o600);
  } catch (error) {
    // Auditing cannot cause a mail operation to become less safe. Callers still
    // receive the primary result, while the process log can surface this error.
    console.error(
      "Email gateway audit write failed:",
      error instanceof Error ? error.message : error
    );
  }
}
