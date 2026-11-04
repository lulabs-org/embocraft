CREATE TABLE "LiveVoiceProvider" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    CONSTRAINT "LiveVoiceProvider_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AgentCharacter" ADD COLUMN "liveVoiceServiceId" TEXT;
CREATE INDEX "AgentCharacter_liveVoiceServiceId_idx" ON "AgentCharacter"("liveVoiceServiceId");
ALTER TABLE "AgentCharacter" ADD CONSTRAINT "AgentCharacter_liveVoiceServiceId_fkey" FOREIGN KEY ("liveVoiceServiceId") REFERENCES "LiveVoiceProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
