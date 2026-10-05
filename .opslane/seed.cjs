// Seeds a fresh Infisical instance through its own HTTP API.
//
// Infisical makes the first account a server admin, so the seed creates a separate instance admin,
// then invites the account the verifier uses as an org admin (a normal, non-server-admin user).
// With SMTP unset, the invite API returns the invite link directly, so no mail server is needed.
const { spawn } = require("node:child_process");

const BASE = "http://127.0.0.1:" + (process.env.PORT || "8080");
const PASSWORD = "OpslaneVerify123!";
const INSTANCE_ADMIN = "instance-admin@verify.opslane.com";
const USER_EMAIL = "admin@verify.opslane.com";
const ORG_NAME = "Opslane Org";
const PROJECT_NAME = "Opslane Project";
const UA = "opslane-seed/1.0";

const log = (...a) => console.error("[seed]", ...a);

async function api(method, path, { body, token, cookie } = {}) {
  const headers = { "user-agent": UA };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return { json, res };
}

function jidCookie(res) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("jid="));
  return raw ? raw.split(";")[0] : undefined;
}

async function waitForServer(child) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(BASE + "/api/status");
      if (r.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("server did not become ready in time");
}

async function login(email) {
  const { json, res } = await api("POST", "/api/v3/auth/login", { body: { email, password: PASSWORD } });
  return { token: json.accessToken, cookie: jidCookie(res) };
}

async function loginToOrg(email, orgId) {
  const first = await login(email);
  const { json } = await api("POST", "/api/v3/auth/select-organization", {
    body: { organizationId: orgId },
    token: first.token,
    cookie: first.cookie
  });
  return json.token;
}

async function seed() {
  const { json: cfg } = await api("GET", "/api/v1/admin/config");
  if (cfg.config.initialized) {
    log("instance already initialized; nothing to do");
    return;
  }

  const { json: signup } = await api("POST", "/api/v1/admin/signup", {
    body: { email: INSTANCE_ADMIN, password: PASSWORD, firstName: "Instance", lastName: "Admin", organizationName: ORG_NAME }
  });
  const orgId = signup.organization.id;
  log("instance admin created, org", orgId);

  const adminToken = await loginToOrg(INSTANCE_ADMIN, orgId);

  const { json: invite } = await api("POST", "/api/v1/invite-org/signup", {
    token: adminToken,
    body: { inviteeEmails: [USER_EMAIL], organizationId: orgId, organizationRoleSlug: "admin" }
  });
  const link = invite.completeInviteLinks?.find((l) => l.email === USER_EMAIL)?.link;
  if (!link) throw new Error(`invite returned no link (is SMTP configured?): ${JSON.stringify(invite)}`);
  const code = new URL(link).searchParams.get("token");

  const { json: verified } = await api("POST", "/api/v1/invite-org/verify", {
    body: { email: USER_EMAIL, organizationId: orgId, code }
  });
  await api("POST", "/api/v3/signup/complete-account", {
    token: verified.token,
    body: { type: "email", email: USER_EMAIL, firstName: "Opslane", lastName: "Admin", password: PASSWORD }
  });
  log("user created", USER_EMAIL);

  const userToken = await loginToOrg(USER_EMAIL, orgId);
  const { json: created } = await api("POST", "/api/v1/projects", {
    token: userToken,
    body: { projectName: PROJECT_NAME, type: "secret-manager" }
  });
  const projectId = created.project.id;
  log("project created", projectId);

  for (const [key, value] of [
    ["DATABASE_URL", "postgres://demo:demo@db.verify.opslane.com:5432/demo"],
    ["API_KEY", "demo-api-key-not-a-real-secret"],
    ["FEATURE_FLAG_NEW_UI", "true"]
  ]) {
    await api("POST", `/api/v4/secrets/${key}`, {
      token: userToken,
      body: { projectId, environment: "dev", secretPath: "/", secretValue: value }
    });
  }
  log("secrets created in dev");
  log(`SEEDED org=${orgId} project=${projectId}`);
}

async function main() {
  const child = spawn("node", ["--enable-source-maps", "dist/main.mjs"], {
    cwd: "/backend",
    env: process.env,
    stdio: ["ignore", "ignore", "inherit"]
  });
  let failed = false;
  try {
    await waitForServer(child);
    await seed();
  } catch (err) {
    failed = true;
    log("FAILED:", err.message);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => {
      if (child.exitCode !== null) return r();
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 15_000);
      child.on("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
  process.exit(failed ? 1 : 0);
}

main();
