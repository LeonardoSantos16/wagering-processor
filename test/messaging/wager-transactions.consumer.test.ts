import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { eventually } from '../support/eventually';
import {
  createTestQueues,
  messagesInQueue,
  receiveMessages,
  sendMessage,
  type TestQueues,
  testSqsClient,
  type WagerMessageData,
  wagerMessage,
} from '../support/sqs';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';
import { defaultUnitOfWork, deferred, newWallet, wageringUseCases } from '../support/wagering';
import { TemporarilyUnavailableError } from '../../src/application/errors/persistence.errors';
import type { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
  ProcessWagerTransactionUseCase,
} from '../../src/application/use-cases/process-wager-transaction.use-case';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { parseWagerTransactionMessage } from '../../src/infrastructure/messaging/wager-transaction-message';
import { WagerTransactionsConsumer } from '../../src/infrastructure/messaging/wager-transactions.consumer';

const CONSUMER = 'test-consumer';

setDefaultTimeout(20_000);

describe('WagerTransactionsConsumer', () => {
  let orm: MikroORM;
  let sqs: SQSClient;
  let unitOfWork: MikroOrmUnitOfWork;
  let createWallet: CreateWalletUseCase;
  let processTransaction: ProcessWagerTransactionUseCase;
  let queues: TestQueues;
  let consumer: WagerTransactionsConsumer;

  const dataFor = (wallet: Wallet, kind: string, amount: string): WagerMessageData => {
    const externalTransactionId = `tx-${randomUUID()}`;
    return {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind,
      money: { amount, currency: 'BRL' },
    };
  };

  const transactionOf = (data: WagerMessageData) =>
    unitOfWork.run(({ transactions }) => transactions.findByIdempotencyKey(data.providerId, data.idempotencyKey));

  const balanceOf = async (walletId: string) =>
    (await unitOfWork.run(({ wallets }) => wallets.findById(walletId)))!.balance.toJSON().amount;

  const startConsumer = (useCase: Pick<ProcessWagerTransactionUseCase, 'execute'> = processTransaction) => {
    consumer = new WagerTransactionsConsumer(sqs, useCase, {
      queueUrl: queues.queueUrl,
      dlqUrl: queues.dlqUrl,
      consumerName: CONSUMER,
    });
    consumer.start();
  };

  const recording = (useCase: ProcessWagerTransactionUseCase, gate?: Promise<void>) => {
    const outcomes: (ProcessWagerTransactionResult | Error)[] = [];
    const started = deferred();
    return {
      outcomes,
      started: started.promise,
      execute: async (command: ProcessWagerTransactionCommand) => {
        started.resolve();
        await gate;
        try {
          const result = await useCase.execute(command);
          outcomes.push(result);
          return result;
        } catch (error) {
          outcomes.push(error as Error);
          throw error;
        }
      },
    };
  };

  const holdWalletLock = (walletId: string) => {
    const release = deferred();
    const acquired = deferred();
    const held = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from wallet where id = ? for update', [walletId]);
      acquired.resolve();
      await release.promise;
    });
    return { acquired: acquired.promise, release: async () => { release.resolve(); await held; } };
  };

  const shortLockUseCase = () =>
    wageringUseCases(orm, new MikroOrmUnitOfWork(orm.em, { lockTimeoutMs: 200 })).processTransaction;

  const expectDeadLettered = async (body: string, route: 'consumer' | 'redrive') => {
    const received = await eventually(async () => {
      const messages = await receiveMessages(sqs, queues.dlqUrl);
      return messages.length > 0 && messages;
    });
    expect(received.map((message) => message.body)).toEqual([body]);
    if (route === 'consumer') {
      expect(received[0]!.failureReason).toBeString();
    } else {
      expect(received[0]!.failureReason).toBeUndefined();
    }
    await eventually(async () => (await messagesInQueue(sqs, queues.queueUrl)) === 0);
  };

  beforeAll(async () => {
    orm = await createTestOrm();
    sqs = testSqsClient();
    unitOfWork = defaultUnitOfWork(orm);
    ({ createWallet, processTransaction } = wageringUseCases(orm, unitOfWork));
  });

  beforeEach(async () => {
    queues = await createTestQueues(sqs);
  });

  afterEach(async () => {
    await consumer?.stop();
    await queues.remove();
  });

  afterAll(async () => {
    sqs.destroy();
    await orm.close();
  });

  test('processes a valid message and removes it from the queue', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const data = dataFor(wallet, 'BET', '30.00');
    startConsumer();

    await sendMessage(sqs, queues.queueUrl, wagerMessage(data), wallet.id);

    const transaction = await eventually(() => transactionOf(data));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    await eventually(async () => (await messagesInQueue(sqs, queues.queueUrl)) === 0);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a message redelivered after the commit and before the ack does not repeat the debit', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const message = wagerMessage(dataFor(wallet, 'BET', '30.00'));
    await processTransaction.execute(parseWagerTransactionMessage(JSON.stringify(message), CONSUMER));
    const useCase = recording(processTransaction);
    startConsumer(useCase);

    await sendMessage(sqs, queues.queueUrl, message, wallet.id);

    await eventually(async () => useCase.outcomes.length === 1 && (await messagesInQueue(sqs, queues.queueUrl)) === 0);
    expect((useCase.outcomes[0] as ProcessWagerTransactionResult).idempotentReplay).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a transient failure is retried after a backoff and then processed', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const data = dataFor(wallet, 'BET', '30.00');
    const lock = holdWalletLock(wallet.id);
    await lock.acquired;
    const useCase = recording(shortLockUseCase());
    startConsumer(useCase);

    await sendMessage(sqs, queues.queueUrl, wagerMessage(data), wallet.id);
    await eventually(async () => useCase.outcomes.length === 1);
    expect(useCase.outcomes[0]).toBeInstanceOf(TemporarilyUnavailableError);
    expect(await transactionOf(data)).toBeNull();
    await lock.release();

    const transaction = await eventually(() => transactionOf(data));
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    await eventually(async () => (await messagesInQueue(sqs, queues.queueUrl)) === 0);
    expect(useCase.outcomes).toHaveLength(2);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('a message that keeps failing transiently goes to the dead-letter queue after the receive limit', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const data = dataFor(wallet, 'BET', '30.00');
    const lock = holdWalletLock(wallet.id);
    await lock.acquired;
    const useCase = recording(shortLockUseCase());
    startConsumer(useCase);
    const body = JSON.stringify(wagerMessage(data));

    try {
      await sendMessage(sqs, queues.queueUrl, body, wallet.id);
      await expectDeadLettered(body, 'redrive');
    } finally {
      await lock.release();
    }
    expect(useCase.outcomes).toHaveLength(2);
    expect(useCase.outcomes.every((outcome) => outcome instanceof TemporarilyUnavailableError)).toBe(true);
    expect(await transactionOf(data)).toBeNull();
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test.each([
    ['a body that is not JSON', () => 'not json'],
    ['a payload failing validation', (data: WagerMessageData) => ({ ...wagerMessage(data), data: { ...data, walletId: 'x' } })],
    ['an OPENING submitted through the queue', (data: WagerMessageData) => wagerMessage({ ...data, kind: 'OPENING' })],
    ['an invalid amount', (data: WagerMessageData) => wagerMessage({ ...data, money: { amount: '10.5', currency: 'BRL' } })],
    ['an unknown wallet', (data: WagerMessageData) => wagerMessage({ ...data, walletId: randomUUID() })],
  ])('%s goes straight to the dead-letter queue', async (_, build) => {
    const wallet = await newWallet(createWallet, '100.00');
    const data = dataFor(wallet, 'BET', '30.00');
    const built = build(data);
    const body = typeof built === 'string' ? built : JSON.stringify(built);
    startConsumer();

    await sendMessage(sqs, queues.queueUrl, body, wallet.id);

    await expectDeadLettered(body, 'consumer');
    expect(await transactionOf(data)).toBeNull();
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('a message id reused with a different payload goes to the dead-letter queue', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const original = wagerMessage(dataFor(wallet, 'BET', '30.00'));
    const divergent = JSON.stringify(wagerMessage(dataFor(wallet, 'BET', '10.00'), original.messageId));
    startConsumer();
    await sendMessage(sqs, queues.queueUrl, original, wallet.id);
    await eventually(() => transactionOf(original.data));

    await sendMessage(sqs, queues.queueUrl, divergent, wallet.id);

    await expectDeadLettered(divergent, 'consumer');
    expect(await balanceOf(wallet.id)).toBe('70.00');
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('stop returns promptly while waiting on the long poll', async () => {
    startConsumer();

    const startedAt = Date.now();
    await consumer.stop();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('stop waits for the in-flight message to finish and acknowledges it', async () => {
    const wallet = await newWallet(createWallet, '100.00');
    const data = dataFor(wallet, 'BET', '30.00');
    const gate = deferred();
    const useCase = recording(processTransaction, gate.promise);
    startConsumer(useCase);
    await sendMessage(sqs, queues.queueUrl, wagerMessage(data), wallet.id);
    await useCase.started;

    const stopping = consumer.stop();
    gate.resolve();
    await stopping;

    expect((await transactionOf(data))?.status).toBe(WagerTransactionStatus.Processed);
    expect(await messagesInQueue(sqs, queues.queueUrl)).toBe(0);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });
});
