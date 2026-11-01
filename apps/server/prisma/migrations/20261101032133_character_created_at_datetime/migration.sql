-- AlterTable
ALTER TABLE "AgentCharacter"
  ALTER COLUMN "createdAt" TYPE TIMESTAMP(3) USING CASE
    WHEN "createdAt" IS NOT NULL THEN to_timestamp("createdAt" / 1000.0)
    ELSE NULL
  END,
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
