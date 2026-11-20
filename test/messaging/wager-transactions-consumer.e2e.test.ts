import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { eventually } from '../support/eventually';
import { createTestQueues, messagesInQueue, sendMessage, type TestQueues, testSqsClient, wagerMessage } from '../support/sqs';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';
import { defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import { AppModule } from '../../src/app.module';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { APP_CONFIG, loadConfig } from '../../src/infrastructure/config/app-config';

describe('SQS consumer inside the application', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let queues: TestQueues;
  let app: INestApplication;

  beforeAll(async () => {
    orm = await createTestOrm();
    sqs = testSqsClient();
    queues = await createTestQueues(sqs);
    const config = loadConfig();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...config,
        sqs: { wagerQueueName: queues.queueName, deadLetterQueueName: queues.dlqName, consumerEnabled: true },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await queues.remove();
    sqs.destroy();
    await orm.close();
  });

  test('a published message is processed end to end and closing the app stops the consumer', async () => {
    const unitOfWork = defaultUnitOfWork(orm);
    const wallet = await newWallet(wageringUseCases(orm, unitOfWork).createWallet, '100.00');
    const externalTransactionId = `tx-${randomUUID()}`;
    const data = {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    };

    await sendMessage(sqs, queues.queueUrl, wagerMessage(data), wallet.id);

    const transaction = await eventually(() =>
      unitOfWork.run(({ transactions }) => transactions.findByIdempotencyKey(data.providerId, data.idempotencyKey)),
    );
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    await eventually(async () => (await messagesInQueue(sqs, queues.queueUrl)) === 0);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);

    const closingAt = Date.now();
    await app.close();
    expect(Date.now() - closingAt).toBeLessThan(2_000);
  });
});
