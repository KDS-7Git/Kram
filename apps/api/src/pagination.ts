import { z } from "zod";
import { idSchema } from "@kram/shared";
const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: idSchema.optional(),
});
export function paginate<T extends { id: string }>(
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
