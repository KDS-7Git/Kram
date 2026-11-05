import { z } from "zod";
import { resourceTypes } from "@kram/shared";
import { ApiError } from "../../errors";
const inputSchema = z.object({
  outline: z.string().min(1).max(100000),
  defaultMinutes: z.number().int().min(1).max(960).default(30),
});
export function parseOutline(
  input: unknown,
  type: (typeof resourceTypes)[number],
) {
  const { outline, defaultMinutes } = inputSchema.parse(input);
  const lines = outline.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length || lines.length > 500)
    throw new ApiError(
      "VALIDATION_FAILED",
      "Paste between 1 and 500 outline items.",
      400,
    );
  const parsed = lines.map((line, index) => {
    const prefix = /^[\t ]*/.exec(line)![0];
    if (
      (prefix.includes("\t") && prefix.includes(" ")) ||
      (!prefix.includes("\t") && prefix.length % 2 !== 0)
    )
      throw new ApiError(
        "INVALID_OUTLINE",
        `Use two spaces or one tab per level (line ${index + 1}).`,
        400,
      );
    const depth = prefix.includes("\t") ? prefix.length : prefix.length / 2;
    const duration = /\s*\[(\d+)\s*m(?:in)?\]\s*$/i.exec(line);
    const minutes = duration ? Number(duration[1]) : defaultMinutes;
    if (minutes < 1 || minutes > 100000)
      throw new ApiError(
        "INVALID_OUTLINE",
        `Check the duration on line ${index + 1}.`,
        400,
      );
    const title = line
      .slice(prefix.length)
      .replace(/^[-*]\s+/, "")
      .replace(/\s*\[\d+\s*m(?:in)?\]\s*$/i, "")
      .trim();
    if (!title || title.length > 200)
      throw new ApiError(
        "INVALID_OUTLINE",
        `Check the title on line ${index + 1}.`,
        400,
      );
    return { depth, title, minutes, explicit: Boolean(duration) };
  });
  const stack: number[] = [],
    orders = new Map<number | null, number>();
  return parsed.map((row, index) => {
    if ((index === 0 && row.depth !== 0) || row.depth > stack.length)
      throw new ApiError(
        "INVALID_OUTLINE",
        `An outline level is missing before line ${index + 1}.`,
        400,
      );
    stack.length = row.depth;
    const parentIndex = row.depth ? stack[row.depth - 1]! : null;
    const ordinal = orders.get(parentIndex) ?? 0;
    orders.set(parentIndex, ordinal + 1);
    stack[row.depth] = index;
    const container = (parsed[index + 1]?.depth ?? 0) > row.depth;
    const kind = container
      ? "chapter"
      : type === "course"
        ? "video"
        : type === "book"
          ? "reading"
          : type === "lab"
            ? "lab"
            : "task";
    return {
      parentIndex,
      ordinal,
      title: row.title,
      kind,
      estMinutes: container && !row.explicit ? 0 : row.minutes,
      durationMin:
        type === "course" && (!container || row.explicit) ? row.minutes : null,
      qty: 1,
    };
  });
}
