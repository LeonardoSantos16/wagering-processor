import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { createTestOrm, rawSql } from '../support/database';

interface WalletBody {
  id: string;
  playerId: string;
}

interface LedgerPageBody {
  items: Record<string, unknown>[];
  nextCursor: string | null;
}

describe('query and reconciliation endpoints', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let baseUrl: string;

  const get = (path: string) => fetch(`${baseUrl}${path}`);
  const post = (path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const newWallet = async (amount: string): Promise<WalletBody> =>
    (await (
      await post('/wallets', { playerId: `player-${randomUUID()}`, initialBalance: { amount, currency: 'BRL' } })
    ).json()) as WalletBody;

  const submit = async (wallet: WalletBody, kind: string, amount: string, extra: Record<string, unknown> = {}) => {
    const externalTransactionId = `tx-${randomUUID()}`;
    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${externalTransactionId}` },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind,
        money: { amount, currency: 'BRL' },
        ...extra,
      }),
    });
    return { externalTransactionId, body: (await res.json()) as { transactionId: string; status: string } };
  };

  const failureOf = async (res: Response) => ({
    status: res.status,
    failureCode: ((await res.json()) as { failureCode?: string }).failureCode,
  });

  beforeAll(async () => {
    orm = await createTestOrm();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app.close();
    await orm.close();
  });

  describe('GET /wallets/:walletId', () => {
    test('returns the current balance and version in the same shape as POST /wallets', async () => {
      const wallet = await newWallet('100.00');
      await submit(wallet, 'BET', '40.00');

      const res = await get(`/wallets/${wallet.id}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        id: wallet.id,
        playerId: wallet.playerId,
        balance: { amount: '60.00', currency: 'BRL' },
        version: 2,
      });
    });

    test('an unknown wallet returns 404 WALLET_NOT_FOUND', async () => {
      expect(await failureOf(await get(`/wallets/${randomUUID()}`))).toEqual({
        status: 404,
        failureCode: 'WALLET_NOT_FOUND',
      });
    });

    test('a walletId that is not a UUID returns 400 INVALID_PAYLOAD', async () => {
      expect(await failureOf(await get('/wallets/not-a-uuid'))).toEqual({ status: 400, failureCode: 'INVALID_PAYLOAD' });
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    test('pages the history newest first until nextCursor is null', async () => {
      const wallet = await newWallet('100.00');
      const bet = await submit(wallet, 'BET', '10.00');
      const win = await submit(wallet, 'WIN', '5.00');

      const first = (await (await get(`/wallets/${wallet.id}/ledger?limit=2`)).json()) as LedgerPageBody;
      const second = (await (
        await get(`/wallets/${wallet.id}/ledger?limit=2&cursor=${first.nextCursor}`)
      ).json()) as LedgerPageBody;

      expect(first.items.map((item) => item.transactionId)).toEqual([
        win.body.transactionId,
        bet.body.transactionId,
      ]);
      expect(first.items[1]).toEqual({
        id: expect.any(String),
        transactionId: bet.body.transactionId,
        direction: 'DEBIT',
        amount: { amount: '10.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
        createdAt: expect.any(String),
      });
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(second.items.map((item) => item.direction)).toEqual(['CREDIT']);
      expect(second.nextCursor).toBeNull();
    });

    test('without limit returns up to 50 entries', async () => {
      const wallet = await newWallet('100.00');

      const page = (await (await get(`/wallets/${wallet.id}/ledger`)).json()) as LedgerPageBody;

      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });

    test.each(['0', '101', '1.5', 'abc'])('limit=%s returns 400 INVALID_PAYLOAD', async (limit) => {
      const wallet = await newWallet('100.00');

      expect(await failureOf(await get(`/wallets/${wallet.id}/ledger?limit=${limit}`))).toEqual({
        status: 400,
        failureCode: 'INVALID_PAYLOAD',
      });
    });

    test.each([
      ['not base64 JSON', 'garbage'],
      ['JSON without the expected fields', Buffer.from('{"c":"yesterday","i":"x"}').toString('base64url')],
    ])('a cursor that is %s returns 400 INVALID_PAYLOAD', async (_, cursor) => {
      const wallet = await newWallet('100.00');

      const res = await get(`/wallets/${wallet.id}/ledger?cursor=${cursor}`);

      expect(res.status).toBe(400);
      const body = (await res.json()) as { failureCode: string; details: { path: string }[] };
      expect(body.failureCode).toBe('INVALID_PAYLOAD');
      expect(body.details.map((detail) => detail.path)).toContain('cursor');
    });

    test('an unknown wallet returns 404 WALLET_NOT_FOUND', async () => {
      expect(await failureOf(await get(`/wallets/${randomUUID()}/ledger`))).toEqual({
        status: 404,
        failureCode: 'WALLET_NOT_FOUND',
      });
    });
  });

  describe('transaction lookups', () => {
    test('by id and by provider external id return the same query view', async () => {
      const wallet = await newWallet('100.00');
      const bet = await submit(wallet, 'BET', '25.00');

      const byId = await get(`/wagering/transactions/${bet.body.transactionId}`);
      const byExternalId = await get(`/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);

      expect(byId.status).toBe(200);
      expect(byExternalId.status).toBe(200);
      const view = await byId.json();
      expect(await byExternalId.json()).toEqual(view);
      expect(view).toEqual({
        transactionId: bet.body.transactionId,
        providerId: 'provider-a',
        externalTransactionId: bet.externalTransactionId,
        roundId: 'round-1',
        gameId: 'game-1',
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        status: 'PROCESSED',
        failureCode: null,
        referenceTransactionId: null,
        referenceExternalTransactionId: null,
        balance: { amount: '75.00', currency: 'BRL' },
        createdAt: expect.any(String),
        processedAt: expect.any(String),
        resolvedAt: expect.any(String),
      });
    });

    test('a rejected transaction shows its failureCode and a reversal shows its reference', async () => {
      const wallet = await newWallet('10.00');
      const rejected = await submit(wallet, 'BET', '50.00');
      const bet = await submit(wallet, 'BET', '5.00');
      const refund = await submit(wallet, 'REFUND', '5.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });

      const rejectedView = await (await get(`/wagering/transactions/${rejected.body.transactionId}`)).json();
      const refundView = await (await get(`/wagering/transactions/${refund.body.transactionId}`)).json();

      expect(rejectedView).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00', currency: 'BRL' },
        processedAt: null,
        resolvedAt: expect.any(String),
      });
      expect(refundView).toMatchObject({
        status: 'PROCESSED',
        referenceTransactionId: bet.body.transactionId,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
    });

    test('unknown transactions return 404 TRANSACTION_NOT_FOUND on both routes', async () => {
      expect(await failureOf(await get(`/wagering/transactions/${randomUUID()}`))).toEqual({
        status: 404,
        failureCode: 'TRANSACTION_NOT_FOUND',
      });
      expect(await failureOf(await get(`/providers/provider-a/wagering/transactions/tx-${randomUUID()}`))).toEqual({
        status: 404,
        failureCode: 'TRANSACTION_NOT_FOUND',
      });
    });

    test('the same external id under another provider is not found', async () => {
      const wallet = await newWallet('100.00');
      const bet = await submit(wallet, 'BET', '1.00');

      expect(
        (await get(`/providers/provider-b/wagering/transactions/${bet.externalTransactionId}`)).status,
      ).toBe(404);
    });

    test('a transactionId that is not a UUID returns 400 INVALID_PAYLOAD', async () => {
      expect(await failureOf(await get('/wagering/transactions/123'))).toEqual({
        status: 400,
        failureCode: 'INVALID_PAYLOAD',
      });
    });
  });

  describe('POST /wallets/:walletId/reconciliation', () => {
    test('a consistent wallet returns 200 with consistent true', async () => {
      const wallet = await newWallet('100.00');
      await submit(wallet, 'BET', '25.00');

      const res = await post(`/wallets/${wallet.id}/reconciliation`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: '75.00', currency: 'BRL' },
        calculatedBalance: { amount: '75.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
    });

    test('a divergent wallet returns 200 with consistent false and keeps the stored balance', async () => {
      const wallet = await newWallet('100.00');
      await rawSql(orm, 'update wallet set balance = ? where id = ?', ['110.00', wallet.id]);

      const res = await post(`/wallets/${wallet.id}/reconciliation`);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        storedBalance: { amount: '110.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '10.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(((await (await get(`/wallets/${wallet.id}`)).json()) as { balance: unknown }).balance).toEqual({
        amount: '110.00',
        currency: 'BRL',
      });
    });

    test('an unknown wallet returns 404 WALLET_NOT_FOUND', async () => {
      expect(await failureOf(await post(`/wallets/${randomUUID()}/reconciliation`))).toEqual({
        status: 404,
        failureCode: 'WALLET_NOT_FOUND',
      });
    });
  });
});
