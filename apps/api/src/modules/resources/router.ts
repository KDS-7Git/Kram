import { Router } from "express";
import { z } from "zod";
import { idSchema } from "@kram/shared";
import { resources, resourceDto, resourceItems, itemDto } from "./service";
import { paginate } from "../../pagination";
import { iso } from "../../repository";
import { skills } from "../hierarchy/service";
import { goals } from "../goals/service";
export const resourcesRouter = Router();
const owner = (res: { locals: Record<string, unknown> }) =>
    String(res.locals.userId),
  body = z.record(z.string(), z.unknown());
resourcesRouter.get("/resources", async (req, res) => {
  const skillId = req.query.skillId
      ? idSchema.parse(req.query.skillId)
      : undefined,
    goalId = req.query.goalId ? idSchema.parse(req.query.goalId) : undefined;
  if (skillId) await skills.get(owner(res), skillId);
  if (goalId) await goals.get(owner(res), goalId);
  const rows = await resources.list(owner(res), req.query.archived === "true");
  const filtered = rows.filter(
    (row) =>
      (!skillId || row.skillId === skillId) &&
      (!goalId || row.goals.some((link) => link.goalId === goalId)),
  );
  res.json(iso(paginate(filtered.map(resourceDto), req.query, res)));
});
resourcesRouter.post("/resources", async (req, res) =>
  res.status(201).json(iso(await resources.create(owner(res), req.body))),
);
resourcesRouter.get("/resources/:id", async (req, res) =>
  res.json(
    iso(
      resourceDto(
        await resources.get(owner(res), idSchema.parse(req.params.id)),
      ),
    ),
  ),
);
resourcesRouter.patch("/resources/:id", async (req, res) =>
  res.json(
    iso(
      await resources.edit(
        owner(res),
        idSchema.parse(req.params.id),
        body.parse(req.body),
      ),
    ),
  ),
);
resourcesRouter.post("/resources/:id/archive", async (req, res) =>
  res.json(
    iso(await resources.archive(owner(res), idSchema.parse(req.params.id))),
  ),
);
resourcesRouter.get("/resources/:id/items", async (req, res) =>
  res.json(
    iso(
      paginate(
        await resources.items(
          owner(res),
          idSchema.parse(req.params.id),
          req.query.archived === "true",
        ),
        req.query,
        res,
      ),
    ),
  ),
);
resourcesRouter.post("/resources/:id/items", async (req, res) =>
  res
    .status(201)
    .json(
      iso(
        await resources.addItem(
          owner(res),
          idSchema.parse(req.params.id),
          req.body,
        ),
      ),
    ),
);
resourcesRouter.post("/resources/:id/import-outline", async (req, res) =>
  res
    .status(201)
    .json(
      iso(
        await resources.import(
          owner(res),
          idSchema.parse(req.params.id),
          req.body,
        ),
      ),
    ),
);
resourcesRouter.post("/resources/:id/reorder", async (req, res) =>
  res.json(
    await resources.reorder(
      owner(res),
      idSchema.parse(req.params.id),
      z
        .array(
          z.object({
            id: idSchema,
            parentItemId: idSchema.nullable(),
            ordinal: z.number().int().min(0),
          }),
        )
        .max(2000)
        .parse(req.body?.items),
    ),
  ),
);
resourcesRouter.get("/resource-items/:id", async (req, res) =>
  res.json(
    iso(
      itemDto(
        await resourceItems.get(owner(res), idSchema.parse(req.params.id)),
      ),
    ),
  ),
);
resourcesRouter.patch("/resource-items/:id", async (req, res) =>
  res.json(
    iso(
      await resources.editItem(
        owner(res),
        idSchema.parse(req.params.id),
        body.parse(req.body),
      ),
    ),
  ),
);
resourcesRouter.post("/resource-items/:id/archive", async (req, res) =>
  res.json(
    iso(await resources.archiveItem(owner(res), idSchema.parse(req.params.id))),
  ),
);
