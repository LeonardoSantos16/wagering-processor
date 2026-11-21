import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { scrapedValue } from '../support/metrics';

describe('GET /metrics', () => {
  let app: INestApplication;
  let baseUrl: string;

  const scrape = async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    return res.text();
  };

  const newWallet = async (): Promise<{ id: string; playerId: string }> => {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: `player-${randomUUID()}`,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    return (await res.json()) as { id: string; playerId: string };
  };

  const submit = (payload: Record<string, unknown>, idempotencyKey: string) =>
    fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload),
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

  test('exposes the transaction, duplicate and latency metrics in Prometheus format', async () => {
    const wallet = await newWallet();
    const key = `key-${randomUUID()}`;
    const payload = {
      providerId: 'provider-a',
      externalTransactionId: `tx-${randomUUID()}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const before = await scrape();

    expect((await submit(payload, key)).status).toBe(201);
    expect((await submit(payload, key)).status).toBe(201);
    expect((await submit({ ...payload, money: { amount: '30.00', currency: 'BRL' } }, key)).status).toBe(409);

    const after = await scrape();
    const delta = (sample: string) => scrapedValue(after, sample) - scrapedValue(before, sample);
    expect(delta('wagering_transactions_total{status="PROCESSED"}')).toBe(1);
    expect(delta('wagering_duplicates_total{type="replay"}')).toBe(1);
    expect(delta('wagering_duplicates_total{type="idempotency_conflict"}')).toBe(1);
    expect(delta('wagering_processing_duration_seconds_count')).toBe(3);
    expect(after).toContain('wagering_outbox_lag_seconds ');
    expect(after).toContain('wagering_dlq_messages ');
  });
});
