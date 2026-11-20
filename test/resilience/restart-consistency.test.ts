import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { AppCluster, type AppProcess } from '../support/app-process';
import { createTemporaryDatabase, rawSql } from '../support/database';
import { eventually } from '../support/eventually';
import { appEnvFor, countRows, type ResilienceInfra } from '../support/resilience';
import {
  createTestQueues,
  drainEvents,
  messagesInQueue,
  sendMessage,
  testSqsClient,
  wagerMessage,
} from '../support/sqs';
import { defaultUnitOfWork, newWallet, wageringUseCases } from '../support/wagering';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';
import type { Wallet } from '../../src/domain/wallet/wallet';

const CONSUMER_NAME = 'wager-transactions-consumer';
const MESSAGES_PER_WALLET = 10;
const HTTP_REQUESTS_PER_INSTANCE = 10;
const KILL_AFTER_TRANSACTIONS = 20;

interface HttpRequest {
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status?: number;
}

describe('every instance killed in the middle of the load, then restarted', () => {
  let sqs: SQSClient;
  let infra: ResilienceInfra;
  let cluster: AppCluster;

  beforeAll(async () => {
    sqs = testSqsClient();
    infra = {
      database: await createTemporaryDatabase('resilience_restart'),
      // Production limit: lock contention between HTTP and queue may cost a few receives.
      queues: await createTestQueues(sqs, { maxReceiveCount: 8, visibilityTimeoutSeconds: 5 }),
      events: await createTestQueues(sqs),
    };
    cluster = new AppCluster({
      ...appEnvFor(infra),
      SQS_CONSUMER_ENABLED: 'true',
      OUTBOX_PUBLISHER_ENABLED: 'true',
      PENDING_REFERENCE_WORKER_ENABLED: 'true',
    });
  });

  afterAll(async () => {
    await cluster.killAll();
    await infra.queues.remove();
    await infra.events.remove();
    await infra.database.drop();
    sqs.destroy();
  });

  const startInstances = (generation: string) =>
    Promise.all([1, 2, 3].map((n) => cluster.start(`${generation}-${n}`)));

  const submit = async (app: AppProcess, request: HttpRequest): Promise<void> => {
    const response = await fetch(`${app.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': request.idempotencyKey },
      body: JSON.stringify(request.payload),
    });
    await response.arrayBuffer();
    request.status = response.status;
  };

  // A provider sending its requests one after the other; it stops at the first one without an answer.
  const providerLane = async (app: AppProcess, requests: HttpRequest[]): Promise<void> => {
    for (const request of requests) {
      try {
        await submit(app, request);
      } catch {
        return;
      }
    }
  };

  test('the restarted instances finish the work with every effect applied exactly once', async () => {
    await cluster.explainFailure(async () => {
      const { orm } = infra.database;
      const unitOfWork = defaultUnitOfWork(orm);
      const { createWallet } = wageringUseCases(orm, unitOfWork);
      const wallets: Wallet[] = [];
      for (let i = 0; i < 3; i++) {
        wallets.push(await newWallet(createWallet, '1000.00'));
      }
      const shared = wallets[0]!;

      const messages = wallets.flatMap((wallet) =>
        Array.from({ length: MESSAGES_PER_WALLET }, (_, i) =>
          wagerMessage({
            providerId: 'provider-queue',
            externalTransactionId: `tx-${randomUUID()}`,
            idempotencyKey: `key-${randomUUID()}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `round-${i}`,
            gameId: 'game-1',
            kind: i % 2 === 0 ? 'BET' : 'WIN',
            money: { amount: i % 2 === 0 ? '3.00' : '2.00', currency: 'BRL' },
          }),
        ),
      );
      const lanes: HttpRequest[][] = [0, 1, 2].map(() =>
        Array.from({ length: HTTP_REQUESTS_PER_INSTANCE }, () => {
          const externalTransactionId = `tx-${randomUUID()}`;
          return {
            idempotencyKey: `key-${randomUUID()}`,
            payload: {
              providerId: 'provider-http',
              externalTransactionId,
              playerId: shared.playerId,
              walletId: shared.id,
              roundId: 'round-http',
              gameId: 'game-1',
              kind: 'BET',
              money: { amount: '1.00', currency: 'BRL' },
            },
          };
        }),
      );
      const httpRequests = lanes.flat();
      const expectedTransactions = messages.length + httpRequests.length;

      const firstGeneration = await startInstances('first');
      await Promise.all(messages.map((message) => sendMessage(sqs, infra.queues.queueUrl, message, message.data.walletId)));
      const providers = Promise.all(lanes.map((lane, i) => providerLane(firstGeneration[i]!, lane)));

      const processedBeforeKill = await eventually(async () => {
        const count = await countRows(
          orm,
          `select count(*) as count from wager_transaction where external_transaction_id is not null`,
        );
        return count >= KILL_AFTER_TRANSACTIONS && count;
      });
      await cluster.killAll();
      await providers;
      expect(processedBeforeKill).toBeLessThan(expectedTransactions);

      const secondGeneration = await startInstances('second');
      const unanswered = httpRequests.filter((request) => request.status === undefined);
      await Promise.all(unanswered.map((request, i) => submit(secondGeneration[i % 3]!, request)));
      expect(httpRequests.map((request) => request.status)).toEqual(httpRequests.map(() => 201));

      await eventually(
        async () =>
          (await messagesInQueue(sqs, infra.queues.queueUrl)) === 0 &&
          (await countRows(orm, `select count(*) as count from outbox_message where published_at is null`)) === 0,
        { timeoutMs: 60_000, intervalMs: 200 },
      );

      const transactions = (await rawSql(
        orm,
        `select external_transaction_id, status from wager_transaction where external_transaction_id is not null`,
      )) as { external_transaction_id: string; status: string }[];
      const expectedIds = [
        ...messages.map((message) => message.data.externalTransactionId),
        ...httpRequests.map((request) => String(request.payload.externalTransactionId)),
      ];
      expect(transactions.map((row) => row.external_transaction_id).sort()).toEqual(expectedIds.sort());
      expect(transactions.every((row) => row.status === 'PROCESSED')).toBe(true);

      const ledger = (await rawSql(
        orm,
        `select count(*) as count, count(distinct l.transaction_id) as distinct_transactions
           from wallet_ledger_entry l
           join wager_transaction t on t.id = l.transaction_id
          where t.external_transaction_id is not null`,
      )) as { count: string; distinct_transactions: string }[];
      expect(Number(ledger[0]!.count)).toBe(expectedTransactions);
      expect(Number(ledger[0]!.distinct_transactions)).toBe(expectedTransactions);

      const balances = (await rawSql(orm, `select id, balance from wallet where id in (?, ?, ?)`, [
        ...wallets.map((wallet) => wallet.id),
      ])) as { id: string; balance: string }[];
      const balanceOf = (wallet: Wallet) => balances.find((row) => row.id === wallet.id)!.balance;
      expect(balanceOf(shared)).toBe('965.00');
      expect(balanceOf(wallets[1]!)).toBe('995.00');
      expect(balanceOf(wallets[2]!)).toBe('995.00');
      for (const wallet of wallets) {
        await expectBalanceMatchesLedger(unitOfWork, wallet.id);
      }

      const inbox = (await rawSql(orm, `select message_id from inbox_message where consumer_name = ?`, [
        CONSUMER_NAME,
      ])) as { message_id: string }[];
      expect(inbox.map((row) => row.message_id).sort()).toEqual(messages.map((message) => message.messageId).sort());

      const outboxIds = ((await rawSql(orm, `select id from outbox_message`)) as { id: string }[]).map((row) => row.id);
      const received = new Set<string>();
      await eventually(
        async () => {
          for (const event of await drainEvents(sqs, infra.events.queueUrl)) {
            received.add(String(event.body.eventId));
          }
          return received.size >= outboxIds.length;
        },
        { timeoutMs: 60_000 },
      );
      expect([...received].sort()).toEqual(outboxIds.sort());

      expect(await messagesInQueue(sqs, infra.queues.dlqUrl)).toBe(0);
    });
  }, 180_000);
});
