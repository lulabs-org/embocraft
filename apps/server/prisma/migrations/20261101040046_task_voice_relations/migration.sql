/*
  Warnings:

  - You are about to drop the column `uses` on the `AsrProvider` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[id,characterId]` on the table `AgentRun` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[planId,requestId]` on the table `AgentRun` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "AsrUse" AS ENUM ('chat', 'spatial', 'clip');

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "characterIdSnapshot" TEXT;

-- AlterTable
ALTER TABLE "AsrProvider" DROP COLUMN "uses";

-- CreateTable
CREATE TABLE "AsrAssignment" (
    "use" "AsrUse" NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "AsrAssignment_pkey" PRIMARY KEY ("use")
);

-- CreateIndex
CREATE INDEX "AsrAssignment_providerId_idx" ON "AsrAssignment"("providerId");

-- CreateIndex
CREATE INDEX "AgentCharacter_voiceServiceId_idx" ON "AgentCharacter"("voiceServiceId");

-- CreateIndex
CREATE INDEX "AgentRequest_planId_idx" ON "AgentRequest"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_characterId_key" ON "AgentRun"("id", "characterId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_planId_requestId_key" ON "AgentRun"("planId", "requestId");

-- AddForeignKey
ALTER TABLE "AgentCharacter" ADD CONSTRAINT "AgentCharacter_voiceServiceId_fkey" FOREIGN KEY ("voiceServiceId") REFERENCES "TtsProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCharacterState" ADD CONSTRAINT "AgentCharacterState_currentRunId_fkey" FOREIGN KEY ("currentRunId") REFERENCES "AgentRunCheckpoint"("runId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AgentCharacterState" ADD CONSTRAINT "AgentCharacterState_currentRunId_characterId_fkey" FOREIGN KEY ("currentRunId", "characterId") REFERENCES "AgentRun"("id", "characterId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AgentPlan" ADD CONSTRAINT "AgentPlan_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AgentPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AgentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsrAssignment" ADD CONSTRAINT "AsrAssignment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AsrProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
