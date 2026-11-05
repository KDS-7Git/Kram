import { Router } from "express";
import { z } from "zod";
import { idSchema } from "@kram/shared";
import {
  profiles,
  skills,
  getSettings,
  setSettings,
  hierarchyBootstrap,
} from "./service";
import { iso, lockOwner } from "../../repository";
import { db } from "../../db";
export const hierarchyRouter = Router();
const bodySchema = z.record(z.string(), z.unknown());
const owner = (res: { locals: Record<string, unknown> }) =>
  String(res.locals.userId);
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: idSchema.optional(),
});
function paginate<T extends { id: string }>(
  rows: T[],
  query: unknown,
  res: { setHeader: (key: string, value: string) => unknown },
) {
  const { limit, cursor } = pageSchema.parse(query);
  const offset = cursor
    ? Math.max(0, rows.findIndex((row) => row.id === cursor) + 1)
    : 0;
  const page = rows.slice(offset, offset + limit);
  if (rows.length > offset + limit)
    res.setHeader("X-Next-Cursor", page.at(-1)!.id);
  return page;
}
hierarchyRouter.get("/bootstrap", async (_req, res) =>
  res.json(await hierarchyBootstrap(owner(res))),
);
hierarchyRouter.get("/profiles", async (req, res) =>
  res.json(
    iso(
      paginate(
        await profiles.list(owner(res), req.query.archived === "true"),
        req.query,
        res,
      ),
    ),
  ),
);
hierarchyRouter.post("/profiles", async (req, res) =>
  res.status(201).json(iso(await profiles.create(owner(res), req.body))),
);
hierarchyRouter.post("/profiles/reorder", async (req, res) => {
  const ids = z.array(idSchema).max(200).parse(req.body?.ids);
  await db.$transaction(async (tx) => {
    await lockOwner(tx, owner(res));
    for (const [sortOrder, id] of ids.entries()) {
      await profiles.get(owner(res), id, tx);
      await tx.profile.update({
        where: { id, userId: owner(res) },
        data: { sortOrder },
      });
    }
  });
  res.json({ saved: true });
});
hierarchyRouter.get("/profiles/:id", async (req, res) =>
  res.json(iso(await profiles.get(owner(res), idSchema.parse(req.params.id)))),
);
hierarchyRouter.patch("/profiles/:id", async (req, res) =>
  res.json(
    iso(
      await profiles.edit(
        owner(res),
        idSchema.parse(req.params.id),
        bodySchema.parse(req.body),
      ),
    ),
  ),
);
hierarchyRouter.post("/profiles/:id/archive", async (req, res) =>
  res.json(
    iso(await profiles.archive(owner(res), idSchema.parse(req.params.id))),
  ),
);
hierarchyRouter.post("/profiles/:id/skills", async (req, res) =>
  res
    .status(201)
    .json(
      iso(
        await skills.create(owner(res), {
          ...bodySchema.parse(req.body),
          profileId: idSchema.parse(req.params.id),
        }),
      ),
    ),
);
hierarchyRouter.get("/skills", async (req, res) => {
  const profileId = req.query.profileId
    ? idSchema.parse(req.query.profileId)
    : undefined;
  if (profileId) await profiles.get(owner(res), profileId);
  const rows = await skills.list(owner(res), req.query.archived === "true");
  res.json(
    iso(
      paginate(
        profileId ? rows.filter((row) => row.profileId === profileId) : rows,
        req.query,
        res,
      ),
    ),
  );
});
hierarchyRouter.post("/skills", async (req, res) =>
  res.status(201).json(iso(await skills.create(owner(res), req.body))),
);
hierarchyRouter.post("/skills/reorder", async (req, res) => {
  const ids = z.array(idSchema).max(200).parse(req.body?.ids);
  await db.$transaction(async (tx) => {
    await lockOwner(tx, owner(res));
    for (const [sortOrder, id] of ids.entries()) {
      await skills.get(owner(res), id, tx);
      await tx.skill.update({
        where: { id, userId: owner(res) },
        data: { sortOrder },
      });
    }
  });
  res.json({ saved: true });
});
hierarchyRouter.get("/skills/:id", async (req, res) =>
  res.json(iso(await skills.get(owner(res), idSchema.parse(req.params.id)))),
);
hierarchyRouter.patch("/skills/:id", async (req, res) =>
  res.json(
    iso(
      await skills.edit(
        owner(res),
        idSchema.parse(req.params.id),
        bodySchema.parse(req.body),
      ),
    ),
  ),
);
hierarchyRouter.post("/skills/:id/archive", async (req, res) =>
  res.json(
    iso(await skills.archive(owner(res), idSchema.parse(req.params.id))),
  ),
);
hierarchyRouter.get("/settings", async (_req, res) =>
  res.json(await getSettings(owner(res))),
);
hierarchyRouter.patch("/settings", async (req, res) =>
  res.json(await setSettings(owner(res), bodySchema.parse(req.body))),
);
