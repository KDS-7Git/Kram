import { DateTime } from "luxon";
import { studyDate } from "@kram/time";
import { dateSchema } from "@kram/shared";
import { getSettings } from "./modules/hierarchy/service";
import type { Connection } from "./repository";
export const clock = { now: () => DateTime.utc().toISO()! };
export const calendarDate = (value: string) =>
  DateTime.fromISO(dateSchema.parse(value), { zone: "utc" }).toJSDate();
export const calendarString = (value: Date) => value.toISOString().slice(0, 10);
export async function currentStudyDate(userId: string, connection?: Connection) {
  const settings = await getSettings(userId, connection);
  return studyDate(clock.now(), settings.timezone, settings.dayRollover);
}
