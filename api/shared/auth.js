const { TableClient } = require("@azure/data-tables");

const PARTITION_KEY = "auth";

// Roles are hierarchical: each role includes every permission of the roles below it.
const ROLE_LEVELS = {
  viewer: 1,
  editor: 2,
  admin: 3
};

// Microsoft Entra ID sign-ins are reported as "aad".
const MICROSOFT_PROVIDERS = new Set(["aad", "azuread", "azure_ad", "microsoft"]);

const EMAIL_CLAIMS = [
  "preferred_username",
  "email",
  "upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn"
];
const NAME_CLAIMS = ["name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];
const OBJECT_ID_CLAIMS = ["oid", "http://schemas.microsoft.com/identity/claims/objectidentifier"];

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function firstNotEmpty(values) {
  for (const value of values) {
    const str = String(value || "").trim();
    if (str) {
      return str;
    }
  }

  return "";
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function isValidRole(role) {
  return hasOwn(ROLE_LEVELS, normalize(role));
}

function hasRole(userRole, requiredRole) {
  const userLevel = ROLE_LEVELS[normalize(userRole)] || 0;
  const requiredLevel = ROLE_LEVELS[normalize(requiredRole)] || Infinity;

  return userLevel >= requiredLevel;
}

function getPermissions(role) {
  return {
    canView: hasRole(role, "viewer"),
    canEdit: hasRole(role, "editor"),
    canManageUsers: hasRole(role, "admin")
  };
}

function getAuthorizedUsersTableClient() {
  const connectionString =
    process.env.AUTHORIZED_USERS_CONNECTION_STRING ||
    process.env.STORAGE_CONNECTION_STRING;
  const tableName = process.env.AUTHORIZED_USERS_TABLE_NAME || "AuthorizedUsers";

  if (!connectionString) {
    throw new Error("AUTHORIZED_USERS_CONNECTION_STRING is not configured.");
  }

  return TableClient.fromConnectionString(connectionString, tableName);
}

// x-ms-client-principal can only be trusted when the platform sets it:
// - as the Static Web App's managed API (only reachable through the Static Web App),
//   flagged by SWA_MANAGED_API=true in the Static Web App's environment variables;
// - or with App Service Authentication enabled on a standalone Function App.
// Never set SWA_MANAGED_API on a standalone Function App: anyone could then
// send a fake header and claim to be an admin.
function isPrincipalHeaderTrusted() {
  return normalize(process.env.SWA_MANAGED_API) === "true" ||
    normalize(process.env.WEBSITE_AUTH_ENABLED) === "true" ||
    normalize(process.env.ALLOW_UNVERIFIED_PRINCIPAL) === "true";
}

function decodeClientPrincipal(headerValue) {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getClaim(principal, types) {
  const claims = Array.isArray(principal && principal.claims) ? principal.claims : [];
  for (const type of types) {
    const match = claims.find(c => normalize(c.typ) === normalize(type));
    if (match && match.val) return String(match.val).trim();
  }
  return "";
}

// Supports both header formats: Static Web Apps (identityProvider, userDetails)
// and App Service Authentication (auth_typ plus x-ms-client-principal-* headers).
function getIdentityFromRequest(req) {
  if (!isPrincipalHeaderTrusted()) {
    return null;
  }

  const headers = req.headers || {};
  return getIdentityFromPrincipal(decodeClientPrincipal(headers["x-ms-client-principal"]), headers);
}

function getIdentityFromPrincipal(principal, headers = {}) {
  if (!principal) {
    return null;
  }

  const provider = firstNotEmpty([
    principal.identityProvider,
    principal.auth_typ,
    headers["x-ms-client-principal-idp"]
  ]);

  if (!MICROSOFT_PROVIDERS.has(normalize(provider))) {
    return null;
  }

  const email = normalize(firstNotEmpty([
    principal.userDetails,
    getClaim(principal, EMAIL_CLAIMS),
    headers["x-ms-client-principal-name"]
  ]));

  if (!email) {
    return null;
  }

  return {
    email,
    name: firstNotEmpty([getClaim(principal, NAME_CLAIMS), email]),
    userId: firstNotEmpty([
      principal.userId,
      getClaim(principal, OBJECT_ID_CLAIMS),
      headers["x-ms-client-principal-id"]
    ]),
    roles: Array.isArray(principal.userRoles) ? principal.userRoles.map(normalize) : []
  };
}

// Where roles come from:
// - "swa":   roles assigned in the Static Web App's Role management (invitations),
//            read from userRoles in the identity header.
// - "table": the AuthorizedUsers table (default; also used by GetRoles).
function getRoleSource() {
  return normalize(process.env.ROLE_SOURCE) === "swa" ? "swa" : "table";
}

function getHighestRole(roles) {
  return (roles || [])
    .filter(isValidRole)
    .sort((a, b) => ROLE_LEVELS[b] - ROLE_LEVELS[a])[0] || "";
}

function getDefaultRole() {
  return isValidRole(process.env.DEFAULT_ROLE) ? normalize(process.env.DEFAULT_ROLE) : "";
}

function normalizeAuthorizedUser(entity) {
  const email = normalize(entity && (entity.rowKey || entity.email));

  return {
    email,
    name: firstNotEmpty([entity && entity.displayName, email]),
    role: normalize(entity && entity.role),
    isActive: String(entity && entity.isActive).toLowerCase() !== "false",
    createdAt: firstNotEmpty([entity && entity.createdAt]),
    createdBy: firstNotEmpty([entity && entity.createdBy]),
    updatedAt: firstNotEmpty([entity && entity.updatedAt, entity && entity.timestamp]),
    updatedBy: firstNotEmpty([entity && entity.updatedBy])
  };
}

async function getAuthorizedUserEntity(client, email) {
  try {
    return await client.getEntity(PARTITION_KEY, normalize(email));
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }

    throw error;
  }
}

async function listAuthorizedUsers(client) {
  const users = [];
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION_KEY}'` }
  });

  for await (const entity of entities) {
    users.push(normalizeAuthorizedUser(entity));
  }

  return users;
}

