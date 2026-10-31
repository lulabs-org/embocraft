-- DropTable
DROP TABLE IF EXISTS "AsrService";

-- DropTable
DROP TABLE IF EXISTS "TtsCatalogState";

-- DropTable
DROP TABLE IF EXISTS "TtsService";

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

    CONSTRAINT "TtsProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TtsProviderState" (
    "id" INTEGER NOT NULL,

    CONSTRAINT "TtsProviderState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AsrProvider" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'bailian',
    "model" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL DEFAULT '',
    "uses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "region" TEXT,
    "workspaceId" TEXT,
    "baseUrl" TEXT,
    "temperature" DOUBLE PRECISION,
    "prompt" TEXT,

    CONSTRAINT "AsrProvider_pkey" PRIMARY KEY ("id")
);
