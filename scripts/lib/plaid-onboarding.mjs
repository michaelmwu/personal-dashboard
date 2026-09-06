import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken
} from "../../packages/integrations/plaid.mjs";
import { CredentialError } from "../../packages/integrations/onepassword.mjs";
import { provisionPlaidCredential } from "./plaid-provisioning.mjs";

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect a bank · MooHQ</title>
<style>body{max-width:560px;margin:64px auto;padding:24px;font:16px system-ui;background:#f5f4f1;color:#23211f}button{padding:12px 18px;font:inherit}p{line-height:1.6}</style>
<h1>Connect a bank</h1><p>Connect through Plaid. MooHQ will save the connection credential in 1Password.</p><button id="connect">Connect a bank</button><button id="retry" hidden>Retry saving connection</button><p id="status" role="status"></p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script><script>
const session = location.hash.slice(1); history.replaceState(null, '', '/');
const button = document.getElementById('connect'), retry = document.getElementById('retry'), status = document.getElementById('status'); let pending, connected = false;
async function post(path, body = {}) { const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json','X-Onboarding-Token':session},body:JSON.stringify(body)}); const result = await response.json(); if (!response.ok) throw new Error(result.message || 'Setup failed. Try again.'); return result; }
async function save() { retry.hidden=true; status.textContent='Saving in 1Password…'; try { await post('/exchange',pending); pending=null; status.textContent='Bank connected. Close this tab and restart the dashboard services to sync.'; } catch(error) {status.textContent=error.message; retry.hidden=false;} }
button.onclick=async()=>{button.disabled=true; try {const result=await post('/link-token'); if (!window.Plaid) throw new Error('Plaid did not load. Check your connection and retry.'); Plaid.create({token:result.linkToken,onSuccess:(publicToken,metadata)=>{connected=true;pending={publicToken,institutionName:metadata.institution?.name};save();},onExit:()=>{if(!connected)button.disabled=false;}}).open();} catch(error){status.textContent=error.message;button.disabled=false;}};
retry.onclick=save;
</script></html>`;

export function createPlaidOnboardingServer({
  filePath,
  env = process.env,
  link = createPlaidLinkToken,
  exchange = exchangePlaidPublicToken,
  provision = provisionPlaidCredential,
  onComplete = () => {},
  ttlMs = 15 * 60 * 1000
} = {}) {
  const nonce = randomBytes(32).toString("hex");
  let pending;
  let busy = false;
  let complete = false;
  const expiresAt = Date.now() + ttlMs;
  const server = http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const send = (code, body) => {
      response.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(JSON.stringify(body));
    };
    if (request.headers.host !== origin.slice(7) || Date.now() > expiresAt)
      return send(403, { message: "This setup session is unavailable." });
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY"
      });
      response.end(page);
      return;
    }
    const presented = Buffer.from(String(request.headers["x-onboarding-token"] || ""));
    if (
      request.method !== "POST" ||
      request.headers.origin !== origin ||
      request.headers["content-type"] !== "application/json" ||
      presented.length !== nonce.length ||
      !timingSafeEqual(presented, Buffer.from(nonce))
    ) {
      return send(403, { message: "Open the setup URL printed by the owner tool." });
    }
    if (!["/link-token", "/exchange"].includes(request.url))
      return send(404, { message: "Not found." });
    if (complete) return send(409, { message: "This setup session is complete." });
    if (busy) return send(409, { message: "A connection is already being saved. Wait and retry." });
    busy = true;
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 8192) throw new Error("too_large");
      }
      const payload = JSON.parse(body || "{}");
      if (request.url === "/link-token") {
        if (pending) return send(409, { message: "Retry saving the current connection first." });
        const result = await link({ userId: "personal-dashboard-owner" });
        if (!result.created)
          return send(503, {
            message: "Couldn’t start Plaid. Check the owner tool’s Plaid configuration."
          });
        return send(200, { linkToken: result.linkToken });
      }
      if (!pending) {
        if (
          typeof payload.publicToken !== "string" ||
          !payload.publicToken ||
          payload.publicToken.length > 4096
        )
          return send(400, { message: "Plaid did not provide a connection token." });
        const result = await exchange(payload.publicToken);
        if (!result.exchanged)
          return send(502, {
            message: "Plaid couldn’t finish connecting this bank. Restart setup and try again."
          });
        pending = {
          itemId: result.itemId,
          accessToken: result.accessToken,
          institutionName:
            typeof payload.institutionName === "string"
              ? payload.institutionName.slice(0, 200)
              : undefined
        };
      }
      await provision({ filePath, ...pending }, { env });
      pending = undefined;
      complete = true;
      send(200, { accepted: true });
      onComplete();
    } catch (error) {
      send(503, {
        message:
          error instanceof CredentialError
            ? error.message
            : "Couldn’t save this connection. Check the owner tool and retry saving."
      });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, nonce };
}
