/*
  Warnings:

  - You are about to drop the column `data` on the `AgentPlan` table. All the data in the column will be lost.
  - You are about to drop the column `data` on the `AgentRun` table. All the data in the column will be lost.
  - Added the required column `createdAt` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `goal` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `limits` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reason` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `scheduleKind` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `scheduleSpec` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `spentTokens` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `state` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `timeZone` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalTokenBudget` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `AgentPlan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `accountedTokens` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `logs` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reason` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `scheduledAt` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `snapshot` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `status` to the `AgentRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalTokens` to the `AgentRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AgentPlan" DROP COLUMN "data",
ADD COLUMN     "characterId" TEXT,
ADD COLUMN     "characterName" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "goal" TEXT NOT NULL,
ADD COLUMN     "imported" BOOLEAN,
ADD COLUMN     "limits" JSONB NOT NULL,
ADD COLUMN     "limitsMode" TEXT,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "nextRunAt" TIMESTAMP(3),
ADD COLUMN     "reason" TEXT NOT NULL,
ADD COLUMN     "revision" INTEGER,
ADD COLUMN     "scheduleKind" TEXT NOT NULL,
ADD COLUMN     "scheduleSpec" JSONB NOT NULL,
ADD COLUMN     "spentTokens" BIGINT NOT NULL,
ADD COLUMN     "state" TEXT NOT NULL,
ADD COLUMN     "timeZone" TEXT NOT NULL,
ADD COLUMN     "totalTokenBudget" BIGINT NOT NULL,
ADD COLUMN     "totalTokenBudgetEnabled" BOOLEAN,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "AgentRun" DROP COLUMN "data",
ADD COLUMN     "accountedTokens" BIGINT NOT NULL,
ADD COLUMN     "actions" JSONB,
ADD COLUMN     "characterId" TEXT,
ADD COLUMN     "characterName" TEXT,
ADD COLUMN     "coalescedTriggers" INTEGER,
ADD COLUMN     "eventId" TEXT,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "lastBatch" TEXT,
ADD COLUMN     "lastTriggerAt" TIMESTAMP(3),
ADD COLUMN     "logs" JSONB NOT NULL,
ADD COLUMN     "planId" TEXT,
ADD COLUMN     "planRevision" INTEGER,
ADD COLUMN     "reason" TEXT NOT NULL,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "requiresReassignment" BOOLEAN,
ADD COLUMN     "scheduledAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "snapshot" JSONB NOT NULL,
ADD COLUMN     "source" TEXT NOT NULL,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL,
ADD COLUMN     "task" JSONB,
ADD COLUMN     "totalTokens" BIGINT NOT NULL;

-- CreateIndex
CREATE INDEX "AgentPlan_state_nextRunAt_idx" ON "AgentPlan"("state", "nextRunAt");

-- CreateIndex
CREATE INDEX "AgentPlan_characterId_createdAt_id_idx" ON "AgentPlan"("characterId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AgentRun_planId_scheduledAt_id_idx" ON "AgentRun"("planId", "scheduledAt", "id");

-- CreateIndex
CREATE INDEX "AgentRun_characterId_status_idx" ON "AgentRun"("characterId", "status");
