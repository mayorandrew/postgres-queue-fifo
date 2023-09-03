import { Kysely, Selectable, Simplify, sql, Transaction } from 'kysely';
import type { DB, Job } from 'kysely-codegen';

/**
 * Queues new job for execution in a specific queue.
 * Returns job record including the job id.
 *
 * @param db - Kysely database interface
 * @param queue - queue name allows registering separate processors for different queues
 * @param groupId - group id determines the concurrency group, within each group id only one job can be executed at a time
 * @param data - job input data that is available for the processor during job execution
 */
export async function queueJob(
  db: Kysely<DB>,
  queue: string,
  groupId: string,
  data: object,
) {
  await db
    .insertInto('QueueGroup')
    .values({
      queue,
      groupId,
    })
    .onConflict((cb) =>
      cb.columns(['queue', 'groupId']).doUpdateSet({
        updatedAt: sql`now()`,
      }),
    )
    .execute();

  return await db
    .insertInto('Job')
    .values({
      queue,
      groupId,
      data: JSON.stringify(data),
    })
    .execute()
    .catch((cause) => {
      throw new Error('Error inserting job', { cause });
    });
}

async function startNextJob(db: Kysely<DB>, queues: '*' | string[]) {
  return await db.transaction().execute((trx) => {
    return trx
      .updateTable('Job')
      .set((eb) => ({
        status: 'started',
        lastStartedAt: eb.fn('now', []),
        attempts: eb('attempts', '+', 1),
        updatedAt: eb.fn('now', []),
      }))
      .where('id', 'in', (eb) =>
        eb
          .selectFrom('Job')
          .select('id')
          .innerJoin('QueueGroup', (join) =>
            join
              .onRef('Job.queue', '=', 'QueueGroup.queue')
              .onRef('Job.groupId', '=', 'QueueGroup.groupId'),
          )
          .where((eb) =>
            eb.and([
              eb('id', 'in', (eb) => {
                const f1 = eb
                  .selectFrom('Job')
                  .distinctOn(['queue', 'groupId'])
                  .select('id')
                  .where('status', 'in', ['queued', 'started']);

                const f2 =
                  queues === '*' ? f1 : f1.where('queue', 'in', queues);

                return f2.orderBy('queue').orderBy('groupId').orderBy('id');
              }),
              eb.or([
                eb('status', '=', 'queued'),
                eb.and([
                  eb('status', '=', 'started'),
                  eb('lastStartedAt', '<', sql`now() - interval '2 seconds'`),
                ]),
              ]),
            ]),
          )
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returningAll()
      .executeTakeFirst();
  });
}

function lockJob(trx: Transaction<DB>, job: Simplify<Selectable<Job>>) {
  return trx
    .selectFrom('Job')
    .selectAll()
    .innerJoin('QueueGroup', (join) =>
      join
        .onRef('QueueGroup.queue', '=', 'Job.queue')
        .onRef('QueueGroup.groupId', '=', 'Job.groupId'),
    )
    .where('id', '=', job.id)
    .limit(1)
    .forUpdate()
    .executeTakeFirst();
}

export interface ResultSucceeded {
  succeeded: {};
}

export interface ResultFailed {
  failed: {};
}

function succeedJob(
  trx: Transaction<DB>,
  result: ResultSucceeded,
  job: Simplify<Selectable<Job>>,
) {
  return trx
    .updateTable('Job')
    .set((eb) => ({
      status: 'succeeded',
      result: JSON.stringify(result.succeeded),
      finishedAt: eb.fn('now', []),
      updatedAt: eb.fn('now', []),
    }))
    .where('id', '=', job.id)
    .execute()
    .catch((cause) => {
      new Error('Error succeeding job', { cause });
    });
}

function failJob(
  trx: Transaction<DB>,
  result: ResultFailed,
  job: Simplify<Selectable<Job>>,
) {
  return trx
    .updateTable('Job')
    .set((eb) => ({
      status: 'failed',
      error: JSON.stringify(result.failed),
      finishedAt: eb.fn('now', []),
      updatedAt: eb.fn('now', []),
    }))
    .where('id', '=', job.id)
    .execute()
    .catch((cause) => {
      throw new Error('Error failing job', { cause });
    });
}

/**
 * Attempts to get the next available job from queue, locks it and starts its execution.
 *
 * @param db - Kysely database interface
 * @param queues - which queues to read the jobs from
 * @param cb - job processor callback that is executed if job was locked successfully
 *
 * @returns true if there was an available job in the queue, false if the queue is empty
 */
export async function tryRunNextJob(
  db: Kysely<DB>,
  queues: '*' | string[],
  cb: (job: Selectable<Job>) => Promise<ResultSucceeded | ResultFailed>,
) {
  const job = await startNextJob(db, queues);
  if (!job) return false;

  await db.transaction().execute(async (trx) => {
    const job2 = await lockJob(trx, job);
    if (!job2 || job2.status !== 'started') return;

    const result = await cb(job2);

    if ('succeeded' in result) {
      await succeedJob(trx, result, job);
    } else {
      await failJob(trx, result, job);
    }
  });

  return true;
}
