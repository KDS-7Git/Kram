-- Owner edits detach an unstarted task from automatic source projection.
-- Existing rows retain their historical identity and source-managed default.
ALTER TABLE "task" ADD COLUMN "manualOverride" BOOLEAN NOT NULL DEFAULT false;
