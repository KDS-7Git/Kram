import { Router } from "express";
import { z } from "zod";
import { idSchema } from "@kram/shared";
import { goals, goalDto } from "./service";
import { paginate } from "../../pagination";
import { iso, lockOwner } from "../../repository";
import { db } from "../../db";
import { skills } from "../hierarchy/service";
export const goalsRouter = Router();
const owner = (res: { locals: Record<string, unknown> }) =>
  String(res.locals.userId);
goalsRouter.get("/goals", async (req, res) => {
  const skillId = req.query.skillId
    ? idSchema.parse(req.query.skillId)
    : undefined;
  if (skillId) await skills.get(owner(res), skillId);
  const rows = await goals.list(owner(res), req.query.archived === "true");
  res.json(
    iso(
      paginate(
        (skillId ? rows.filter((row) => row.skillId === skillId) : rows).map(
          goalDto,
        ),
        req.query,
        res,
      ),
    ),
  );
});
goalsRouter.post("/goals", async (req, res) =>
  res.status(201).json(iso(await goals.create(owner(res), req.body))),
);
goalsRouter.post("/goals/reorder", async (req, res) => {
  const ids = z.array(idSchema).max(200).parse(req.body?.ids);
  await db.$transaction(async (tx) => {
    await lockOwner(tx, owner(res));
    for (const [sortOrder, id] of ids.entries()) {
      await goals.get(owner(res), id, tx);
      await tx.goal.update({
        where: { id, userId: owner(res) },
        data: { sortOrder },
      });
    }
  });
  res.json({ saved: true });
});
goalsRouter.get("/goals/:id", async (req, res) =>
  res.json(
    iso(goalDto(await goals.get(owner(res), idSchema.parse(req.params.id)))),
  ),
);
goalsRouter.patch("/goals/:id", async (req, res) =>
  res.json(
    iso(
      await goals.edit(
        owner(res),
        idSchema.parse(req.params.id),
        z.record(z.string(), z.unknown()).parse(req.body),
      ),
    ),
  ),
);
for (const [action, status] of [
  ["pause", "paused"],
  ["resume", "active"],
  ["archive", "archived"],
] as const)
  goalsRouter.post(`/goals/:id/${action}`, async (req, res) =>
    res.json(
      iso(
        await goals.status(owner(res), idSchema.parse(req.params.id), status),
      ),
    ),
  );
goalsRouter.get("/goals/:id/rules", async (req, res) =>
  res.json(iso(await goals.rules(owner(res), idSchema.parse(req.params.id)))),
);
