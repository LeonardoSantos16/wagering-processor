import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';

interface WalletBody {
  id: string;
  playerId: string;
}

describe('POST /wagering/transactions', () => {
  let app: INestApplication;
  let baseUrl: string;

  const newWallet = async (amount: string): Promise<WalletBody> => {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: `player-${randomUUID()}`, initialBalance: { amount, currency: 'BRL' } }),
    });
    return (await res.json()) as WalletBody;
  };

  const payloadFor = (wallet: WalletBody, overrides: Record<string, unknown> = {}) => ({
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  });

  const submit = (payload: Record<string, unknown>, idempotencyKey: string | null = `key-${randomUUID()}`) =>
    fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey !== null && { 'idempotency-key': idempotencyKey }),
      },
      body: JSON.stringify(payload),
    });

  const failureCodeOf = async (res: Response) => ((await res.json()) as { failureCode: string }).failureCode;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('recorded outcomes', () => {
    test('a processed BET returns 201 with the balance after it', async () => {
      const wallet = await newWallet('1000.00');

      const res = await submit(payloadFor(wallet));

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        idempotentReplay: false,
      });
    });

    test('repeating the request returns the same status and body flagged as a replay', async () => {
      const wallet = await newWallet('1000.00');
      const payload = payloadFor(wallet);
      const key = `key-${randomUUID()}`;
      const first = (await (await submit(payload, key)).json()) as Record<string, unknown>;

      const res = await submit(payload, key);

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ...first, idempotentReplay: true });
    });

    test('a BET above the balance returns 422 with the rejection recorded', async () => {
      const wallet = await newWallet('10.00');

      const res = await submit(payloadFor(wallet, { money: { amount: '50.00', currency: 'BRL' } }));

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        transactionId: expect.any(String),
        status: 'REJECTED',
        balance: { amount: '10.00', currency: 'BRL' },
        failureCode: 'INSUFFICIENT_FUNDS',
        idempotentReplay: false,
      });
    });

    test('a currency mismatch returns 422 without a balance', async () => {
      const wallet = await newWallet('10.00');

      const res = await submit(payloadFor(wallet, { money: { amount: '5.00', currency: 'USD' } }));

      expect(res.status).toBe(422);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.failureCode).toBe('CURRENCY_MISMATCH');
      expect(body.balance).toBeNull();
    });

    test('an unknown reference returns 202 PENDING_REFERENCE', async () => {
      const wallet = await newWallet('10.00');

      const res = await submit(
        payloadFor(wallet, { kind: 'REFUND', referenceExternalTransactionId: `missing-${randomUUID()}` }),
      );

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        transactionId: expect.any(String),
        status: 'PENDING_REFERENCE',
        balance: null,
        idempotentReplay: false,
      });
    });
  });

  describe('errors without a record', () => {
    test('a missing Idempotency-Key returns 400 MISSING_IDEMPOTENCY_KEY', async () => {
      const wallet = await newWallet('10.00');

      const res = await submit(payloadFor(wallet), null);

      expect(res.status).toBe(400);
      expect(await failureCodeOf(res)).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    test.each(['OPENING', 'XYZ'])('kind %s returns 400 INVALID_KIND', async (kind) => {
      const wallet = await newWallet('10.00');

      const res = await submit(payloadFor(wallet, { kind }));

      expect(res.status).toBe(400);
      expect(await failureCodeOf(res)).toBe('INVALID_KIND');
    });

    test('a REFUND without a reference returns 400 MISSING_REFERENCE', async () => {
      const wallet = await newWallet('10.00');

      const res = await submit(payloadFor(wallet, { kind: 'REFUND' }));

      expect(res.status).toBe(400);
      expect(await failureCodeOf(res)).toBe('MISSING_REFERENCE');
    });

    test('the same key with another payload returns 409 IDEMPOTENCY_CONFLICT', async () => {
      const wallet = await newWallet('100.00');
      const payload = payloadFor(wallet);
      const key = `key-${randomUUID()}`;
      await submit(payload, key);

      const res = await submit({ ...payload, money: { amount: '26.00', currency: 'BRL' } }, key);

      expect(res.status).toBe(409);
      expect(await failureCodeOf(res)).toBe('IDEMPOTENCY_CONFLICT');
    });

    test('an unknown wallet returns 422 WALLET_NOT_FOUND', async () => {
      const wallet = await newWallet('10.00');

      const res = await submit(payloadFor(wallet, { walletId: randomUUID() }));

      expect(res.status).toBe(422);
      expect(await failureCodeOf(res)).toBe('WALLET_NOT_FOUND');
    });

    test('a walletId that is not a UUID returns 400 INVALID_PAYLOAD', async () => {
      const wallet = await newWallet('10.00');

      const res = await submit(payloadFor(wallet, { walletId: 'not-a-uuid' }));

      expect(res.status).toBe(400);
      expect(await failureCodeOf(res)).toBe('INVALID_PAYLOAD');
    });
  });
});
