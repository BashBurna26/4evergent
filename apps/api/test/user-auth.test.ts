import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { AddressInfo } from "node:net";
import type { Signer } from "@4evergent/stellar";
import { createApiServer } from "../src/index.js";
import { createAuthModule } from "../src/auth.js";
import { DevAuthProvider, ProductionApiKeyAuthProvider } from "@4evergent/shared";

class MockSigner implements Signer {
  getAccountId(): string { return "GMOCKSIGNER000000000000000000000000000000000000000000000MOCK"; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

interface TestOpts {
  /** Bearer fallback provider. Default: null (no fallback → strict). */
  fallback?: any;
  dbPath?: string;
  config?: Parameters<typeof createAuthModule>[0]["config"];
}

async function createAuthTestServer(opts: TestOpts = {}) {
  const fallbackProvider =
    opts.fallback ?? null;
  const authModule = createAuthModule({
    dbPath: opts.dbPath,
    fallbackProvider,
    config: opts.config ?? {},
  });
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner(),
    authProvider: fallbackProvider ?? undefined,
    authModule,
  });
  await server.listen(0);
  const addr = server.server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, authModule };
}

/** Extract the session cookie value from a Set-Cookie header. */
function cookieOf(res: Response): string | null {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const m = c.match(/^four_eg_session=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

async function j(baseUrl: string, path: string, init: RequestInit = {}, cookie?: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (cookie) headers["Cookie"] = `four_eg_session=${cookie}`;
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = res.status !== 204 ? await res.json().catch(() => null) : null;
  return { status: res.status, body, res };
}

const XRW = { "X-Requested-With": "4evergent" };

test("session retention deletes expired rows and preserves live sessions", async () => {
  const { server, baseUrl, authModule } = await createAuthTestServer({ config: { sessionTtlSeconds: 3600 } });
  try {
    const reg = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "retention@example.com", password: "password123" }),
    });
    const cookie = cookieOf(reg.res)!;
    const req = { headers: { cookie: `four_eg_session=${cookie}` } };
    assert.ok(authModule.sessionFor(req));
    assert.equal(authModule.sweepExpiredSessions(Date.now()), 0);
    assert.ok(authModule.sessionFor(req), "live session survives cleanup");

    assert.equal(authModule.sweepExpiredSessions(Date.now() + 2 * 60 * 60_000), 1);
    assert.equal(authModule.sessionFor(req), null, "expired session was removed");
  } finally {
    await server.close();
  }
});

/* ================================ email ================================ */

test("email: register sets HttpOnly SameSite cookie, /auth/me returns the subject", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const reg = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    assert.equal(reg.status, 201);
    const cookie = cookieOf(reg.res);
    assert.ok(cookie && /^[0-9a-f]{64}$/.test(cookie!), "session cookie issued");
    const setc = (reg.res.headers.getSetCookie?.() ?? [])[0] ?? "";
    assert.match(setc, /HttpOnly/);
    assert.match(setc, /SameSite=lax/i);
    assert.match(setc, /Path=\//);
    assert.match(setc, /Max-Age=\d+/);

    const me = await j(baseUrl, "/auth/me", {}, cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.subject, "email:a@b.com");
    assert.ok(me.body.ownerId, "ownerId present");
  } finally {
    await server.close();
  }
});

test("email: login with wrong password → 401 invalid_credentials (no enumeration)", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    const bad = await j(baseUrl, "/auth/login/email", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "wrongpassword" }),
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, "invalid_credentials");

    const unknown = await j(baseUrl, "/auth/login/email", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "zz@zz.com", password: "whatever123" }),
    });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, bad.body, "identical error shape — no user enumeration");
  } finally {
    await server.close();
  }
});

test("email: session cookie authenticates protected API WITHOUT any Bearer key", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const reg = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    const cookie = cookieOf(reg.res)!;

    const list = await j(baseUrl, "/agents", {}, cookie);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.agents));

    const create = await j(baseUrl, "/agents", {
      method: "POST",
      headers: { ...XRW, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Authed Agent" }),
    }, cookie);
    assert.equal(create.status, 201, "session + XRW may create agents");
    assert.equal(create.body.agent.displayName, "Authed Agent");
  } finally {
    await server.close();
  }
});

