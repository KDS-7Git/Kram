import type { Notification } from "@kram/shared";

/** Append a topic without replacing an ntfy installation's configured subpath. */
export function ntfyTopicAddress(baseUrl: string, topic: string): string | null {
  try {
    const base = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username || base.password || base.search || base.hash ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(topic)
    ) return null;
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/${topic}`;
    return base.toString();
  } catch {
    return null;
  }
}

function lastActivity(notification: Notification) {
  return Math.max(
    Date.parse(notification.scheduledFor),
    ...notification.attempts.map((attempt) => Date.parse(attempt.attemptedAt)),
  );
}

/** Future schedules have no delivery result yet; attempts remain in history. */
export function groupNotifications(notifications: Notification[], now: number) {
  const history: Notification[] = [];
  const upcoming: Notification[] = [];
  for (const notification of notifications) {
    if (
      notification.status === "pending" &&
      notification.attempts.length === 0 &&
      Date.parse(notification.scheduledFor) > now
    ) upcoming.push(notification);
    else history.push(notification);
  }
  history.sort((a, b) => lastActivity(b) - lastActivity(a) || a.id.localeCompare(b.id));
  upcoming.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor) || a.id.localeCompare(b.id));
  return { history, upcoming };
}

export function deliveryProvider(notification: Pick<Notification, "channel">) {
  return notification.channel === "telegram" ? "Telegram" : "ntfy";
}

export function pendingDeliveryLabel(notification: Notification) {
  const latest = [...notification.attempts].sort(
    (a, b) => Date.parse(b.attemptedAt) - Date.parse(a.attemptedAt),
  )[0];
  if (latest?.outcome === "failed") return "Awaiting retry";
  if (latest?.outcome === "snoozed") return "Snoozed";
  return "Awaiting delivery";
}

export function deliveryAttemptLabel(outcome: string, provider: string) {
  const labels: Record<string, string> = {
    accepted: `Accepted by ${provider}`,
    failed: "Delivery failed",
    cancelled: "Cancelled",
    stale: "Expired before delivery",
    snoozed: "Snoozed",
    suppressed_quiet_hours: "Held for quiet hours",
  };
  return labels[outcome] || outcome.replaceAll("_", " ");
}
