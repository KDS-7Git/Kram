import { Router } from "express";
import { rateLimit, MemoryStore } from "express-rate-limit";
import { db } from "../../db";
import { config } from "../../config";
import { ApiError } from "../../errors";
import {
  csrf,
  token,
  sessionUser,
  rotateSession,
  endSession,
  safeEqual,
} from "../../session";
import { createOwner, verifyOwnerCredentials, ownerDefaults } from "./service";

export const authRouter = Router();
const store = new MemoryStore();
export const resetAuthLimiterForTests = () => store.resetAll();
const limit = rateLimit({
  store,
  windowMs: 15 * 60000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  handler: (_req, res) =>
    res
      .status(429)
      .json({
        error: {
          code: "RATE_LIMITED",
          message: "Wait a moment before trying to sign in again.",
          requestId: res.locals.requestId,
        },
      }),
});
authRouter.get("/me", async (req, res) => {
  const user = await sessionUser(req);
  req.session.csrfToken ??= token();
  const setupRequired = !(await db.user.count({ where: { isOwner: true } }));
  res.json({
    user,
    csrfToken: req.session.csrfToken,
    setupRequired,
    setupAllowed: !config.production || Boolean(config.ownerSetupToken),
    setupTokenRequired: Boolean(config.ownerSetupToken),
    defaults: ownerDefaults(),
    expiresAt: user
      ? new Date(
          Math.min(
            (req.session.createdAt ?? Date.now()) + 30 * 86400000,
            (req.session.lastActiveAt ?? Date.now()) + 7 * 86400000,
          ),
        ).toISOString()
      : null,
  });
});
authRouter.post("/setup", limit, csrf, async (req, res) => {
  if (config.production && !config.ownerSetupToken)
    throw new ApiError(
      "SETUP_DISABLED",
      "Create the owner with the server CLI before signing in.",
      403,
    );
  if (
    config.ownerSetupToken &&
    !safeEqual(config.ownerSetupToken, String(req.body?.setupToken ?? ""))
  )
    throw new ApiError(
      "SETUP_TOKEN_REQUIRED",
      "Enter the owner setup code from your server.",
      403,
    );
  const user = await createOwner(req.body, req.ip);
  await rotateSession(req, user.id);
  res
    .status(201)
    .json({ user, csrfToken: req.session.csrfToken, setupRequired: false });
});
authRouter.post("/login", limit, csrf, async (req, res) => {
  const user = await verifyOwnerCredentials(req.body, req.ip ?? "unknown");
  await rotateSession(req, user.id);
  res.json({ user, csrfToken: req.session.csrfToken, setupRequired: false });
});
authRouter.post("/logout", csrf, async (req, res) => {
  await endSession(req, res);
  res.json({ user: null });
});
