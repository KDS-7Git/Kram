export function minuteTime(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
export function timeMinute(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return (hour || 0) * 60 + (minute || 0);
}
export function duration(minutes: number) {
  const value = Math.round(minutes * 100) / 100;
  const remainder = Math.round((value % 60) * 100) / 100;
  return value >= 60
    ? `${Math.floor(value / 60)} h${remainder ? ` ${remainder} min` : ""}`
    : `${value} min`;
}
export function allocatedMinutes(
  slots: { startMin: number; endMin: number }[],
  start = 0,
  end = 1440,
) {
  const intervals = slots
    .map((slot) => [Math.max(start, slot.startMin), Math.min(end, slot.endMin)])
    .filter(([from, to]) => to! > from!)
    .sort(([a], [b]) => a! - b!);
  let total = 0;
  let coveredTo = start;
  for (const [from, to] of intervals) {
    total += Math.max(0, to! - Math.max(from!, coveredTo));
    coveredTo = Math.max(coveredTo, to!);
  }
  return total;
}
export function calendarDate(value: string | null) {
  if (!value) return "No deadline";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}
export function timerClock(minutes: number) {
  const seconds = Math.max(0, Math.floor(minutes * 60));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function clockLabel(minute: number, format: "12" | "24" = "24") {
  const hour = Math.floor(minute / 60) % 24;
  return format === "24"
    ? minuteTime(minute)
    : `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour >= 12 ? "pm" : "am"}`;
}
export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .map((word) => word[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
export const weekdays = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];
