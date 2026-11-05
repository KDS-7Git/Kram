-- CreateTable
CREATE TABLE "task" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "itemId" UUID,
    "title" TEXT NOT NULL,
    "estMinutes" INTEGER NOT NULL,
    "remainingMinutes" DOUBLE PRECISION NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "completedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "earliestDate" DATE NOT NULL,
    "dueDate" DATE,
    "supportsSplit" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "periodKey" TEXT NOT NULL,
    "materializationKey" TEXT NOT NULL,
    "timerStartedAt" TIMESTAMPTZ(3),
    "timerAccumulatedMinutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "deferredToDate" DATE,
    "unverified" BOOLEAN NOT NULL DEFAULT false,
    "eventVersion" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_dependency" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "dependsOnTaskId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_dependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_event" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "taskId" UUID,
    "goalId" UUID NOT NULL,
    "ruleVersionId" UUID,
    "kind" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "localDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "clientEventId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "referenceEventId" UUID,
    "toDate" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_progress_cache" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goal_progress_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_slot" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startMin" INTEGER NOT NULL,
    "endMin" INTEGER NOT NULL,
    "layer" TEXT NOT NULL DEFAULT 'flexible',
    "title" TEXT NOT NULL,
    "profileId" UUID,
    "skillId" UUID,
    "goalId" UUID,
    "taskId" UUID,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "templateId" UUID,
    "archivedAt" TIMESTAMPTZ(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_rule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" UUID,
    "type" TEXT NOT NULL DEFAULT 'task_reminder',
    "atLocal" INTEGER,
    "offsetMin" INTEGER,
    "repeatPolicy" TEXT NOT NULL DEFAULT 'once',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "channel" TEXT NOT NULL DEFAULT 'ntfy',
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reminder_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'ntfy',
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dedupeKey" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL DEFAULT 'global',
    "ownerId" UUID,
    "reminderRuleId" UUID,
    "taskId" UUID,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "leaseId" UUID,
    "leaseUntil" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_attempt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "attemptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "leaseId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "jobName" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_materializationKey_key" ON "task"("materializationKey");

-- CreateIndex
CREATE INDEX "task_userId_goalId_status_dueDate_idx" ON "task"("userId", "goalId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "task_userId_earliestDate_status_id_idx" ON "task"("userId", "earliestDate", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "task_id_userId_key" ON "task"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "task_goalId_itemId_periodKey_key" ON "task"("goalId", "itemId", "periodKey");

-- CreateIndex
CREATE INDEX "task_dependency_userId_taskId_idx" ON "task_dependency"("userId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "task_dependency_taskId_dependsOnTaskId_key" ON "task_dependency"("taskId", "dependsOnTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "progress_event_clientEventId_key" ON "progress_event"("clientEventId");

-- CreateIndex
CREATE INDEX "progress_event_userId_taskId_createdAt_id_idx" ON "progress_event"("userId", "taskId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "progress_event_userId_goalId_localDate_idx" ON "progress_event"("userId", "goalId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "progress_event_id_userId_key" ON "progress_event"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "progress_event_taskId_sequence_key" ON "progress_event"("taskId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "goal_progress_cache_goalId_key" ON "goal_progress_cache"("goalId");

-- CreateIndex
CREATE UNIQUE INDEX "goal_progress_cache_goalId_userId_key" ON "goal_progress_cache"("goalId", "userId");

-- CreateIndex
CREATE INDEX "time_slot_userId_date_layer_startMin_idx" ON "time_slot"("userId", "date", "layer", "startMin");

-- CreateIndex
CREATE UNIQUE INDEX "time_slot_id_userId_key" ON "time_slot"("id", "userId");

-- CreateIndex
CREATE INDEX "reminder_rule_userId_ownerType_ownerId_idx" ON "reminder_rule"("userId", "ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_rule_id_userId_key" ON "reminder_rule"("id", "userId");

-- CreateIndex
CREATE INDEX "notification_status_nextAttemptAt_scheduledFor_idx" ON "notification"("status", "nextAttemptAt", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "notification_id_userId_key" ON "notification"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_userId_dedupeKey_key" ON "notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "notification_attempt_userId_notificationId_attemptedAt_idx" ON "notification_attempt"("userId", "notificationId", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_attempt_notificationId_leaseId_key" ON "notification_attempt"("notificationId", "leaseId");

-- CreateIndex
CREATE UNIQUE INDEX "job_run_jobName_periodKey_key" ON "job_run"("jobName", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "goal_rule_version_id_userId_key" ON "goal_rule_version"("id", "userId");

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task" ADD CONSTRAINT "task_itemId_userId_fkey" FOREIGN KEY ("itemId", "userId") REFERENCES "resource_item"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_taskId_userId_fkey" FOREIGN KEY ("taskId", "userId") REFERENCES "task"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_dependency" ADD CONSTRAINT "task_dependency_dependsOnTaskId_userId_fkey" FOREIGN KEY ("dependsOnTaskId", "userId") REFERENCES "task"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_event" ADD CONSTRAINT "progress_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_event" ADD CONSTRAINT "progress_event_taskId_userId_fkey" FOREIGN KEY ("taskId", "userId") REFERENCES "task"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_event" ADD CONSTRAINT "progress_event_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_event" ADD CONSTRAINT "progress_event_ruleVersionId_userId_fkey" FOREIGN KEY ("ruleVersionId", "userId") REFERENCES "goal_rule_version"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_event" ADD CONSTRAINT "progress_event_referenceEventId_userId_fkey" FOREIGN KEY ("referenceEventId", "userId") REFERENCES "progress_event"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_progress_cache" ADD CONSTRAINT "goal_progress_cache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_progress_cache" ADD CONSTRAINT "goal_progress_cache_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_slot" ADD CONSTRAINT "time_slot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_slot" ADD CONSTRAINT "time_slot_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "profile"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_slot" ADD CONSTRAINT "time_slot_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skill"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_slot" ADD CONSTRAINT "time_slot_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_slot" ADD CONSTRAINT "time_slot_taskId_userId_fkey" FOREIGN KEY ("taskId", "userId") REFERENCES "task"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_rule" ADD CONSTRAINT "reminder_rule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_reminderRuleId_userId_fkey" FOREIGN KEY ("reminderRuleId", "userId") REFERENCES "reminder_rule"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_taskId_userId_fkey" FOREIGN KEY ("taskId", "userId") REFERENCES "task"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_attempt" ADD CONSTRAINT "notification_attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_attempt" ADD CONSTRAINT "notification_attempt_notificationId_userId_fkey" FOREIGN KEY ("notificationId", "userId") REFERENCES "notification"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Calendar slots use half-open local minute ranges. Adjacency is allowed.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE time_slot ADD CONSTRAINT slot_time_bounds CHECK ("startMin" >= 0 AND "endMin" <= 1440 AND "endMin" > "startMin" AND version > 0);
ALTER TABLE time_slot ADD CONSTRAINT slot_layers CHECK (layer IN ('unavailable','fixed','pinned','reserved','flexible') AND (layer <> 'reserved' OR "skillId" IS NOT NULL));
ALTER TABLE time_slot ADD CONSTRAINT slot_occupancy_exclusion EXCLUDE USING gist ("userId" WITH =,date WITH =,int4range("startMin","endMin",'[)') WITH &&) WHERE ("archivedAt" IS NULL AND layer IN ('unavailable','fixed','pinned','flexible'));
ALTER TABLE time_slot ADD CONSTRAINT slot_reserved_exclusion EXCLUDE USING gist ("userId" WITH =,date WITH =,"skillId" WITH <>,int4range("startMin","endMin",'[)') WITH &&) WHERE ("archivedAt" IS NULL AND layer = 'reserved');
ALTER TABLE task ADD CONSTRAINT task_amounts CHECK ("estMinutes" > 0 AND "remainingMinutes" >= 0 AND qty > 0 AND "completedQty" >= 0 AND "actualMinutes" >= 0 AND "timerAccumulatedMinutes" >= 0 AND "sortOrder" >= 0);
ALTER TABLE task ADD CONSTRAINT task_dates CHECK ("dueDate" IS NULL OR "dueDate" >= "earliestDate");
ALTER TABLE task ADD CONSTRAINT task_statuses CHECK (status IN ('pending','in_progress','partial','completed','deferred','skipped','cancelled','unverified'));
ALTER TABLE task_dependency ADD CONSTRAINT task_dependency_not_self CHECK ("taskId" <> "dependsOnTaskId");
ALTER TABLE progress_event ADD CONSTRAINT progress_values CHECK (minutes >= 0 AND minutes <= 1440 AND qty >= 0 AND qty <= 1000000);
ALTER TABLE progress_event ADD CONSTRAINT progress_kinds CHECK (kind IN ('started','paused','resumed','progress','completed','deferred','skipped','cancelled','correction'));
ALTER TABLE progress_event ADD CONSTRAINT progress_reference CHECK ((kind = 'correction' AND "referenceEventId" IS NOT NULL AND "referenceEventId" <> id AND minutes = 0 AND qty = 0) OR (kind <> 'correction' AND "referenceEventId" IS NULL));
ALTER TABLE goal_progress_cache ADD CONSTRAINT cache_values CHECK (minutes >= 0 AND qty >= 0 AND completions >= 0);
ALTER TABLE reminder_rule ADD CONSTRAINT reminder_owner_type CHECK ("ownerType" IN ('task','goal','slot','global') AND ("ownerType" <> 'global' OR "ownerId" IS NULL));
ALTER TABLE reminder_rule ADD CONSTRAINT reminder_time CHECK (("atLocal" IS NULL) <> ("offsetMin" IS NULL) AND ("atLocal" IS NULL OR "atLocal" BETWEEN 0 AND 1439) AND ("offsetMin" IS NULL OR "offsetMin" BETWEEN -10080 AND 10080));
ALTER TABLE reminder_rule ADD CONSTRAINT reminder_policy CHECK ("repeatPolicy" IN ('once','until_completed') AND channel = 'ntfy');
ALTER TABLE notification ADD CONSTRAINT notification_states CHECK (status IN ('pending','sent','failed','suppressed_quiet_hours','cancelled') AND "attemptCount" >= 0);
ALTER TABLE job_run ADD CONSTRAINT job_completion_fact CHECK (status = 'succeeded' AND "finishedAt" >= "startedAt");
CREATE TRIGGER progress_history_immutable BEFORE UPDATE OR DELETE ON progress_event FOR EACH ROW EXECUTE FUNCTION protect_append_only_history();
CREATE TRIGGER notification_attempt_immutable BEFORE UPDATE OR DELETE ON notification_attempt FOR EACH ROW EXECUTE FUNCTION protect_append_only_history();
CREATE TRIGGER job_completion_immutable BEFORE UPDATE OR DELETE ON job_run FOR EACH ROW EXECUTE FUNCTION protect_append_only_history();

