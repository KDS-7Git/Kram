-- AlterTable
ALTER TABLE "task" ADD COLUMN     "occurrenceId" UUID;

-- AlterTable
ALTER TABLE "time_slot" ADD COLUMN     "applicationKey" TEXT,
ADD COLUMN     "occurrenceId" UUID;

-- CreateTable
CREATE TABLE "recurrence_series" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "goalId" UUID,
    "skillId" UUID,
    "profileId" UUID,
    "ruleVersionId" UUID,
    "kind" TEXT NOT NULL DEFAULT 'fixed',
    "title" TEXT NOT NULL,
    "rrule" TEXT NOT NULL,
    "dtstartLocal" DATE NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "tz" TEXT NOT NULL,
    "until" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startMin" INTEGER,
    "estMinutes" INTEGER NOT NULL DEFAULT 30,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'minutes',
    "layer" TEXT NOT NULL DEFAULT 'fixed',
    "pausedRanges" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurrence_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_exception" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seriesId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "override" JSONB NOT NULL DEFAULT '{}',
    "toDate" DATE,
    "toStartMin" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurrence_exception_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occurrence" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seriesId" UUID NOT NULL,
    "originalDate" DATE NOT NULL,
    "localDate" DATE NOT NULL,
    "fields" JSONB NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "conflict" JSONB,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "adjusted" BOOLEAN NOT NULL DEFAULT false,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "moved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holiday" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_template" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'week',
    "entries" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "schedule_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_application" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "templateId" UUID,
    "key" TEXT NOT NULL,
    "anchor" DATE NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_application_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recurrence_series_ruleVersionId_key" ON "recurrence_series"("ruleVersionId");

-- CreateIndex
CREATE INDEX "recurrence_series_userId_goalId_effectiveFrom_idx" ON "recurrence_series"("userId", "goalId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "recurrence_series_id_userId_key" ON "recurrence_series"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "recurrence_exception_seriesId_date_key" ON "recurrence_exception"("seriesId", "date");

-- CreateIndex
CREATE INDEX "occurrence_userId_localDate_status_idx" ON "occurrence"("userId", "localDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_id_userId_key" ON "occurrence"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_seriesId_originalDate_key" ON "occurrence"("seriesId", "originalDate");

-- CreateIndex
CREATE UNIQUE INDEX "holiday_userId_date_key" ON "holiday"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_template_id_userId_key" ON "schedule_template"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "template_application_key_key" ON "template_application"("key");

-- CreateIndex
CREATE UNIQUE INDEX "time_slot_applicationKey_key" ON "time_slot"("applicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "time_slot_occurrenceId_key" ON "time_slot"("occurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "time_slot_occurrenceId_userId_key" ON "time_slot"("occurrenceId", "userId");

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_occurrenceId_userId_fkey" FOREIGN KEY ("occurrenceId", "userId") REFERENCES "occurrence"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_slot" ADD CONSTRAINT "time_slot_templateId_userId_fkey" FOREIGN KEY ("templateId", "userId") REFERENCES "schedule_template"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_slot" ADD CONSTRAINT "time_slot_occurrenceId_userId_fkey" FOREIGN KEY ("occurrenceId", "userId") REFERENCES "occurrence"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skill"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "profile"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_ruleVersionId_userId_fkey" FOREIGN KEY ("ruleVersionId", "userId") REFERENCES "goal_rule_version"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_exception" ADD CONSTRAINT "recurrence_exception_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_exception" ADD CONSTRAINT "recurrence_exception_seriesId_userId_fkey" FOREIGN KEY ("seriesId", "userId") REFERENCES "recurrence_series"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_seriesId_userId_fkey" FOREIGN KEY ("seriesId", "userId") REFERENCES "recurrence_series"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_template" ADD CONSTRAINT "schedule_template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_application" ADD CONSTRAINT "template_application_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_application" ADD CONSTRAINT "template_application_templateId_userId_fkey" FOREIGN KEY ("templateId", "userId") REFERENCES "schedule_template"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE recurrence_series ADD CONSTRAINT series_values CHECK (
  kind IN ('fixed','goal') AND status IN ('active','paused','ended') AND version > 0
  AND length(trim(title)) > 0 AND length(trim(rrule)) > 0 AND "estMinutes" BETWEEN 1 AND 960
  AND qty > 0 AND qty <= 1000000 AND jsonb_typeof("pausedRanges") = 'array'
  AND (kind <> 'goal' OR "goalId" IS NOT NULL)
  AND ("startMin" IS NULL OR "startMin" BETWEEN 0 AND 1439)
  AND (kind <> 'fixed' OR ("startMin" IS NOT NULL AND "startMin" + "estMinutes" <= 1440))
  AND layer IN ('fixed','unavailable')
);
ALTER TABLE recurrence_exception ADD CONSTRAINT exception_shape CHECK (
  kind IN ('skip','move','modify') AND jsonb_typeof(override) = 'object'
  AND ((kind = 'move' AND "toDate" IS NOT NULL) OR (kind <> 'move' AND "toDate" IS NULL))
  AND ("toStartMin" IS NULL OR "toStartMin" BETWEEN 0 AND 1439)
);
ALTER TABLE occurrence ADD CONSTRAINT occurrence_shape CHECK (
  status IN ('scheduled','suppressed','conflict') AND jsonb_typeof(fields) = 'object'
);
ALTER TABLE schedule_template ADD CONSTRAINT template_shape CHECK (
  kind IN ('day','week') AND version > 0 AND length(trim(name)) > 0 AND jsonb_typeof(entries) = 'array'
);
ALTER TABLE holiday ADD CONSTRAINT holiday_title CHECK (length(trim(title)) > 0);
ALTER TABLE template_application ADD CONSTRAINT application_snapshot CHECK (jsonb_typeof(snapshot) = 'object');
CREATE TRIGGER template_application_immutable BEFORE UPDATE OR DELETE ON template_application FOR EACH ROW EXECUTE FUNCTION protect_append_only_history();
