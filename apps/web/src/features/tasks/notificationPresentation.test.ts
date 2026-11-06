import { describe, expect, it } from "vitest";
import type { Notification } from "@kram/shared";
import { deliveryAttemptLabel, groupNotifications, ntfyTopicAddress, pendingDeliveryLabel } from "./notificationPresentation";

const now = Date.parse("2026-11-06T12:00:00Z");
const notification = (id: string, scheduledFor: string, patch: Partial<Notification> = {}): Notification => ({
  id, channel: "ntfy", type: "task_reminder", title: id, body: "A reminder", scheduledFor, status: "pending", attempts: [], ...patch,
});

describe("notification presentation", () => {
  it("joins root and subpath topic URLs without a duplicate slash or lost path", () => {
    for (const base of ["http://ntfy", "http://ntfy/", "http://ntfy///"])
      expect(ntfyTopicAddress(base, "kram-test")).toBe("http://ntfy/kram-test");
    for (const base of ["https://example.test/notify", "https://example.test/notify/", "https://example.test/notify///"])
      expect(ntfyTopicAddress(base, "kram-test")).toBe("https://example.test/notify/kram-test");
    expect(ntfyTopicAddress("http://192.0.2.1:8421/", "kram-test")).toBe("http://192.0.2.1:8421/kram-test");
  });

  it("does not turn credentials or an invalid topic into a displayed subscription URL", () => {
    for (const base of ["not a URL", "javascript:alert(1)", "https://user:pass@example.test", "https://example.test/?token=private", "https://example.test/#private"])
      expect(ntfyTopicAddress(base, "kram-test")).toBeNull();
    for (const topic of ["", "../other", "a/b", "a?token=private"])
      expect(ntfyTopicAddress("https://example.test/notify/", topic)).toBeNull();
  });

  it("collapses only future unattempted schedules and retains past, due, retries and decisions", () => {
    const rows = [
      notification("future-later", "2026-11-08T12:00:00Z"),
      notification("past", "2026-11-05T12:00:00Z"),
      notification("due", "2026-11-06T12:00:00Z"),
      notification("future-first", "2026-11-07T12:00:00Z"),
      notification("retry", "2026-11-07T12:00:00Z", { attempts: [{ id: "attempt-1", attemptedAt: "2026-11-06T11:59:00Z", outcome: "failed", httpStatus: 503 }] }),
      notification("cancelled", "2026-11-09T12:00:00Z", { status: "cancelled" }),
      notification("quiet", "2026-11-07T12:00:00Z", { status: "suppressed_quiet_hours" }),
    ];
    const grouped = groupNotifications(rows, now);
    expect(grouped.upcoming.map((row) => row.id)).toEqual(["future-first", "future-later"]);
    expect(new Set(grouped.history.map((row) => row.id))).toEqual(new Set(["past", "due", "retry", "cancelled", "quiet"]));
    expect(rows[0]?.id).toBe("future-later");
  });

  it("sorts history by its latest scheduled or attempted activity", () => {
    const older = notification("older", "2026-11-06T10:00:00Z", { status: "sent" });
    const retried = notification("retried", "2026-11-05T10:00:00Z", { attempts: [{ id: "latest", attemptedAt: "2026-11-06T11:00:00Z", outcome: "failed", httpStatus: 503 }] });
    expect(groupNotifications([older, retried], now).history.map((row) => row.id)).toEqual(["retried", "older"]);
  });

  it("labels pending retry and snooze from the latest attempt rather than a historic failure", () => {
    const row = notification("pending", "2026-11-06T10:00:00Z");
    expect(pendingDeliveryLabel(row)).toBe("Awaiting delivery");
    row.attempts = [{ id: "failed", attemptedAt: "2026-11-06T10:00:00Z", outcome: "failed", httpStatus: 503 }];
    expect(pendingDeliveryLabel(row)).toBe("Awaiting retry");
    row.attempts.unshift({ id: "snoozed", attemptedAt: "2026-11-06T11:00:00Z", outcome: "snoozed", httpStatus: null });
    expect(pendingDeliveryLabel(row)).toBe("Snoozed");
  });

  it("reports actual provider acceptance without claiming device arrival", () => {
    expect(deliveryAttemptLabel("accepted", "ntfy")).toBe("Accepted by ntfy");
    expect(deliveryAttemptLabel("accepted", "Telegram")).toBe("Accepted by Telegram");
    expect(deliveryAttemptLabel("stale", "ntfy")).toBe("Expired before delivery");
  });
});
