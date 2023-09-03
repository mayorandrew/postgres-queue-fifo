-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'started', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "Job" (
    "id" SERIAL NOT NULL,
    "queue" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "lastStartedAt" TIMESTAMPTZ,
    "finishedAt" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "data" JSONB NOT NULL,
    "result" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);
