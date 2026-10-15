const {
  PARTITION_KEY,
  getAuthorizedUserEntity,
  getAuthorizedUsersTableClient,
  hasOwn,
  isValidRole,
  normalize,
  normalizeAuthorizedUser,
  requireRole
} = require("../shared/auth");

const ADMIN_ONLY_MESSAGE = "Only administrators can manage access.";

class ValidationError extends Error {}

function toBoolean(value, fieldName) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = normalize(value);
  if (normalized === "true") return true;
  if (normalized === "false") return false;

  throw new ValidationError(`Invalid field: ${fieldName}. Use true or false.`);
}

function buildChanges(body) {
  const changes = {};

  if (hasOwn(body, "isActive")) {
    changes.isActive = toBoolean(body.isActive, "isActive");
  }

  if (hasOwn(body, "role")) {
    const role = normalize(body.role);

    if (!isValidRole(role)) {
      throw new ValidationError("Invalid field: role. Use viewer, editor or admin.");
    }

    changes.role = role;
  }

  if (hasOwn(body, "displayName")) {
    changes.displayName = String(body.displayName || "").trim();
  } else if (hasOwn(body, "name")) {
    changes.displayName = String(body.name || "").trim();
  }

  return changes;
}

// Prevents an admin from locking themselves out.
function blocksOwnAdminAccess(email, changes, admin) {
  if (email !== normalize(admin.email)) {
    return false;
  }

  if (hasOwn(changes, "isActive") && changes.isActive === false) {
    return true;
  }

  return hasOwn(changes, "role") && changes.role !== "admin";
}

async function getAccessUser(client, email) {
  const entity = await getAuthorizedUserEntity(client, email);

  if (!entity) {
    return { status: 404, body: { message: "Authorized user not found." } };
  }

  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: { user: normalizeAuthorizedUser(entity) }
  };
}

async function updateAccessUser(client, req, email, admin) {
  const changes = buildChanges(req.body || {});

  if (!Object.keys(changes).length) {
    return { status: 400, body: { message: "Provide at least one field to update." } };
  }

  if (blocksOwnAdminAccess(email, changes, admin)) {
    return { status: 400, body: { message: "You cannot remove your own administrator access." } };
  }

  if (!(await getAuthorizedUserEntity(client, email))) {
    return { status: 404, body: { message: "Authorized user not found." } };
  }

  await client.updateEntity({
    partitionKey: PARTITION_KEY,
    rowKey: email,
    ...changes,
    updatedAt: new Date().toISOString(),
    updatedBy: admin.email
  }, "Merge");

  const updatedUser = await client.getEntity(PARTITION_KEY, email);

  return {
    status: 200,
    body: {
      message: "Access updated successfully.",
      user: normalizeAuthorizedUser(updatedUser)
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

    const email = normalize(req.params && req.params.email);
    if (!email) {
      context.res = { status: 400, body: { message: "The user's email is required." } };
      return;
    }

    const client = getAuthorizedUsersTableClient();

    context.res = req.method === "PATCH"
      ? await updateAccessUser(client, req, email, adminCheck.user)
      : await getAccessUser(client, email);
  } catch (error) {
    if (error instanceof ValidationError) {
      context.res = { status: 400, body: { message: error.message } };
      return;
    }

    context.log.error("Failed to update authorized user:", error);
    context.res = {
      status: 500,
      body: { message: "Failed to update authorized user." }
    };
  }
};
