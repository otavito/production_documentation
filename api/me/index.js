const { requireAuthorizedUser } = require("../shared/auth");

module.exports = async function (context, req) {
  try {
    if (req.method === "OPTIONS") {
      context.res = { status: 204 };
      return;
    }

    const user = await requireAuthorizedUser(req);

    context.res = {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      },
      body: user
    };
  } catch (error) {
    context.log.error("Failed to load the signed-in user:", error);
    context.res = {
      status: 500,
      body: { message: "Failed to load the signed-in user." }
    };
  }
};
