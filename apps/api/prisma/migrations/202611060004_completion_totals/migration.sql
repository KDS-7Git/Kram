-- Retain completion observations separately from the original delta so later
-- corrections can replay totals accurately without rewriting permanent events.
-- Legacy rows remain incremental facts because their wire totals were not saved.
ALTER TABLE "progress_event"
  ADD COLUMN "reportedTotalMinutes" DOUBLE PRECISION,
  ADD COLUMN "reportedTotalQty" DOUBLE PRECISION;
ALTER TABLE "progress_event" ADD CONSTRAINT progress_completion_totals CHECK (
  (kind = 'completed' OR ("reportedTotalMinutes" IS NULL AND "reportedTotalQty" IS NULL))
  AND ("reportedTotalMinutes" IS NULL OR "reportedTotalMinutes" BETWEEN 0 AND 1000000)
  AND ("reportedTotalQty" IS NULL OR "reportedTotalQty" BETWEEN 0 AND 1000000)
);