async function requireAuthorizedUser(req) {
  return resolveUser(getIdentityFromRequest(req));
}

// Resolves the caller's role (see getRoleSource). Signed-in Microsoft users with
// no assigned role get DEFAULT_ROLE (empty = no access). In "table" mode, a row
// with isActive = false always means no access.
async function resolveUser(identity) {
  if (!identity) {
    return {
      authenticated: false,
      authorized: false,
      email: null,
      name: null,
      role: null,
      permissions: getPermissions(null)
    };
  }

  let role = "";
  let name = identity.name;

  if (getRoleSource() === "swa") {
    role = getHighestRole(identity.roles) || getDefaultRole();
  } else {
    const entity = await getAuthorizedUserEntity(getAuthorizedUsersTableClient(), identity.email);
    const stored = entity ? normalizeAuthorizedUser(entity) : null;

    if (stored) {
      role = stored.isActive && isValidRole(stored.role) ? stored.role : "";
      name = firstNotEmpty([stored.name !== stored.email ? stored.name : "", identity.name]);
    } else {
      role = getDefaultRole();
    }
  }

  return {
    authenticated: true,
    authorized: Boolean(role),
    email: identity.email,
    name,
    userId: identity.userId || null,
    role: role || null,
    roleSource: getRoleSource(),
    permissions: getPermissions(role)
  };
}

// Returns { ok: true, user } or { ok: false, res } with a 401/403 ready to assign to context.res.
async function requireRole(req, requiredRole, forbiddenMessage) {
  const user = await requireAuthorizedUser(req);

  if (!user.authenticated) {
    return {
      ok: false,
      res: { status: 401, body: { message: "User is not signed in with a Microsoft account." } }
    };
  }

  if (!user.authorized || !hasRole(user.role, requiredRole)) {
    return {
      ok: false,
      res: {
        status: 403,
        body: { message: forbiddenMessage || `This action requires the ${requiredRole} role.` }
      }
    };
  }

  return { ok: true, user };
}

module.exports = {
  PARTITION_KEY,
  getAuthorizedUserEntity,
  getAuthorizedUsersTableClient,
  getIdentityFromPrincipal,
  hasOwn,
  isValidRole,
  listAuthorizedUsers,
  normalize,
  normalizeAuthorizedUser,
  requireAuthorizedUser,
  requireRole,
  resolveUser
};
