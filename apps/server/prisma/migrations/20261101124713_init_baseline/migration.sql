-- CreateEnum
CREATE TYPE "PlayerKind" AS ENUM ('human', 'ai-agent', 'scripted-agent');

-- CreateEnum
CREATE TYPE "ChatScope" AS ENUM ('public', 'private', 'nearby');

-- CreateEnum
CREATE TYPE "ChatKind" AS ENUM ('text', 'audio');

-- CreateEnum
CREATE TYPE "AsrUse" AS ENUM ('chat', 'spatial', 'clip');

-- CreateTable
CREATE TABLE "World" (
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "World_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockEdit" (
    "worldId" TEXT NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "z" INTEGER NOT NULL,
    "material" TEXT,
    "editedBy" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockEdit_pkey" PRIMARY KEY ("worldId","x","y","z")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "kind" "PlayerKind" NOT NULL DEFAULT 'human',
    "normalizedName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "characterId" TEXT,
    "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "senderId" TEXT,
    "senderName" TEXT NOT NULL,
    "scope" "ChatScope" NOT NULL DEFAULT 'public',
    "kind" "ChatKind" NOT NULL DEFAULT 'text',
    "text" TEXT NOT NULL,
    "audioId" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessageRecipient" (
    "messageId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,

    CONSTRAINT "ChatMessageRecipient_pkey" PRIMARY KEY ("messageId","playerId")
);

-- CreateTable
CREATE TABLE "AgentProvider" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "defaultModel" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AgentProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCharacter" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT,
    "model" TEXT,
    "roleDescription" TEXT,
    "taskLimitsEnabled" BOOLEAN,
    "maxTurns" INTEGER,
    "maxStalledTurns" INTEGER,
    "tokenBudget" INTEGER,
    "taskTimeoutMs" INTEGER,
    "intervalMode" TEXT,
    "intervalMinMs" INTEGER,
    "intervalMaxMs" INTEGER,
    "intervalMs" INTEGER,
    "timeoutMs" INTEGER,
    "maxTokens" INTEGER,
    "permissions" JSONB,
    "skills" JSONB,
    "voiceReplies" BOOLEAN,
    "voiceServiceId" TEXT,
    "thinking" TEXT,
    "reasoningEffort" TEXT,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ,
    "deletedAt" TIMESTAMPTZ,

    CONSTRAINT "AgentCharacter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCharacterState" (
    "characterId" TEXT NOT NULL,
    "status" TEXT,
    "currentRunId" TEXT,
    "runtimeVersion" INTEGER,
    "memory" JSONB,
    "standby" JSONB,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

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
CREATE TABLE "AgentPlan" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "characterId" TEXT,
    "characterName" TEXT,
    "revision" INTEGER,
    "imported" BOOLEAN,
    "name" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "scheduleKind" TEXT NOT NULL,
    "scheduleSpec" JSONB NOT NULL,
    "timeZone" TEXT NOT NULL,
    "limits" JSONB NOT NULL,
    "limitsMode" TEXT,
    "totalTokenBudgetEnabled" BOOLEAN,
    "totalTokenBudget" BIGINT NOT NULL,
    "state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "nextRunAt" TIMESTAMPTZ,
    "spentTokens" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AgentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "planId" TEXT,
    "planRevision" INTEGER,
    "characterId" TEXT,
    "characterIdSnapshot" TEXT,
    "characterName" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ NOT NULL,
    "startedAt" TIMESTAMPTZ,
    "finishedAt" TIMESTAMPTZ,
    "eventId" TEXT,
    "coalescedTriggers" INTEGER,
    "lastTriggerAt" TIMESTAMPTZ,
    "snapshot" JSONB NOT NULL,
    "task" JSONB,
    "totalTokens" BIGINT NOT NULL DEFAULT 0,
    "accountedTokens" BIGINT NOT NULL DEFAULT 0,
    "logs" JSONB NOT NULL,
    "actions" JSONB,
    "requestId" TEXT,
    "lastBatch" TEXT,
    "requiresReassignment" BOOLEAN,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunCheckpoint" (
    "runId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "execution" JSONB NOT NULL,

    CONSTRAINT "AgentRunCheckpoint_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "AgentRequest" (
    "key" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRequest_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TtsProvider" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "apiKey" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "voice" TEXT NOT NULL DEFAULT '',
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "voiceLanguage" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TtsProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AsrProvider" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'bailian',
    "model" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL DEFAULT '',
    "region" TEXT,
    "workspaceId" TEXT,
    "baseUrl" TEXT,
    "temperature" DOUBLE PRECISION,
    "prompt" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "AsrProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AsrAssignment" (
    "use" "AsrUse" NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "AsrAssignment_pkey" PRIMARY KEY ("use")
);

-- CreateTable
CREATE TABLE "TokenUsage" (
    "id" BIGSERIAL NOT NULL,
    "characterId" TEXT NOT NULL,
    "planId" TEXT,
    "runId" TEXT,
    "providerId" TEXT,
    "model" TEXT,
    "tokens" BIGINT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Player_characterId_idx" ON "Player"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_kind_normalizedName_key" ON "Player"("kind", "normalizedName");

-- CreateIndex
CREATE INDEX "ChatMessage_createdAt_idx" ON "ChatMessage"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "ChatMessage_senderId_createdAt_idx" ON "ChatMessage"("senderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ChatMessageRecipient_playerId_idx" ON "ChatMessageRecipient"("playerId");

-- CreateIndex
CREATE INDEX "AgentCharacter_voiceServiceId_idx" ON "AgentCharacter"("voiceServiceId");

-- CreateIndex
CREATE INDEX "AgentCharacter_providerId_idx" ON "AgentCharacter"("providerId");

-- CreateIndex
CREATE INDEX "AgentPlan_state_nextRunAt_idx" ON "AgentPlan"("state", "nextRunAt");

-- CreateIndex
CREATE INDEX "AgentPlan_characterId_createdAt_id_idx" ON "AgentPlan"("characterId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AgentRun_planId_scheduledAt_id_idx" ON "AgentRun"("planId", "scheduledAt", "id");

-- CreateIndex
CREATE INDEX "AgentRun_characterId_status_idx" ON "AgentRun"("characterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_id_characterId_key" ON "AgentRun"("id", "characterId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_planId_requestId_key" ON "AgentRun"("planId", "requestId");

-- CreateIndex
CREATE INDEX "AgentRequest_planId_idx" ON "AgentRequest"("planId");

-- CreateIndex
CREATE INDEX "AsrAssignment_providerId_idx" ON "AsrAssignment"("providerId");

-- CreateIndex
CREATE INDEX "TokenUsage_characterId_at_idx" ON "TokenUsage"("characterId", "at" DESC);

-- CreateIndex
CREATE INDEX "TokenUsage_planId_idx" ON "TokenUsage"("planId");

-- CreateIndex
CREATE INDEX "TokenUsage_runId_idx" ON "TokenUsage"("runId");

-- AddForeignKey
ALTER TABLE "BlockEdit" ADD CONSTRAINT "BlockEdit_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageRecipient" ADD CONSTRAINT "ChatMessageRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageRecipient" ADD CONSTRAINT "ChatMessageRecipient_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCharacter" ADD CONSTRAINT "AgentCharacter_voiceServiceId_fkey" FOREIGN KEY ("voiceServiceId") REFERENCES "TtsProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCharacter" ADD CONSTRAINT "AgentCharacter_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AgentProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCharacterState" ADD CONSTRAINT "AgentCharacterState_currentRunId_fkey" FOREIGN KEY ("currentRunId") REFERENCES "AgentRunCheckpoint"("runId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AgentCharacterState" ADD CONSTRAINT "AgentCharacterState_currentRunId_characterId_fkey" FOREIGN KEY ("currentRunId", "characterId") REFERENCES "AgentRun"("id", "characterId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AgentCharacterState" ADD CONSTRAINT "AgentCharacterState_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCharacterLog" ADD CONSTRAINT "AgentCharacterLog_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPlan" ADD CONSTRAINT "AgentPlan_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "AgentCharacter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AgentPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunCheckpoint" ADD CONSTRAINT "AgentRunCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRequest" ADD CONSTRAINT "AgentRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "AgentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AsrAssignment" ADD CONSTRAINT "AsrAssignment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AsrProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
