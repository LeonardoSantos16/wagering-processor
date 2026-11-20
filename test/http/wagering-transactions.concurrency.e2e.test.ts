import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { createTestOrm } from '../support/database';
import { defaultUnitOfWork } from '../support/wagering';
import { expectBalanceMatchesLedger } from '../support/wallet-invariants';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import type { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';

interface WalletBody {
  id: string;
  playerId: string;
}

interface TransactionBody {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string } | null;
  failureCode?: string;
  idempotentReplay: boolean;
}

describe('POST /wagering/transactions under concurrency', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let unitOfWork: MikroOrmUnitOfWork;

  const newWallet = async (amount: string): Promise<WalletBody> => {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: `player-${randomUUID()}`, initialBalance: { amount, currency: 'BRL' } }),
    });
    return (await res.json()) as WalletBody;
  };

  const betPayload = (wallet: WalletBody, amount: string) => ({
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  });

  const submit = async (payload: Record<string, unknown>, idempotencyKey: string) => {
    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as TransactionBody };
  };

  const balanceOf = async (walletId: string) =>
    (await unitOfWork.run(({ wallets }) => wallets.findById(walletId)))!.balance.toJSON().amount;
  const debitsOf = async (walletId: string) =>
    (await unitOfWork.run(({ ledger }) => ledger.findByWallet(walletId))).filter(
      (entry) => entry.direction === LedgerDirection.Debit,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
    orm = await createTestOrm();
    unitOfWork = defaultUnitOfWork(orm);
  });

  afterAll(async () => {
    await app.close();
    await orm.close();
  });

  test('the same BET sent 50 times in parallel returns one original and 49 identical replays', async () => {
    const wallet = await newWallet('100.00');
    const payload = betPayload(wallet, '10.00');
    const key = `key-${randomUUID()}`;

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(payload, key)));

    expect(responses.every((res) => res.status === 201)).toBe(true);
    const originals = responses.filter((res) => !res.body.idempotentReplay);
    expect(originals).toHaveLength(1);
    const { idempotentReplay: _, ...original } = originals[0]!.body;
    expect(original).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '90.00', currency: 'BRL' },
    });
    for (const res of responses) {
      expect(res.body).toEqual({ ...original, idempotentReplay: res.body.idempotentReplay });
    }
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect((await debitsOf(wallet.id)).map((entry) => entry.transactionId)).toEqual([original.transactionId]);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });

  test('two BETs of 80 against a balance of 100 at the same time return 201 and 422', async () => {
    const wallet = await newWallet('100.00');

    const responses = await Promise.all([
      submit(betPayload(wallet, '80.00'), `key-${randomUUID()}`),
      submit(betPayload(wallet, '80.00'), `key-${randomUUID()}`),
    ]);

    expect(responses.map((res) => res.status).sort()).toEqual([201, 422]);
    const rejected = responses.find((res) => res.status === 422)!;
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(rejected.body.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(await balanceOf(wallet.id)).toBe('20.00');
    expect(await debitsOf(wallet.id)).toHaveLength(1);
    await expectBalanceMatchesLedger(unitOfWork, wallet.id);
  });
});
