import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';

describe('POST /wallets', () => {
  let app: INestApplication;
  let baseUrl: string;

  const createWallet = (body: unknown) =>
    fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app.close();
  });

  test('creates the wallet and returns 201 with its balance and version', async () => {
    const playerId = `player-${randomUUID()}`;

    const res = await createWallet({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('a second wallet for the same player and currency returns 409 WALLET_ALREADY_EXISTS', async () => {
    const playerId = `player-${randomUUID()}`;
    await createWallet({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });

    const res = await createWallet({ playerId, initialBalance: { amount: '20.00', currency: 'BRL' } });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ failureCode: 'WALLET_ALREADY_EXISTS', message: expect.any(String) });
  });

  test('a missing playerId returns 400 INVALID_PAYLOAD with the offending field', async () => {
    const res = await createWallet({ initialBalance: { amount: '10.00', currency: 'BRL' } });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { failureCode: string; details: { path: string }[] };
    expect(body.failureCode).toBe('INVALID_PAYLOAD');
    expect(body.details.map((detail) => detail.path)).toContain('playerId');
  });

  test('an amount without two decimal places returns 400 INVALID_MONEY', async () => {
    const res = await createWallet({
      playerId: `player-${randomUUID()}`,
      initialBalance: { amount: '10', currency: 'BRL' },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { failureCode: string }).failureCode).toBe('INVALID_MONEY');
  });

  test('a malformed JSON body returns 400 INVALID_PAYLOAD', async () => {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"playerId": ',
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { failureCode: string }).failureCode).toBe('INVALID_PAYLOAD');
  });
});
