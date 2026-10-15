const {
  PARTITION_KEY,
  getAuthorizedUserEntity,
  getAuthorizedUsersTableClient,
  isValidRole,
  listAuthorizedUsers,
  normalize,
  normalizeAuthorizedUser,
  requireRole
} = require("../shared/auth");

const ADMIN_ONLY_MESSAGE = "Only administrators can manage access.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function listAccessUsers(client) {
  const users = await listAuthorizedUsers(client);
  users.sort((a, b) => normalize(a.name).localeCompare(normalize(b.name)));

  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: { total: users.length, items: users }
  };
}

async function createAccessUser(client, req, admin) {
  const body = req.body || {};
  const email = normalize(body.email);
  const role = normalize(body.role);

  if (!EMAIL_PATTERN.test(email)) {
    return { status: 400, body: { message: "Invalid field: email. Provide a valid email address." } };
  }

  if (!isValidRole(role)) {
    return { status: 400, body: { message: "Invalid field: role. Use viewer, editor or admin." } };
  }

  if (await getAuthorizedUserEntity(client, email)) {
    return { status: 409, body: { message: "This user already has access. Update it instead." } };
  }

  const nowIso = new Date().toISOString();
  const entity = {
    partitionKey: PARTITION_KEY,
    rowKey: email,
    displayName: String(body.displayName || body.name || "").trim(),
    role: role,
    isActive: true,
    createdAt: nowIso,
    createdBy: admin.email,
    updatedAt: nowIso,
    updatedBy: admin.email
  };

  await client.createEntity(entity);

  return {
    status: 201,
    body: {
      message: "Access granted successfully.",
      user: normalizeAuthorizedUser(entity)
    }
  };
}

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") {
      context.res = { status: 204 };
      return;
    }

    const adminCheck = await requireRole(req, "admin", ADMIN_ONLY_MESSAGE);
    if (!adminCheck.ok) {
      context.res = adminCheck.res;
      return;
    }

    const client = getAuthorizedUsersTableClient();

    context.res = req.method === "POST"
      ? await createAccessUser(client, req, adminCheck.user)
      : await listAccessUsers(client);
  } catch (error) {
    context.log.error("Failed to manage authorized users:", error);
    context.res = {
      status: 500,
      body: { message: "Failed to manage authorized users." }
    };
  }
};
