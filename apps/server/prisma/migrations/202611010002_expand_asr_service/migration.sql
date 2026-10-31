-- AlterTable
ALTER TABLE "AsrService"
  ADD COLUMN "name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'bailian',
  ADD COLUMN "model" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "apiKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "uses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "region" TEXT,
  ADD COLUMN "workspaceId" TEXT,
  ADD COLUMN "baseUrl" TEXT,
  ADD COLUMN "temperature" DOUBLE PRECISION,
  ADD COLUMN "prompt" TEXT;

-- Backfill from data
UPDATE "AsrService" SET
  "name" = COALESCE("data"->>'name', ''),
  "provider" = COALESCE("data"->>'provider', 'bailian'),
  "model" = COALESCE("data"->>'model', ''),
  "apiKey" = COALESCE("data"->>'apiKey', ''),
  "uses" = CASE
    WHEN jsonb_typeof("data"->'uses') = 'array' THEN
      ARRAY(SELECT jsonb_array_elements_text("data"->'uses'))
    ELSE
      ARRAY[]::TEXT[]
  END,
  "region" = "data"->>'region',
  "workspaceId" = "data"->>'workspaceId',
  "baseUrl" = "data"->>'baseUrl',
  "temperature" = CASE
    WHEN "data"->>'temperature' IS NOT NULL THEN ("data"->>'temperature')::double precision
    ELSE NULL
  END,
  "prompt" = "data"->>'prompt'
WHERE "data" IS NOT NULL;

-- Remove data column
ALTER TABLE "AsrService" DROP COLUMN "data";

