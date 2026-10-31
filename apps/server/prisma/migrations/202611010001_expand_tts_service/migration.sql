-- AlterTable
ALTER TABLE "TtsService"
  ADD COLUMN "name" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "type" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "baseUrl" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "apiKey" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "model" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "voice" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "speed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN "voiceLanguage" TEXT;

-- Backfill from data
UPDATE "TtsService" SET
  "name" = COALESCE("data"->>'name', ''),
  "type" = COALESCE("data"->>'type', ''),
  "baseUrl" = COALESCE("data"->>'baseUrl', ''),
  "apiKey" = COALESCE("data"->>'apiKey', ''),
  "model" = COALESCE("data"->>'model', ''),
  "voice" = COALESCE("data"->>'voice', ''),
  "speed" = COALESCE(("data"->>'speed')::double precision, 1.0),
  "voiceLanguage" = "data"->>'voiceLanguage'
WHERE "data" IS NOT NULL;

-- Remove data column
ALTER TABLE "TtsService" DROP COLUMN "data";

