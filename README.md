# postgres-queue-fifo

This is a proof of concept exploring if that is possible to create a group concurrency controlled queue (similar to AWS SQS FIFO) based on PostgreSQL.
Of course, PostgreSQL is not the best tool for implementing the job queues, but if there are no hard performance requirements, and PostgreSQL is already there, it might make sense to avoid adding more infrastructure into the project.

For the sake of the POC, I have used [Prisma](https://github.com/prisma/prisma) to generate database migrations and [Kysely](https://github.com/kysely-org/kysely) to build and run type-safe queries in TypeScript, but this would work similarly with raw SQL or any well-developed ORM.

The POC is based on row locks and transactions. Each job is running within an open transaction that holds two locks to avoid other job processors picking the same job or any other job from the same concurrency group. There is no possibility for a deadlock, but long-running transaction may cause timeouts, so PostgreSQL must be configured accordingly.

## How it works

1. There are two tables in the database:
    1. `Job`
        ```PostgreSQL
        -- CreateEnum
        CREATE TYPE "JobStatus" AS ENUM ('queued', 'started', 'succeeded', 'failed');
           
        -- CreateTable
        CREATE TABLE "Job" (
            "id" SERIAL NOT NULL,
            -- Queue in which the job is placed. Processor can listen to different queues separately
            "queue" TEXT NOT NULL,
            -- GroupID defines the concurrency group. Within one group only one job can run at a time
            "groupId" TEXT NOT NULL,
            -- Current status of the job
            "status" "JobStatus" NOT NULL DEFAULT 'queued',
            -- When the latest job attempt began
            "lastStartedAt" TIMESTAMPTZ,
            -- When did job succeed or fail
            "finishedAt" TIMESTAMPTZ,
            -- How many times execution of the job was attempted
            "attempts" INTEGER NOT NULL DEFAULT 0,
            -- Job input
            "data" JSONB NOT NULL,
            -- Job output in case of success
            "result" JSONB,
            -- Error message in case of Job failure
            "error" JSONB,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        
            CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
        );
      
        -- CreateIndex
        CREATE INDEX "Job_queue_groupId_status_id_idx" ON "Job"("queue", "groupId", "status", "id");
         ```
       
    2. `QueueGroup`
        ```PostgreSQL
        -- CreateTable
        CREATE TABLE "QueueGroup" (
            "queue" TEXT NOT NULL,
            "groupId" TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      
            CONSTRAINT "QueueGroup_pkey" PRIMARY KEY ("queue","groupId")
        );
        ```
2. When job is added to the queue, we specify `groupId` and create two records: first, in the `QueueGroup` table (if not exist) and then in the `Job` table.

3. Job processor is regularly polling the `Job` and `QueueGroup` tables together to check if there are any new jobs. Polling happens with the `UPDATE` statement that atomically sets `status` to `started` for the picked job. The job is picked using a nested `SELECT` sub-query that does the following: 
    1. Pick one job for each `queue`/`groupId` pair with `SELECT DISTINCT ON` which is either `queued` or `started` (to allow retries).
    2. Join `QueueGroup` skipping locked Jobs and QueueGroups (i.e. already running jobs and concurrency groups).
    
   That way, only a job from a non-occupied concurrency group can be picked up.

4. Quickly after updating the job status, the job processor starts a transaction and locks both the job and its queue group with `SELECT FOR UPDATE` and keeps the transaction and this lock for the duration of the job handler.

5. When the job is succeeded or failed, the `UPDATE` statement is executed to save the job output, and transaction is committed. If the process crashes, the transaction is aborted. In any case, locks are freed and the next job can be picked up from the same concurrency group by the same or a different processor.

## TODO

- [ ] Test in a multiprocess setup. Currently, the test runs all producers and consumers in the same nodejs process 
- [ ] Load test the throughput
- [ ] Allow normal job queues if concurrency control is not needed
