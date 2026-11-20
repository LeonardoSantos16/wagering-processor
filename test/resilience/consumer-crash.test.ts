import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { AppCluster } from '../support/app-process';
import { createTemporaryDatabase, rawSql } from '../support/database';
import { eventually } from '../support/eventually';
import { appEnvFor, countRows, type ResilienceInfra, within } from '../support/resilience';
import { createTestQueues, messagesInQueue, sendMessage, testSqsClient, wagerMessage } from '../support/sqs';
import { SqsProxy } from '../support/sqs-proxy';
import { defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';

const CONSUMER_NAME = 'wager-transactions-consumer';

describe('consumer killed after the commit and before the ack', () => {
  let sqs: SQSClient;
  let infra: ResilienceInfra;
  let proxy: SqsProxy;
  let cluster: AppCluster;

  beforeAll(async () => {
    sqs = testSqsClient();
    infra = {
      database: await createTemporaryDatabase('resilience_consumer'),
      queues: await createTestQueues(sqs, { maxReceiveCount: 2, visibilityTimeoutSeconds: 5 }),
      events: await createTestQueues(sqs),
    };
    proxy = SqsProxy.start();
    cluster = new AppCluster({ ...appEnvFor(infra), SQS_CONSUMER_ENABLED: 'true' });
  });

  afterAll(async () => {
    await cluster.killAll();
    await proxy.stop();
    await infra.queues.remove();
    await infra.events.remove();
    await infra.database.drop();
    sqs.destroy();
  });

  test('the redelivered message is taken by another instance without a second effect', async () => {
    await cluster.explainFailure(async () => {
      const { orm } = infra.database;
      const unitOfWork = defaultUnitOfWork(orm);
      const { createWallet } = wageringUseCases(orm, unitOfWork);
      const wallet = await newWallet(createWallet, '100.00');
      const message = wagerMessage({
        providerId: 'provider-a',
        externalTransactionId: `tx-${crypto.randomUUID()}`,
        idempotencyKey: `key-${crypto.randomUUID()}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      });

      const ack = proxy.hold('DeleteMessage');
      const first = await cluster.start('instance-a', { AWS_ENDPOINT: proxy.url });
      await sendMessage(sqs, infra.queues.queueUrl, message, wallet.id);
      await within(ack.intercepted, 30_000, 'the ack of instance-a');

      expect(
        await countRows(orm, `select count(*) as count from wager_transaction where external_transaction_id = ?`, [
          message.data.externalTransactionId,
        ]),
      ).toBe(1);
      expect(
        await countRows(orm, `select count(*) as count from inbox_message where consumer_name = ? and message_id = ?`, [
          CONSUMER_NAME,
          message.messageId,
        ]),
      ).toBe(1);

      await first.kill();
      await cluster.start('instance-b');

      await eventually(async () => (await messagesInQueue(sqs, infra.queues.queueUrl)) === 0, { timeoutMs: 30_000 });

      const transactions = (await rawSql(
        orm,
        `select id, status from wager_transaction where external_transaction_id = ?`,
        [message.data.externalTransactionId],
      )) as { id: string; status: string }[];
      expect(transactions).toHaveLength(1);
      expect(transactions[0]!.status).toBe('PROCESSED');
      expect(
        await countRows(orm, `select count(*) as count from wallet_ledger_entry where transaction_id = ?`, [
          transactions[0]!.id,
        ]),
      ).toBe(1);
      expect(
        await countRows(orm, `select count(*) as count from inbox_message where consumer_name = ? and message_id = ?`, [
          CONSUMER_NAME,
          message.messageId,
        ]),
      ).toBe(1);
      const balance = (await rawSql(orm, `select balance from wallet where id = ?`, [wallet.id])) as {
        balance: string;
      }[];
      expect(balance[0]!.balance).toBe('75.00');
      await expectBalanceMatchesLedger(unitOfWork, wallet.id);
      expect(await messagesInQueue(sqs, infra.queues.dlqUrl)).toBe(0);
    });
  }, 90_000);
});
