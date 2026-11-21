import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, rawSql } from '../support/database';
import { eventually } from '../support/eventually';
import { createTestQueues, drainEvents, type PublishedEvent, type TestQueues, testSqsClient } from '../support/sqs';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';
import { commandFor, defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import { AppModule } from '../../src/app.module';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { APP_CONFIG, loadConfig } from '../../src/infrastructure/config/app-config';

describe('out-of-order reference inside the application', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let app: INestApplication;

  beforeAll(async () => {
    orm = await createTestOrm();
    sqs = testSqsClient();
    queues = await createTestQueues(sqs);
    // The shared development database keeps the events written by earlier test runs, which nothing
    // has published. Mark them as published so the publisher only sees the events of this test.
    await rawSql(orm, 'update outbox_message set published_at = now(), next_attempt_at = null where published_at is null');

    const config = loadConfig();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        sqs: { ...config.sqs, eventsQueueName: queues.queueName, consumerEnabled: false },
        outbox: { ...config.outbox, publisherEnabled: true, pollIntervalMs: 100 },
        pendingReference: { ...config.pendingReference, workerEnabled: true, pollIntervalMs: 100 },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await queues.remove();
    sqs.destroy();
    await orm.close();
  });

  test('a ROLLBACK that arrives before its BET is resolved by the worker and its events are published', async () => {
    const unitOfWork = defaultUnitOfWork(orm);
    const { createWallet, processTransaction } = wageringUseCases(orm, unitOfWork);
    const wallet = await newWallet(createWallet, '100.00');
    const bet = commandFor(wallet, WagerTransactionKind.Bet, '30.00');
    const rollback = commandFor(wallet, WagerTransactionKind.Rollback, '30.00', {
      referenceExternalTransactionId: bet.provider.externalTransactionId,
    });

    const { transaction: pending } = await processTransaction.execute(rollback);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    const { transaction: betTransaction } = await processTransaction.execute(bet);

    const resolved = await eventually(async () => {
      const current = await unitOfWork.run(({ transactions }) => transactions.findById(pending.id));
      return current?.status === WagerTransactionStatus.Processed && current;
    });
    expect(resolved.referenceTransactionId).toBe(betTransaction.id);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);

    const received: PublishedEvent[] = [];
    const eventsOf = (transactionId: string) =>
      received
        .filter((event) => (event.body.data as { transactionId?: string }).transactionId === transactionId)
        .map((event) => event.eventType);
    await eventually(
      async () => {
        received.push(...(await drainEvents(sqs, queues.queueUrl)));
        return eventsOf(pending.id).length === 3 && eventsOf(betTransaction.id).length === 2;
      },
      { timeoutMs: 20_000 },
    );

    expect(eventsOf(pending.id).sort()).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(eventsOf(betTransaction.id).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const unpublished = (await rawSql(
      orm,
      `select count(*) as count from outbox_message where published_at is null and payload->'data'->>'walletId' = ?`,
      [wallet.id],
    )) as { count: string }[];
    expect(Number(unpublished[0]!.count)).toBe(0);
  });
});
