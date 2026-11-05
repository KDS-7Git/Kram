-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isOwner" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "dayRollover" INTEGER NOT NULL DEFAULT 240,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'BookOpen',
    "color" TEXT NOT NULL DEFAULT 'teal',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER,
    "usePriority" TEXT NOT NULL DEFAULT 'inherit',
    "dailyTargetMin" INTEGER NOT NULL DEFAULT 30,
    "weeklyTargetMin" INTEGER NOT NULL DEFAULT 150,
    "maxDailyMin" INTEGER NOT NULL DEFAULT 180,
    "availableDays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "windows" JSONB NOT NULL DEFAULT '[]',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "action" TEXT NOT NULL,
    "ip" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_lockout" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastFailure" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_lockout_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "session" (
    "sid" VARCHAR(255) NOT NULL,
    "sess" JSONB NOT NULL,
    "expire" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "profile_userId_sortOrder_id_idx" ON "profile"("userId", "sortOrder", "id");

-- CreateIndex
CREATE UNIQUE INDEX "profile_id_userId_key" ON "profile"("id", "userId");

-- CreateIndex
CREATE INDEX "skill_userId_profileId_sortOrder_id_idx" ON "skill"("userId", "profileId", "sortOrder", "id");

-- CreateIndex
CREATE UNIQUE INDEX "skill_id_userId_key" ON "skill"("id", "userId");

-- CreateIndex
CREATE INDEX "audit_log_userId_createdAt_idx" ON "audit_log"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "session_expire_idx" ON "session"("expire");

-- AddForeignKey
ALTER TABLE "profile" ADD CONSTRAINT "profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill" ADD CONSTRAINT "skill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill" ADD CONSTRAINT "skill_profileId_userId_fkey" FOREIGN KEY ("profileId", "userId") REFERENCES "profile"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Public setup creates only true owners; non-owner rows support ownership fixtures and a future migration.
CREATE UNIQUE INDEX "only_one_owner" ON "app_user" ("isOwner") WHERE "isOwner" = true;
ALTER TABLE "app_user" ADD CONSTRAINT "user_rollover_bounds" CHECK ("dayRollover" >= 0 AND "dayRollover" < 1440);
ALTER TABLE "app_user" ADD CONSTRAINT "user_settings_object" CHECK (jsonb_typeof("settings") = 'object');
ALTER TABLE "profile" ADD CONSTRAINT "profile_name_order" CHECK (length(trim("name")) > 0 AND "sortOrder" >= 0);
ALTER TABLE "skill" ADD CONSTRAINT "skill_targets_bounds" CHECK ("dailyTargetMin" >= 0 AND "weeklyTargetMin" >= 0 AND "maxDailyMin" >= 0 AND ("priority" IS NULL OR "priority" BETWEEN 1 AND 5));
ALTER TABLE "skill" ADD CONSTRAINT "skill_window_shape" CHECK (jsonb_typeof("windows") = 'array' AND "availableDays" <@ ARRAY[1,2,3,4,5,6,7]);
CREATE FUNCTION protect_append_only_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Append-only history cannot be changed.' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER audit_history_immutable BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION protect_append_only_history();

