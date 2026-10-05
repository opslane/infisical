// Signs in as the seeded user the way the web app does and prints a Playwright storageState.
//
// The SPA keeps its access token in memory and restores it on load from the httpOnly `jid` refresh
// cookie (POST /api/v1/auth/token). The `jid` from /login has no org, which would land on the
// org picker, so this also selects the org and returns the org-scoped `jid` it issues.
const PORT = process.env.PORT || "8080";
const BASE = `http://localhost:${PORT}`;
const EMAIL = "admin@verify.opslane.com";
const PASSWORD = "OpslaneVerify123!";
const UA = "opslane-session/1.0";

async function api(method, path, { body, token, cookie } = {}) {
  const headers = { "user-agent": UA };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return { json: JSON.parse(text), res };
}

const jid = (res) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("jid="));
  if (!raw) throw new Error("no jid cookie in response");
  return raw.split(";")[0].slice("jid=".length);
};

async function main() {
  const login = await api("POST", "/api/v3/auth/login", { body: { email: EMAIL, password: PASSWORD } });
  const accessToken = login.json.accessToken;

  const { json: orgs } = await api("GET", "/api/v1/organization", { token: accessToken });
  const org = orgs.organizations.find((o) => o.name === "Opslane Org") || orgs.organizations[0];
  if (!org) throw new Error("seeded user has no organization");

  const selected = await api("POST", "/api/v3/auth/select-organization", {
    body: { organizationId: org.id },
    token: accessToken,
    cookie: `jid=${jid(login.res)}`
  });
  if (selected.json.isMfaEnabled) throw new Error("MFA is enabled for the seeded user");

  const state = {
    cookies: [
      {
        name: "jid",
        value: jid(selected.res),
        domain: "localhost",
        path: "/api",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Strict"
      }
    ],
    origins: [{ origin: BASE, localStorage: [{ name: "orgData.id", value: org.id }] }],
    // Infisical's API takes the org-scoped access token, not the cookie: Opslane sends it on signed-in API calls.
    headers: { authorization: `Bearer ${selected.json.token}` }
  };
  process.stdout.write(JSON.stringify(state));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
