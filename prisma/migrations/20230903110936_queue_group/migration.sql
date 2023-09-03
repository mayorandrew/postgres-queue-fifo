-- CreateTable
CREATE TABLE "QueueGroup" (
    "queue" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueGroup_pkey" PRIMARY KEY ("queue","groupId")
);

-- CreateIndex
CREATE INDEX "Job_queue_groupId_status_id_idx" ON "Job"("queue", "groupId", "status", "id");
