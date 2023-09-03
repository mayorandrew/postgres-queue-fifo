import testLib, { TestFn } from 'ava';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import dotenv from 'dotenv';
import type { DB } from 'kysely-codegen';
import { queueJob, tryRunNextJob } from '../src/index.js';
import * as fs from 'fs/promises';

dotenv.config();

const timeoutPromise = (delay: number) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), delay));

function nMap<T>(count: number, cb: (index: number) => T): T[] {
  const result = new Array(count);
  for (let i = 0; i < count; i++) {
    result[i] = cb(i);
  }
  return result;
}

const randomInt = (from: number, size: number) =>
  Math.floor(Math.random() * size + from);

interface Context {
  db: Kysely<DB>;
}

const test = testLib as TestFn<Context>;

test.before(async (t) => {
  t.context.db = new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: process.env.DATABASE_URL,
      }),
    }),
  });
});

interface ScaffoldParams {
  nQueues: number;
  nGroups: number;
  nProducerJobs: number;
  nProducers: number;
  producerStrategy?: 'even' | 'random';
  producerDelay?: () => number;
  saveLog?: boolean;
  run: (params: {
    producer: (n: number) => Promise<void>;
    consumer: (n: number) => Promise<void>;
  }) => Promise<void>;
}

const scaffold = test.macro(async (t, params: ScaffoldParams) => {
  const { db } = t.context;
  const { nQueues, nGroups, nProducerJobs, nProducers } = params;
  const producerStrategy = params.producerStrategy ?? 'even';
  let jobsProcessed = 0;

  const queues = nMap(nQueues, (i) => `${i + 1}`);
  const groups = nMap(nGroups, (i) =>
    String.fromCharCode('a'.charCodeAt(0) + i),
  );

  const queuedJobs: Record<string, Record<string, number>> = {};
  const ranJobs: Record<string, Record<string, number>> = {};
  const runningJobs: Record<string, Record<string, boolean>> = {};
  for (const q of queues) {
    ranJobs[q] = {};
    queuedJobs[q] = {};
    runningJobs[q] = {};
    for (const g of groups) {
      ranJobs[q][g] = 0;
      queuedJobs[q][g] = 0;
      runningJobs[q][g] = false;
    }
  }

  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  try {
    await db
      .deleteFrom('Job')
      .where(() => sql`true`)
      .execute()
      .catch((cause) => {
        throw new Error('Error deleting jobs', { cause });
      });

    await db
      .deleteFrom('QueueGroup')
      .where(() => sql`true`)
      .execute()
      .catch((cause) => {
        throw new Error('Error deleting queue groups', { cause });
      });

    log('sequenceDiagram');

    for (let i = 0; i < nQueues; i++) {
      log(`participant Q${i + 1}`);
    }

    const start = performance.now();
    const time = () => Math.floor(performance.now() - start);

    const strategyEven = () => {
      let iQueue = 0;
      let iGroup = 0;
      return () => {
        const queue = queues[iQueue];
        const group = groups[iGroup];

        iGroup++;
        if (iGroup === groups.length) {
          iGroup = 0;
          iQueue++;
          if (iQueue === queues.length) {
            iQueue = 0;
          }
        }

        return [queue, group] as const;
      };
    };

    const strategyRandom = () => () =>
      [
        queues[randomInt(0, queues.length)],
        groups[randomInt(0, groups.length)],
      ] as const;

    async function producer(n: number) {
      const P = `P${n}`;
      log(`participant ${P}`);

      const nextQueueGroup = (
        producerStrategy === 'even' ? strategyEven : strategyRandom
      )();

      for (let i = 0; i < nProducerJobs; i++) {
        const [queue, group] = nextQueueGroup();

        const j = `${n}.${i}`;
        await queueJob(db, queue, group, { jobId: j });
        queuedJobs[queue][group]++;
        log(`${P} -) Q${queue}: [${time()}] q=${queue} g=${group} j=${j}`);

        if (params.producerDelay) {
          await timeoutPromise(params.producerDelay());
        }
      }
    }

    async function consumer(n: number) {
      const C = `C${n}`;
      log(`participant ${C}`);
      while (jobsProcessed < nProducerJobs * nProducers) {
        const nonEmpty = await tryRunNextJob(db, '*', async (job) => {
          const { queue, groupId } = job;
          const Q = `Q${queue}`;
          const { jobId } = job.data as any;
          const jobTime = randomInt(0, 10);

          if (runningJobs[queue][groupId]) {
            throw new Error(`q=${queue} g=${groupId} is already running`);
          }

          runningJobs[queue][groupId] = true;
          const value = ranJobs[queue][groupId];
          log(`${Q} ->>+ ${C}: [${time()}] q=${queue} g=${groupId} j=${jobId}`);
          log(
            `Note over ${C}: [${time()}] ${jobTime} ms | q=${queue} | g=${groupId} | v=${value}`,
          );
          await timeoutPromise(jobTime);
          ranJobs[queue][groupId] = value + 1;
          runningJobs[queue][groupId] = false;

          jobsProcessed++;
          log(
            `${C} -->>- ${Q}: [${time()}] q=${queue} g=${groupId} j=${jobId}`,
          );
          return { succeeded: {} };
        });

        if (!nonEmpty) {
          const wait = randomInt(10, 10);
          await timeoutPromise(wait);
          log(`Note over ${C}: [${time()}] Wait ${wait} ms`);
        }
      }
      log(`Note over ${C}: [${time()}] Exited`);
    }

    await params.run({
      producer,
      consumer,
    });

    // We're checking that counters were incremented correctly which is
    // the main indicator that no two jobs were running concurrently within
    // the same group.
    // If that was the case, some increments would be lost
    // because we're reading the value at the beginning of the job,
    // and the amount of ran jobs will be less than queued jobs.
    const res = t.deepEqual(ranJobs, queuedJobs);
    if (!res) {
      return true;
    }
  } finally {
    if (params.saveLog) {
      const filename = import.meta.url.match(/^file:\/\/(.*)$/)?.[1];
      if (filename) {
        await fs.writeFile(
          filename + t.title.replaceAll(/\s/g, '_') + '.mermaid',
          logs.join('\n'),
        );
      }
    }
  }
});

