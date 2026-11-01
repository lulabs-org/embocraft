-- Add, backfill and verify within one transaction. Invalid/unknown persisted fields
-- abort the migration; no source column is removed until every row matches.
BEGIN;
SET LOCAL TIME ZONE 'UTC';
LOCK TABLE "AgentPlan", "AgentRun" IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION pg_temp.without_null_fields(value JSONB) RETURNS JSONB
LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
  FROM jsonb_each(value) WHERE value <> 'null'::jsonb
$$;

ALTER TABLE "AgentPlan"
  ADD COLUMN "characterId" TEXT,
  ADD COLUMN "characterName" TEXT,
  ADD COLUMN "revision" INTEGER,
  ADD COLUMN "imported" BOOLEAN,
  ADD COLUMN "name" TEXT,
  ADD COLUMN "goal" TEXT,
  ADD COLUMN "scheduleKind" TEXT,
  ADD COLUMN "scheduleSpec" JSONB,
  ADD COLUMN "timeZone" TEXT,
  ADD COLUMN "limits" JSONB,
  ADD COLUMN "limitsMode" TEXT,
  ADD COLUMN "totalTokenBudgetEnabled" BOOLEAN,
  ADD COLUMN "totalTokenBudget" BIGINT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "nextRunAt" TIMESTAMP(3),
  ADD COLUMN "spentTokens" BIGINT,
  ADD COLUMN "createdAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "AgentPlan" SET
  "characterId" = "data"->>'characterId',
  "characterName" = "data"->>'characterName',
  "revision" = ("data"->>'revision')::INTEGER,
  "imported" = ("data"->>'imported')::BOOLEAN,
  "name" = "data"->>'name',
  "goal" = "data"->>'goal',
  "scheduleKind" = "data"->'timing'->>'kind',
  "scheduleSpec" = ("data"->'timing') - 'kind',
  "timeZone" = "data"->>'timeZone',
  "limits" = NULLIF("data"->'limits', 'null'::jsonb),
  "limitsMode" = "data"->>'limitsMode',
  "totalTokenBudgetEnabled" = ("data"->>'totalTokenBudgetEnabled')::BOOLEAN,
  "totalTokenBudget" = ("data"->>'totalTokenBudget')::BIGINT,
  "state" = "data"->>'state',
  "reason" = "data"->>'reason',
  "nextRunAt" = to_timestamp(("data"->>'nextRunAt')::double precision / 1000.0) AT TIME ZONE 'UTC',
  "spentTokens" = ("data"->>'spentTokens')::BIGINT,
  "createdAt" = to_timestamp(("data"->>'createdAt')::double precision / 1000.0) AT TIME ZONE 'UTC',
  "updatedAt" = to_timestamp(("data"->>'updatedAt')::double precision / 1000.0) AT TIME ZONE 'UTC';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AgentPlan" r
    WHERE jsonb_typeof(r.data) IS DISTINCT FROM 'object'
       OR r."totalTokenBudget" NOT BETWEEN 0 AND 9007199254740991
       OR r."spentTokens" NOT BETWEEN 0 AND 9007199254740991
       OR pg_temp.without_null_fields((r.data - 'latestRun')) IS DISTINCT FROM
          pg_temp.without_null_fields(jsonb_build_object(
            'id', r.id,
            'characterId', r."characterId",
            'characterName', r."characterName",
            'revision', r."revision",
            'imported', r."imported",
            'name', r."name",
            'goal', r."goal",
            'timing', r."scheduleSpec" || jsonb_build_object('kind', r."scheduleKind"),
            'timeZone', r."timeZone",
            'limits', r."limits",
            'limitsMode', r."limitsMode",
            'totalTokenBudgetEnabled', r."totalTokenBudgetEnabled",
            'totalTokenBudget', r."totalTokenBudget",
            'state', r."state",
            'reason', r."reason",
            'nextRunAt', extract(epoch FROM r."nextRunAt" AT TIME ZONE 'UTC') * 1000,
            'spentTokens', r."spentTokens",
            'createdAt', extract(epoch FROM r."createdAt" AT TIME ZONE 'UTC') * 1000,
            'updatedAt', extract(epoch FROM r."updatedAt" AT TIME ZONE 'UTC') * 1000
          ))
  ) THEN
    RAISE EXCEPTION 'AgentPlan backfill verification failed; source data retained';
  END IF;
END $$;

ALTER TABLE "AgentPlan"
  ALTER COLUMN "name" SET NOT NULL,
  ALTER COLUMN "goal" SET NOT NULL,
  ALTER COLUMN "scheduleKind" SET NOT NULL,
  ALTER COLUMN "scheduleSpec" SET NOT NULL,
  ALTER COLUMN "timeZone" SET NOT NULL,
  ALTER COLUMN "limits" SET NOT NULL,
  ALTER COLUMN "totalTokenBudget" SET NOT NULL,
  ALTER COLUMN "state" SET NOT NULL,
  ALTER COLUMN "reason" SET NOT NULL,
  ALTER COLUMN "spentTokens" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "AgentRun"
  ADD COLUMN "planId" TEXT,
  ADD COLUMN "planRevision" INTEGER,
  ADD COLUMN "characterId" TEXT,
  ADD COLUMN "characterName" TEXT,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "status" TEXT,
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "scheduledAt" TIMESTAMP(3),
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "finishedAt" TIMESTAMP(3),
  ADD COLUMN "eventId" TEXT,
  ADD COLUMN "coalescedTriggers" INTEGER,
  ADD COLUMN "lastTriggerAt" TIMESTAMP(3),
  ADD COLUMN "snapshot" JSONB,
  ADD COLUMN "task" JSONB,
  ADD COLUMN "totalTokens" BIGINT,
  ADD COLUMN "accountedTokens" BIGINT,
  ADD COLUMN "logs" JSONB,
  ADD COLUMN "actions" JSONB,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "lastBatch" TEXT,
  ADD COLUMN "requiresReassignment" BOOLEAN;

