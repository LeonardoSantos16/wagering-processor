import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { AppCluster } from '../support/app-process';
import { createTemporaryDatabase, rawSql } from '../support/database';
import { eventually } from '../support/eventually';
import { appEnvFor, countRows, type ResilienceInfra, within } from '../support/resilience';
import { createTestQueues, drainEvents, testSqsClient } from '../support/sqs';
import { SqsProxy } from '../support/sqs-proxy';
import { betFor, defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';

describe('publisher killed after the commit and before publishing', () => {
  let sqs: SQSClient;
  let infra: ResilienceInfra;
  let proxy: SqsProxy;
  let cluster: AppCluster;

  beforeAll(async () => {
    sqs = testSqsClient();
    infra = {
      database: await createTemporaryDatabase('resilience_publisher'),
      queues: await createTestQueues(sqs),
      events: await createTestQueues(sqs),
    };
    proxy = SqsProxy.start();
    cluster = new AppCluster({ ...appEnvFor(infra), OUTBOX_PUBLISHER_ENABLED: 'true' });
  });

  afterAll(async () => {
    await cluster.killAll();
    await proxy.stop();
    await infra.queues.remove();
    await infra.events.remove();
    await infra.database.drop();
    sqs.destroy();
  });

  test('another instance publishes the events the dead one had reserved', async () => {
    await cluster.explainFailure(async () => {
      const { orm } = infra.database;
      const unitOfWork = defaultUnitOfWork(orm);
      const { createWallet, processTransaction } = wageringUseCases(orm, unitOfWork);
      const wallet = await newWallet(createWallet, '100.00');
      await processTransaction.execute(betFor(wallet, '25.00'));
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
      const outboxIds = ((await rawSql(orm, `select id from outbox_message`)) as { id: string }[]).map((row) => row.id);
      expect(outboxIds.length).toBeGreaterThan(0);

      const publish = proxy.hold('SendMessageBatch');
      const first = await cluster.start('instance-a', {
        AWS_ENDPOINT: proxy.url,
        // Long enough that instance-a is still inside the transaction when it is killed.
        OUTBOX_PUBLISH_TIMEOUT_MS: '60000',
      });
      await within(publish.intercepted, 30_000, 'the publication of instance-a');

      const unlocked = (await rawSql(
        orm,
        `select id from outbox_message where published_at is null for update skip locked`,
      )) as { id: string }[];
      expect(unlocked).toEqual([]);
      expect(await countRows(orm, `select count(*) as count from outbox_message where published_at is null`)).toBe(
        outboxIds.length,
      );

      await first.kill();
      await cluster.start('instance-b');

      await eventually(
        async () =>
          (await countRows(orm, `select count(*) as count from outbox_message where published_at is null`)) === 0,
        { timeoutMs: 30_000 },
      );
      const received = new Set<string>();
      await eventually(
        async () => {
          for (const event of await drainEvents(sqs, infra.events.queueUrl)) {
            received.add(String(event.body.eventId));
          }
          return received.size >= outboxIds.length;
        },
        { timeoutMs: 30_000 },
      );
      expect([...received].sort()).toEqual([...outboxIds].sort());
    });
  }, 90_000);
});
