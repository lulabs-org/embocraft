/*
  Warnings:

  - You are about to drop the column `data` on the `AgentCharacter` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AgentCharacter" DROP COLUMN "data",
ADD COLUMN     "createdAt" DOUBLE PRECISION,
ADD COLUMN     "goal" TEXT,
ADD COLUMN     "intervalMaxMs" INTEGER,
ADD COLUMN     "intervalMinMs" INTEGER,
ADD COLUMN     "intervalMode" TEXT,
ADD COLUMN     "intervalMs" INTEGER,
ADD COLUMN     "maxStalledTurns" INTEGER,
ADD COLUMN     "maxTokens" INTEGER,
ADD COLUMN     "maxTurns" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "permissions" JSONB,
ADD COLUMN     "reasoningEffort" TEXT,
ADD COLUMN     "roleDescription" TEXT,
ADD COLUMN     "skills" JSONB,
ADD COLUMN     "taskLimitsEnabled" BOOLEAN,
ADD COLUMN     "taskTimeoutMs" INTEGER,
ADD COLUMN     "thinking" TEXT,
ADD COLUMN     "timeoutMs" INTEGER,
ADD COLUMN     "tokenBudget" INTEGER,
ADD COLUMN     "voiceReplies" BOOLEAN,
ADD COLUMN     "voiceServiceId" TEXT;

-- CreateTable
CREATE TABLE "AgentCharacterState" (
    "characterId" TEXT NOT NULL,
    "status" TEXT,
    "currentRunId" TEXT,
    "runtimeVersion" INTEGER,
    "memory" JSONB,
    "standby" JSONB,

    CONSTRAINT "AgentCharacterState_pkey" PRIMARY KEY ("characterId")
);

-- CreateTable
CREATE TABLE "AgentCharacterLog" (
    "characterId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "time" DOUBLE PRECISION,
    "text" TEXT NOT NULL,

    CONSTRAINT "AgentCharacterLog_pkey" PRIMARY KEY ("characterId","sequence")
);

-- CreateTable
CREATE TABLE "AgentRunCheckpoint" (
    "runId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "execution" JSONB NOT NULL,

    CONSTRAINT "AgentRunCheckpoint_pkey" PRIMARY KEY ("runId")
);

-- AddForeignKey
ALTER TABLE "AgentCharacterState" ADD CONSTRAINT "AgentCharacterState_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCharacterLog" ADD CONSTRAINT "AgentCharacterLog_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunCheckpoint" ADD CONSTRAINT "AgentRunCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
