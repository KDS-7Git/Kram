-- CreateTable
CREATE TABLE "goal" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'minutes',
    "targetQty" DOUBLE PRECISION NOT NULL,
    "startDate" DATE NOT NULL,
    "dueDate" DATE,
    "priority" INTEGER,
    "usePriority" TEXT NOT NULL DEFAULT 'inherit',
    "status" TEXT NOT NULL DEFAULT 'active',
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "scheduleMode" TEXT NOT NULL DEFAULT 'combined',
    "estMinutes" INTEGER NOT NULL DEFAULT 30,
    "availableDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "rrule" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_rule_version" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "rules" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goal_rule_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "goalId" UUID,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "notesRef" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal_resource" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "goal_resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_item" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "parentItemId" UUID,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'task',
    "estMinutes" INTEGER NOT NULL DEFAULT 30,
    "durationMin" INTEGER,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "url" TEXT,
    "pagesFrom" INTEGER,
    "pagesTo" INTEGER,
    "archivedAt" TIMESTAMPTZ(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_dependency" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "dependsOnItemId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "item_dependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goal_userId_skillId_status_sortOrder_id_idx" ON "goal"("userId", "skillId", "status", "sortOrder", "id");

-- CreateIndex
CREATE UNIQUE INDEX "goal_id_userId_key" ON "goal"("id", "userId");

-- CreateIndex
CREATE INDEX "goal_rule_version_userId_goalId_effectiveFrom_version_idx" ON "goal_rule_version"("userId", "goalId", "effectiveFrom", "version");

-- CreateIndex
CREATE UNIQUE INDEX "goal_rule_version_goalId_version_key" ON "goal_rule_version"("goalId", "version");

-- CreateIndex
CREATE INDEX "resource_userId_skillId_createdAt_id_idx" ON "resource"("userId", "skillId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_id_userId_key" ON "resource"("id", "userId");

-- CreateIndex
CREATE INDEX "goal_resource_userId_resourceId_idx" ON "goal_resource"("userId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "goal_resource_goalId_resourceId_key" ON "goal_resource"("goalId", "resourceId");

-- CreateIndex
CREATE INDEX "resource_item_userId_resourceId_parentItemId_ordinal_id_idx" ON "resource_item"("userId", "resourceId", "parentItemId", "ordinal", "id");

-- CreateIndex
CREATE UNIQUE INDEX "resource_item_id_userId_key" ON "resource_item"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "resource_item_id_resourceId_userId_key" ON "resource_item"("id", "resourceId", "userId");

-- CreateIndex
CREATE INDEX "item_dependency_userId_resourceId_idx" ON "item_dependency"("userId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "item_dependency_itemId_dependsOnItemId_key" ON "item_dependency"("itemId", "dependsOnItemId");

-- AddForeignKey
ALTER TABLE "goal" ADD CONSTRAINT "goal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal" ADD CONSTRAINT "goal_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skill"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_rule_version" ADD CONSTRAINT "goal_rule_version_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_rule_version" ADD CONSTRAINT "goal_rule_version_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skill"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_resource" ADD CONSTRAINT "goal_resource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_resource" ADD CONSTRAINT "goal_resource_goalId_userId_fkey" FOREIGN KEY ("goalId", "userId") REFERENCES "goal"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_resource" ADD CONSTRAINT "goal_resource_resourceId_userId_fkey" FOREIGN KEY ("resourceId", "userId") REFERENCES "resource"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_item" ADD CONSTRAINT "resource_item_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_item" ADD CONSTRAINT "resource_item_resourceId_userId_fkey" FOREIGN KEY ("resourceId", "userId") REFERENCES "resource"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_item" ADD CONSTRAINT "resource_item_parentItemId_resourceId_userId_fkey" FOREIGN KEY ("parentItemId", "resourceId", "userId") REFERENCES "resource_item"("id", "resourceId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_dependency" ADD CONSTRAINT "item_dependency_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_dependency" ADD CONSTRAINT "item_dependency_itemId_resourceId_userId_fkey" FOREIGN KEY ("itemId", "resourceId", "userId") REFERENCES "resource_item"("id", "resourceId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_dependency" ADD CONSTRAINT "item_dependency_dependsOnItemId_resourceId_userId_fkey" FOREIGN KEY ("dependsOnItemId", "resourceId", "userId") REFERENCES "resource_item"("id", "resourceId", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Application validation is also enforced for critical domain invariants.
ALTER TABLE goal ADD CONSTRAINT goal_types CHECK (type IN ('daily','weekly','recurring','adaptive','milestone'));
ALTER TABLE goal ADD CONSTRAINT goal_measurement CHECK ("targetQty" > 0 AND "targetQty" <= 1000000 AND length(trim(unit)) > 0 AND "estMinutes" > 0 AND "sortOrder" >= 0);
ALTER TABLE goal ADD CONSTRAINT goal_dates CHECK ("dueDate" IS NULL OR "dueDate" >= "startDate");
ALTER TABLE goal ADD CONSTRAINT goal_policy CHECK ((priority IS NULL OR priority BETWEEN 1 AND 5) AND "usePriority" IN ('inherit','on','off') AND status IN ('active','paused','completed','archived') AND "scheduleMode" IN ('daily','weekly','combined') AND "availableDays" <@ ARRAY[1,2,3,4,5,6,7]);
ALTER TABLE goal ADD CONSTRAINT goal_recurrence CHECK (type <> 'recurring' OR (rrule IS NOT NULL AND length(trim(rrule)) > 0));
ALTER TABLE goal_rule_version ADD CONSTRAINT goal_rule_shape CHECK (version > 0 AND jsonb_typeof(rules) = 'object');
CREATE TRIGGER goal_rule_history_immutable BEFORE UPDATE OR DELETE ON goal_rule_version FOR EACH ROW EXECUTE FUNCTION protect_append_only_history();
ALTER TABLE resource ADD CONSTRAINT resource_type_title CHECK (type IN ('course','book','lab','project') AND length(trim(title)) > 0);
ALTER TABLE resource_item ADD CONSTRAINT resource_item_values CHECK ("estMinutes" >= 0 AND qty > 0 AND qty <= 1000000 AND ordinal >= 0 AND length(trim(title)) > 0 AND ("durationMin" IS NULL OR "durationMin" > 0));
ALTER TABLE resource_item ADD CONSTRAINT resource_item_kind CHECK (kind IN ('chapter','section','video','reading','lab','project','revision','task') AND (kind IN ('chapter','section') OR "estMinutes" > 0));
ALTER TABLE resource_item ADD CONSTRAINT resource_item_pages CHECK (("pagesFrom" IS NULL AND "pagesTo" IS NULL) OR ("pagesFrom" IS NOT NULL AND "pagesTo" IS NOT NULL AND "pagesFrom" > 0 AND "pagesTo" >= "pagesFrom"));
ALTER TABLE resource_item ADD CONSTRAINT resource_parent_not_self CHECK ("parentItemId" IS NULL OR "parentItemId" <> id);
ALTER TABLE item_dependency ADD CONSTRAINT resource_dependency_not_self CHECK ("itemId" <> "dependsOnItemId");