for (let i = 0; i < 100; i++) {
  test.serial(`2q, 5g, 10c, 1p, 50j, producer first [${i}]`, scaffold, {
    nQueues: 2,
    nGroups: 5,
    nProducerJobs: 50,
    nProducers: 1,
    saveLog: true,
    async run({ producer, consumer }) {
      await producer(1);
      await Promise.all([...nMap(10, (i) => consumer(i + 1))]);
    },
  });
}

for (let i = 0; i < 100; i++) {
  test.serial(`2q, 5g, 10c, 2p, 50j, producer parallel [${i}]`, scaffold, {
    nQueues: 2,
    nGroups: 5,
    nProducerJobs: 50,
    nProducers: 2,
    saveLog: true,
    producerDelay: () => randomInt(1, 5),
    async run({ producer, consumer }) {
      await Promise.all([
        ...nMap(2, (i) => producer(i + 1)),
        ...nMap(10, (i) => consumer(i + 1)),
      ]);
    },
  });
}

test.serial(`2q, 5g, 10c, 2p, 6000j, producer random`, scaffold, {
  nQueues: 2,
  nGroups: 5,
  nProducerJobs: 6000,
  nProducers: 2,
  saveLog: false,
  producerStrategy: 'random',
  producerDelay: () => randomInt(1, 5),
  async run({ producer, consumer }) {
    await Promise.all([
      ...nMap(2, (i) => producer(i + 1)),
      ...nMap(10, (i) => consumer(i + 1)),
    ]);
  },
});

test.after.always(async (t) => {
  await t.context.db.destroy();
});