test("email: unauthenticated protected endpoint → 401", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const res = await j(baseUrl, "/agents");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "unauthorized");
  } finally {
    await server.close();
  }
});

test("email: logout invalidates the server-side session", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const reg = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    const cookie = cookieOf(reg.res)!;
    assert.equal((await j(baseUrl, "/agents", {}, cookie)).status, 200);

    const out = await j(baseUrl, "/auth/logout", { method: "POST", headers: XRW }, cookie);
    assert.equal(out.status, 204);
    const cleared = (out.res.headers.getSetCookie?.() ?? [])[0] ?? "";
    assert.match(cleared, /Max-Age=0/);

    // old cookie no longer resolves — server-side session is gone
    assert.equal((await j(baseUrl, "/agents", {}, cookie)).status, 401);
    assert.equal((await j(baseUrl, "/auth/me", {}, cookie)).status, 401);
  } finally {
    await server.close();
  }
});

test("email: invalid cookie format is ignored (no store lookup, no crash)", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const res = await fetch(`${baseUrl}/agents`, {
      headers: { Cookie: "four_eg_session=not-a-valid-token!!" },
    });
    assert.equal(res.status, 401);
  } finally {
    await server.close();
  }
});

/* ================================ csrf ================================ */

test("csrf: cookie session + state-changing request WITHOUT X-Requested-With → 403", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const reg = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    const cookie = cookieOf(reg.res)!;
    const forged = await fetch(`${baseUrl}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `four_eg_session=${cookie}` },
      body: JSON.stringify({ displayName: "CSRF" }),
    });
    assert.equal(forged.status, 403);
    const body = await forged.json();
    assert.equal(body.error, "csrf_failed");

    // read-only with cookie but no header is fine (GET is safe)
    const get = await fetch(`${baseUrl}/agents`, {
      headers: { Cookie: `four_eg_session=${cookie}` },
    });
    assert.equal(get.status, 200);
  } finally {
    await server.close();
  }
});

/* =============================== stellar =============================== */

test("stellar: challenge → real signature → session (ownership proven, replay rejected)", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const kp = Keypair.random();
    const ch = await j(baseUrl, "/auth/stellar/challenge", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ publicKey: kp.publicKey() }),
    });
    assert.equal(ch.status, 200);
    assert.match(ch.body.message, /4evergent authentication challenge/);
    assert.ok(ch.body.message.includes(kp.publicKey()), "challenge binds the account");
    assert.ok(ch.body.challengeId);

    const signature = kp.sign(Buffer.from(ch.body.message, "utf8")).toString("base64");
    const verify = await j(baseUrl, "/auth/stellar/verify", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ publicKey: kp.publicKey(), challengeId: ch.body.challengeId, signature }),
    });
    assert.equal(verify.status, 200);
    const cookie = cookieOf(verify.res)!;
    assert.ok(cookie);

    // session works on protected API, subject = the wallet account
    const me = await j(baseUrl, "/auth/me", {}, cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.method, "stellar");
    assert.equal(me.body.subject, `stellar:${kp.publicKey()}`);

    // replay the same challenge → rejected (single-use)
    const replay = await j(baseUrl, "/auth/stellar/verify", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ publicKey: kp.publicKey(), challengeId: ch.body.challengeId, signature }),
    });
    assert.equal(replay.status, 401);
  } finally {
    await server.close();
  }
});

test("stellar: SEP-53 signMessage signature (sha256 prefix) is accepted", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const kp = Keypair.random();
    const ch = await j(baseUrl, "/auth/stellar/challenge", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ publicKey: kp.publicKey() }),
    });
    // Freighter SEP-53: js-stellar-base signs sha256("Stellar Signed Message:\n" + message)
    const digest = createHash("sha256")
      .update("Stellar Signed Message:\n" + ch.body.message, "utf8")
      .digest();
    const sig = kp.sign(digest).toString("base64");
    const verify = await j(baseUrl, "/auth/stellar/verify", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ publicKey: kp.publicKey(), challengeId: ch.body.challengeId, signature: sig }),
    });
    assert.equal(verify.status, 200, "SEP-53 signature must be accepted");
    const cookie = cookieOf(verify.res)!;
    const me = await j(baseUrl, "/auth/me", {}, cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.method, "stellar");
  } finally {
    await server.close();
  }
});

test("stellar: signature over a wrong SEP-53-style prefix is rejected", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const kp = Keypair.random();
    const ch = await j(baseUrl, "/auth/stellar/challenge", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ publicKey: kp.publicKey() }),
    });
    // wrong prefix — matches neither Keypair.sign(msg), SEP-53, nor raw-ed25519
    const bogus = "Wrong Signed Message:\n" + ch.body.message;
    const bogusSig = kp.sign(Buffer.from(bogus, "utf8")).toString("base64");
    const verify = await j(baseUrl, "/auth/stellar/verify", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ publicKey: kp.publicKey(), challengeId: ch.body.challengeId, signature: bogusSig }),
    });
    assert.equal(verify.status, 401, "wrong-prefix signature must be rejected");
  } finally {
    await server.close();
  }
});

test("stellar: signature from a DIFFERENT key is rejected; public key alone is not auth", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const claimed = Keypair.random();
    const attacker = Keypair.random();
    const ch = await j(baseUrl, "/auth/stellar/challenge", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ publicKey: claimed.publicKey() }),
    });
    const badSig = attacker.sign(Buffer.from(ch.body.message, "utf8")).toString("base64");
    const verify = await j(baseUrl, "/auth/stellar/verify", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ publicKey: claimed.publicKey(), challengeId: ch.body.challengeId, signature: badSig }),
    });
    assert.equal(verify.status, 401);

    // presenting only a public key without any verify → no session at all
    const agents = await j(baseUrl, "/agents");
    assert.equal(agents.status, 401);
  } finally {
    await server.close();
  }
});

test("stellar: invalid public key → 400", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const res = await j(baseUrl, "/auth/stellar/challenge", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ publicKey: "NOT-A-KEY" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

/* ================================ google =============================== */

test("google: unconfigured → /auth/google/start 503 with exact required env", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const res = await j(baseUrl, "/auth/google/start");
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "google_oauth_not_configured");
    assert.deepEqual(res.body.requiredEnv, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
  } finally {
    await server.close();
  }
});

test("google: configured → 302 to accounts.google.com with state+nonce, no secret in URL", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    config: {
      webOrigin: "http://localhost:5173",
      google: { clientId: "test-client.apps.googleusercontent.com", clientSecret: "supersecret" },
    },
  });
  try {
    const res = await fetch(`${baseUrl}/auth/google/start`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") ?? "";
    assert.match(loc, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const u = new URL(loc);
    assert.equal(u.searchParams.get("client_id"), "test-client.apps.googleusercontent.com");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("scope"), "openid email");
    assert.ok(u.searchParams.get("state"), "state present");
    assert.ok(u.searchParams.get("nonce"), "nonce present");
    assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:5173/auth/google/callback");
    assert.ok(!loc.includes("supersecret"), "client secret NEVER in URL");

    // callback with unknown state must not authenticate
    const cb = await fetch(`${baseUrl}/auth/google/callback?code=x&state=bogus`, { redirect: "manual" });
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get("location") ?? "", /auth_error=google_failed$/);
    assert.ok(!(cb.headers.getSetCookie?.() ?? []).some((c) => c.includes("four_eg_session=") && !/Max-Age=0/.test(c)),
      "no session cookie minted for forged callback");
  } finally {
    await server.close();
  }
});

/* ============================ config + fallback ======================== */

test("auth/config advertises capabilities and leaks nothing", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const res = await j(baseUrl, "/auth/config");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { email: true, google: false, stellar: true, registration: true });
  } finally {
    await server.close();
  }
});

test("API-KEY bearer fallback stays functional for machine clients (CLI)", async () => {
  const provider = new ProductionApiKeyAuthProvider({
    apiKeys: { "machine-key": { ownerId: "svc-owner", subject: "key:svc" } },
  });
  const { server, baseUrl } = await createAuthTestServer({ fallback: provider });
  try {
    const withKey = await fetch(`${baseUrl}/agents`, {
      headers: { Authorization: "Bearer machine-key" },
    });
    assert.equal(withKey.status, 200, "bearer machine client still works");
    const noKey = await fetch(`${baseUrl}/agents`);
    assert.equal(noKey.status, 401);
  } finally {
    await server.close();
  }
});

test("dev fallback: DevAuthProvider keeps loopback ergonomics (no cookie, bearer optional)", async () => {
  const dev = new DevAuthProvider({ defaultOwnerId: "operator" });
  const { server, baseUrl } = await createAuthTestServer({ fallback: dev });
  try {
    const res = await fetch(`${baseUrl}/agents`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

/* ============================ registration off ========================= */

test("registration disabled → 403 and no user created", async () => {
  const { server, baseUrl } = await createAuthTestServer({
    config: { allowRegistration: false },
  });
  try {
    const res = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

/* ========================= validation edge cases ======================== */

test("weak password and invalid email are rejected", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const weak = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "short" }),
    });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error, "weak_password");

    const badEmail = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "not-an-email", password: "longenough" }),
    });
    assert.equal(badEmail.status, 400);

    const dupe = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    assert.equal(dupe.status, 201);
    const dupe2 = await j(baseUrl, "/auth/register", {
      method: "POST",
      headers: XRW,
      body: JSON.stringify({ email: "A@B.com", password: "password456" }),
    });
    assert.equal(dupe2.status, 409, "email normalization + uniqueness");
  } finally {
    await server.close();
  }
});

test("owner isolation: two email accounts see only their own agents", async () => {
  const { server, baseUrl } = await createAuthTestServer();
  try {
    const r1 = await j(baseUrl, "/auth/register", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ email: "one@x.com", password: "password11" }),
    });
    const r2 = await j(baseUrl, "/auth/register", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ email: "two@x.com", password: "password22" }),
    });
    const c1 = cookieOf(r1.res)!, c2 = cookieOf(r2.res)!;
    await j(baseUrl, "/agents", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ displayName: "Agent One" }),
    }, c1);
    const l2 = await j(baseUrl, "/agents", {}, c2);
    assert.equal(l2.body.agents.length, 0, "user two must not see user one's agents");
  } finally {
    await server.close();
  }
});

/* ========================= sqlite persistence =========================== */

test("sqlite mode: sessions persist to disk; users round-trip", async () => {
  const path = `/tmp/authtest-${process.pid}-${Date.now()}.db`;
  const { server, baseUrl } = await createAuthTestServer({ dbPath: path });
  try {
    const reg = await j(baseUrl, "/auth/register", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ email: "db@x.com", password: "password123" }),
    });
    assert.equal(reg.status, 201);
    const cookie = cookieOf(reg.res)!;
    const me = await j(baseUrl, "/auth/me", {}, cookie);
    assert.equal(me.status, 200);
    const list = await j(baseUrl, "/agents", {}, cookie);
    assert.equal(list.status, 200);
  } finally {
    await server.close();
    const { rmSync } = await import("node:fs");
    rmSync(path, { force: true });
  }
});

test("SQLite session retention removes expired rows by the indexed expiry", async () => {
  const path = `/tmp/authtest-retention-${process.pid}-${Date.now()}.db`;
  const { server, baseUrl, authModule } = await createAuthTestServer({ dbPath: path });
  const db = new DatabaseSync(path);
  try {
    const reg = await j(baseUrl, "/auth/register", {
      method: "POST", headers: XRW,
      body: JSON.stringify({ email: "sqlite-retention@x.com", password: "password123" }),
    });
    assert.equal(reg.status, 201);
    const cookie = cookieOf(reg.res)!;
    const session = authModule.sessionFor({ headers: { cookie: `four_eg_session=${cookie}` } });
    assert.ok(session);
    db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1, session!.token);

    assert.equal(authModule.sweepExpiredSessions(Date.now()), 1);
    assert.equal(authModule.sweepExpiredSessions(Date.now()), 0);
    const indexes = db.prepare("PRAGMA index_list(auth_sessions)").all() as { name: string }[];
    assert.ok(indexes.some((index) => index.name === "idx_auth_sessions_exp"));
  } finally {
    db.close();
    await server.close();
    const { rmSync } = await import("node:fs");
    rmSync(path, { force: true });
  }
});