UPDATE "AgentRun" SET
  "planId" = "data"->>'planId',
  "planRevision" = ("data"->>'planRevision')::INTEGER,
  "characterId" = "data"->>'characterId',
  "characterName" = "data"->>'characterName',
  "source" = "data"->>'source',
  "status" = "data"->>'status',
  "reason" = "data"->>'reason',
  "scheduledAt" = to_timestamp(("data"->>'scheduledAt')::double precision / 1000.0) AT TIME ZONE 'UTC',
  "startedAt" = to_timestamp(("data"->>'startedAt')::double precision / 1000.0) AT TIME ZONE 'UTC',
  "finishedAt" = to_timestamp(("data"->>'finishedAt')::double precision / 1000.0) AT TIME ZONE 'UTC',
  "eventId" = "data"->>'eventId',
  "coalescedTriggers" = ("data"->>'coalescedTriggers')::INTEGER,
  "lastTriggerAt" = to_timestamp(("data"->>'lastTriggerAt')::double precision / 1000.0) AT TIME ZONE 'UTC',
  "snapshot" = NULLIF("data"->'snapshot', 'null'::jsonb),
  "task" = NULLIF("data"->'task', 'null'::jsonb),
  "totalTokens" = ("data"->>'totalTokens')::BIGINT,
  "accountedTokens" = ("data"->>'accountedTokens')::BIGINT,
  "logs" = NULLIF("data"->'logs', 'null'::jsonb),
  "actions" = NULLIF("data"->'actions', 'null'::jsonb),
  "requestId" = "data"->>'requestId',
  "lastBatch" = "data"->>'lastBatch',
  "requiresReassignment" = ("data"->>'requiresReassignment')::BOOLEAN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AgentRun" r
    WHERE jsonb_typeof(r.data) IS DISTINCT FROM 'object'
       OR r."totalTokens" NOT BETWEEN 0 AND 9007199254740991
       OR r."accountedTokens" NOT BETWEEN 0 AND 9007199254740991
       OR pg_temp.without_null_fields(r.data) IS DISTINCT FROM
          pg_temp.without_null_fields(jsonb_build_object(
            'id', r.id,
            'planId', r."planId",
            'planRevision', r."planRevision",
            'characterId', r."characterId",
            'characterName', r."characterName",
            'source', r."source",
            'status', r."status",
            'reason', r."reason",
            'scheduledAt', extract(epoch FROM r."scheduledAt" AT TIME ZONE 'UTC') * 1000,
            'startedAt', extract(epoch FROM r."startedAt" AT TIME ZONE 'UTC') * 1000,
            'finishedAt', extract(epoch FROM r."finishedAt" AT TIME ZONE 'UTC') * 1000,
            'eventId', r."eventId",
            'coalescedTriggers', r."coalescedTriggers",
            'lastTriggerAt', extract(epoch FROM r."lastTriggerAt" AT TIME ZONE 'UTC') * 1000,
            'snapshot', r."snapshot",
            'task', r."task",
            'totalTokens', r."totalTokens",
            'accountedTokens', r."accountedTokens",
            'logs', r."logs",
            'actions', r."actions",
            'requestId', r."requestId",
            'lastBatch', r."lastBatch",
            'requiresReassignment', r."requiresReassignment"
          ))
  ) THEN
    RAISE EXCEPTION 'AgentRun backfill verification failed; source data retained';
  END IF;
END $$;

ALTER TABLE "AgentRun"
  ALTER COLUMN "source" SET NOT NULL,
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "reason" SET NOT NULL,
  ALTER COLUMN "scheduledAt" SET NOT NULL,
  ALTER COLUMN "snapshot" SET NOT NULL,
  ALTER COLUMN "totalTokens" SET NOT NULL,
  ALTER COLUMN "accountedTokens" SET NOT NULL,
  ALTER COLUMN "logs" SET NOT NULL;

CREATE INDEX "AgentPlan_state_nextRunAt_idx" ON "AgentPlan"("state", "nextRunAt");
CREATE INDEX "AgentPlan_characterId_createdAt_id_idx" ON "AgentPlan"("characterId", "createdAt", "id");
CREATE INDEX "AgentRun_planId_scheduledAt_id_idx" ON "AgentRun"("planId", "scheduledAt", "id");
CREATE INDEX "AgentRun_characterId_status_idx" ON "AgentRun"("characterId", "status");

-- latestRun is a derived view; execution remains authoritative in AgentRunCheckpoint.
ALTER TABLE "AgentPlan" DROP COLUMN "data";
ALTER TABLE "AgentRun" DROP COLUMN "data";
COMMIT;
