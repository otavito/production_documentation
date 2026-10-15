const { getIdentityFromPrincipal, resolveUser } = require("../shared/auth");

// Called by the Static Web App at every sign-in (auth.rolesSource in
// staticwebapp.config.json). The body is the signed-in user. The returned roles
// are added to the session, so route rules and /.auth/me can use them.
// Static Web App roles are not hierarchical, so higher roles include the lower ones.
const IMPLIED_ROLES = {
  admin: ["admin", "editor", "viewer"],
  editor: ["editor", "viewer"],
  viewer: ["viewer"]
};

module.exports = async function (context, req) {
  try {
    const user = await resolveUser(getIdentityFromPrincipal(req.body));

    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: { roles: IMPLIED_ROLES[user.role] || [] }
    };
  } catch (error) {
    context.log.error("Failed to load roles:", error);

    // No extra roles on failure: the user stays signed in as "authenticated" only.
    context.res = { status: 200, body: { roles: [] } };
  }
};
