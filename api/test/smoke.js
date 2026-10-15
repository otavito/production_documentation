// Local smoke test for me / accessUsers / accessUser against the real AuthorizedUsers table.
// Runs the function handlers directly with a simulated signed-in user, so it works
// before App Service Authentication is enabled. Never set ALLOW_UNVERIFIED_PRINCIPAL in Azure.
//
// Usage (from the api folder):
//   $env:AUTHORIZED_USERS_CONNECTION_STRING = "<connection string>"
//   node test/smoke.js you@company.com            read-only checks
//   node test/smoke.js you@company.com --write    also creates, updates and removes a test user

process.env.ALLOW_UNVERIFIED_PRINCIPAL = "true";
process.env.DEFAULT_ROLE = process.env.DEFAULT_ROLE || "viewer";
process.env.ROLE_SOURCE = "table";

const me = require("../me/index");
const accessUsers = require("../accessUsers/index");
const accessUser = require("../accessUser/index");
const getRoles = require("../GetRoles/index");
const { PARTITION_KEY, getAuthorizedUsersTableClient } = require("../shared/auth");

const adminEmail = String(process.argv[2] || "").trim().toLowerCase();
const runWrites = process.argv.includes("--write");
const TEST_EMAIL = "smoke-test-user@example.com";

let failures = 0;

function principalHeader(email) {
  const principal = {
    identityProvider: "aad",
    userId: "smoke-test",
    userDetails: email,
    claims: [{ typ: "name", val: "Smoke Test" }]
  };
  return Buffer.from(JSON.stringify(principal)).toString("base64");
}

async function call(handler, { method = "GET", email, body, params } = {}) {
  const context = { log: Object.assign(() => {}, { error: console.error }) };
  const req = {
    method,
    headers: email ? { "x-ms-client-principal": principalHeader(email) } : {},
    body,
    params: params || {},
    query: {}
  };

  await handler(context, req);
  return context.res;
}

function check(name, res, expectedStatus, extra) {
  const ok = res && res.status === expectedStatus && (!extra || extra(res.body));
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ->  ${res && res.status}`);
  if (!ok) console.log("      body:", JSON.stringify(res && res.body));
}

async function main() {
  if (!adminEmail) {
    console.error("Usage: node test/smoke.js <your-admin-email> [--write]");
    process.exit(1);
  }

  check("me, signed out", await call(me), 200, b => b.authenticated === false);
  check("me, admin", await call(me, { email: adminEmail }), 200,
    b => b.role === "admin" && b.permissions.canManageUsers === true);
  check("me, user without a row gets DEFAULT_ROLE", await call(me, { email: "nobody@example.com" }), 200,
    b => b.role === process.env.DEFAULT_ROLE);

  check("list users, signed out", await call(accessUsers), 401);
  check("list users, viewer", await call(accessUsers, { email: "nobody@example.com" }), 403);
  check("list users, admin", await call(accessUsers, { email: adminEmail }), 200, b => b.total >= 1);
  check("get own row, admin", await call(accessUser, { email: adminEmail, params: { email: adminEmail } }), 200);
  const rolesRes = { status: 0 };
  const rolesContext = { log: Object.assign(() => {}, { error: console.error }) };
  await getRoles(rolesContext, { method: "POST", headers: {}, body: { identityProvider: "aad", userDetails: adminEmail } });
  Object.assign(rolesRes, rolesContext.res);
  check("GetRoles, admin", rolesRes, 200, b => b.roles.includes("admin") && b.roles.includes("editor"));

  check("admin cannot demote self", await call(accessUser, {
    method: "PATCH", email: adminEmail, params: { email: adminEmail }, body: { role: "viewer" }
  }), 400);

  if (runWrites) {
    try {
      check("create test user", await call(accessUsers, {
        method: "POST", email: adminEmail, body: { email: TEST_EMAIL, role: "viewer", displayName: "Smoke Test" }
      }), 201);
      check("reject invalid role", await call(accessUser, {
        method: "PATCH", email: adminEmail, params: { email: TEST_EMAIL }, body: { role: "superuser" }
      }), 400);
      check("promote to editor", await call(accessUser, {
        method: "PATCH", email: adminEmail, params: { email: TEST_EMAIL }, body: { role: "editor" }
      }), 200, b => b.user.role === "editor");
      check("test user sees canEdit", await call(me, { email: TEST_EMAIL }), 200,
        b => b.permissions.canEdit === true && b.permissions.canManageUsers === false);
      check("deactivate test user", await call(accessUser, {
        method: "PATCH", email: adminEmail, params: { email: TEST_EMAIL }, body: { isActive: false }
      }), 200);
      check("deactivated user has no role", await call(me, { email: TEST_EMAIL }), 200,
        b => b.authorized === false && b.role === null);
    } finally {
      await getAuthorizedUsersTableClient().deleteEntity(PARTITION_KEY, TEST_EMAIL).catch(() => {});
      console.log("      (test user removed)");
    }
  }

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
