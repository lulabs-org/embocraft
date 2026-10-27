CREATE TABLE "AgentProvider" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "position" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "apiKey" TEXT NOT NULL,
  "defaultModel" TEXT NOT NULL
);

CREATE TABLE "AgentProviderState" ("id" INTEGER NOT NULL PRIMARY KEY);

CREATE TABLE "AgentCharacter" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "data" JSONB NOT NULL,
  CONSTRAINT "AgentCharacter_providerId_fkey" FOREIGN KEY ("providerId")
    REFERENCES "AgentProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AgentPlan" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "position" INTEGER NOT NULL,
  "data" JSONB NOT NULL
);

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "position" INTEGER NOT NULL,
  "data" JSONB NOT NULL
);

CREATE TABLE "AgentRequest" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "planId" TEXT NOT NULL
);
