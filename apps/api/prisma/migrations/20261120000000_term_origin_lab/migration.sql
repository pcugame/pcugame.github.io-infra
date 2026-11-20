BEGIN;
-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'BETA_TESTER';

-- CreateTable
CREATE TABLE "LabDataset" (
    "id" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "hash" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabDataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabTestCase" (
    "datasetId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "term" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "body" JSONB NOT NULL,

    CONSTRAINT "LabTestCase_pkey" PRIMARY KEY ("datasetId","caseId")
);

-- CreateTable
CREATE TABLE "LabRun" (
    "id" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "datasetId" TEXT NOT NULL,
    "datasetHash" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "searchMode" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,
    "maxTokens" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "LabRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabResult" (
    "runId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryBase" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "output" JSONB,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "history" JSONB NOT NULL DEFAULT '[]',
    "durationMs" INTEGER,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "jsonValid" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "toolSucceeded" BOOLEAN NOT NULL DEFAULT false,
    "toolSupport" TEXT NOT NULL DEFAULT 'unknown',

    CONSTRAINT "LabResult_pkey" PRIMARY KEY ("runId","caseId")
);

-- CreateTable
CREATE TABLE "LabRoleAudit" (
    "id" SERIAL NOT NULL,
    "actorId" INTEGER NOT NULL,
    "targetId" INTEGER NOT NULL,
    "beforeRole" "UserRole" NOT NULL,
    "afterRole" "UserRole" NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabRoleAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabDataset_ownerId_createdAt_idx" ON "LabDataset"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LabDataset_ownerId_hash_key" ON "LabDataset"("ownerId", "hash");

-- CreateIndex
CREATE UNIQUE INDEX "LabTestCase_datasetId_ordinal_key" ON "LabTestCase"("datasetId", "ordinal");

-- CreateIndex
CREATE INDEX "LabRun_ownerId_createdAt_idx" ON "LabRun"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "LabRun_status_createdAt_idx" ON "LabRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LabRun_id_datasetId_key" ON "LabRun"("id", "datasetId");

-- CreateIndex
CREATE INDEX "LabResult_status_leaseUntil_idx" ON "LabResult"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "LabResult_runId_ordinal_key" ON "LabResult"("runId", "ordinal");

-- CreateIndex
CREATE INDEX "LabRoleAudit_targetId_changedAt_idx" ON "LabRoleAudit"("targetId", "changedAt");

-- AddForeignKey
ALTER TABLE "LabDataset" ADD CONSTRAINT "LabDataset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabTestCase" ADD CONSTRAINT "LabTestCase_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "LabDataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabRun" ADD CONSTRAINT "LabRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabRun" ADD CONSTRAINT "LabRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "LabDataset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_runId_datasetId_fkey" FOREIGN KEY ("runId", "datasetId") REFERENCES "LabRun"("id", "datasetId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_datasetId_caseId_fkey" FOREIGN KEY ("datasetId", "caseId") REFERENCES "LabTestCase"("datasetId", "caseId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabRoleAudit" ADD CONSTRAINT "LabRoleAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabRoleAudit" ADD CONSTRAINT "LabRoleAudit_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
COMMIT;
