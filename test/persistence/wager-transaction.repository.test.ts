import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm } from '../support/database';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/wallet/mikro-orm-wallet.repository';
import { FailureCode } from '../../src/domain/errors/failure-code';
import { Money } from '../../src/domain/money/money';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { Wallet } from '../../src/domain/wallet/wallet';

const CREATED = new Date('2026-01-01T10:00:00.000Z');
const RESOLVED = new Date('2026-01-01T10:00:01.000Z');
const RETRY_AT = new Date('2026-01-01T10:00:05.000Z');

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('MikroOrmWagerTransactionRepository', () => {
  let orm: MikroORM;
  let wallet: Wallet;

  const newContext = () => {
    const em = orm.em.fork();
    return { em, repository: new MikroOrmWagerTransactionRepository(em) };
  };

  const persist = async (transaction: WagerTransaction) => {
    const { em, repository } = newContext();
    await repository.save(transaction);
    await em.flush();
  };

  const load = (id: string) => newContext().repository.findById(id);

  const bet = (overrides: { kind?: WagerTransactionKind; reference?: string } = {}) => {
    const externalTransactionId = `tx-${randomUUID()}`;
    return WagerTransaction.create({
      id: randomUUID(),
      provider: {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        roundId: 'round-1',
        gameId: 'game-1',
      },
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: overrides.kind ?? WagerTransactionKind.Bet,
      money: brl('25.00'),
      referenceExternalTransactionId: overrides.reference,
      now: CREATED,
    });
  };

  beforeAll(async () => {
    orm = await createTestOrm();
    wallet = Wallet.open({
      id: randomUUID(),
      playerId: `player-${randomUUID()}`,
      initialBalance: brl('100.00'),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      now: CREATED,
    }).wallet;
    const em = orm.em.fork();
    await new MikroOrmWalletRepository(em).save(wallet);
    await em.flush();
  });

  afterAll(async () => {
    await orm.close();
  });

  test('round-trips a PROCESSED provider transaction', async () => {
    const transaction = bet();
    transaction.markProcessed({ balanceAfter: brl('75.00'), at: RESOLVED });
    await persist(transaction);

    const loaded = (await load(transaction.id))!;

    expect(loaded.provider).toEqual(transaction.provider);
    expect(loaded.walletId).toBe(wallet.id);
    expect(loaded.playerId).toBe(wallet.playerId);
    expect(loaded.kind).toBe(WagerTransactionKind.Bet);
    expect(loaded.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(loaded.referenceExternalTransactionId).toBeUndefined();
    expect(loaded.payloadHash).toBe(transaction.payloadHash!);
    expect(loaded.createdAt).toEqual(CREATED);
    expect(loaded.status).toBe(WagerTransactionStatus.Processed);
    expect(loaded.referenceTransactionId).toBeUndefined();
    expect(loaded.failureCode).toBeUndefined();
    expect(loaded.processedAt).toEqual(RESOLVED);
    expect(loaded.resolvedAt).toEqual(RESOLVED);
    expect(loaded.balanceAfter?.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(loaded.referenceAttempts).toBe(0);
    expect(loaded.nextReferenceAttemptAt).toBeUndefined();
  });

  test('round-trips an OPENING without provider data', async () => {
    const other = Wallet.open({
      id: randomUUID(),
      playerId: `player-${randomUUID()}`,
      initialBalance: brl('50.00'),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      now: CREATED,
    }).wallet;
    const { em, repository } = newContext();
    await new MikroOrmWalletRepository(em).save(other);
    const opening = WagerTransaction.opening({
      id: randomUUID(),
      walletId: other.id,
      playerId: other.playerId,
      money: brl('50.00'),
      now: CREATED,
    });
    await repository.save(opening);
    await em.flush();

    const loaded = (await load(opening.id))!;

    expect(loaded.kind).toBe(WagerTransactionKind.Opening);
    expect(loaded.provider).toBeUndefined();
    expect(loaded.payloadHash).toBeUndefined();
    expect(loaded.status).toBe(WagerTransactionStatus.Processed);
    expect(loaded.balanceAfter?.toJSON()).toEqual({ amount: '50.00', currency: 'BRL' });
  });

  test('round-trips a CURRENCY_MISMATCH rejection without balance', async () => {
    const transaction = bet();
    transaction.reject({ code: FailureCode.CurrencyMismatch, at: RESOLVED });
    await persist(transaction);

    const loaded = (await load(transaction.id))!;

    expect(loaded.status).toBe(WagerTransactionStatus.Rejected);
    expect(loaded.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(loaded.balanceAfter).toBeUndefined();
    expect(loaded.processedAt).toBeUndefined();
  });

  test('resolves a PENDING_REFERENCE transaction in a later context', async () => {
    const referenced = bet();
    referenced.markProcessed({ balanceAfter: brl('75.00'), at: RESOLVED });
    await persist(referenced);

    const refund = bet({
      kind: WagerTransactionKind.Refund,
      reference: referenced.provider!.externalTransactionId,
    });
    refund.markPendingReference(RETRY_AT);
    await persist(refund);

    const { em, repository } = newContext();
    const pending = (await repository.findById(refund.id))!;
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pending.nextReferenceAttemptAt).toEqual(RETRY_AT);
    pending.markProcessed({
      referenceTransactionId: referenced.id,
      balanceAfter: brl('100.00'),
      at: RETRY_AT,
    });
    await repository.save(pending);
    await em.flush();

    const loaded = (await load(refund.id))!;
    expect(loaded.status).toBe(WagerTransactionStatus.Processed);
    expect(loaded.referenceExternalTransactionId).toBe(referenced.provider!.externalTransactionId);
    expect(loaded.referenceTransactionId).toBe(referenced.id);
    expect(loaded.nextReferenceAttemptAt).toBeUndefined();
  });

  test('finds by idempotency key and by external id, scoped to the provider', async () => {
    const transaction = bet();
    transaction.markProcessed({ balanceAfter: brl('75.00'), at: RESOLVED });
    await persist(transaction);
    const { repository } = newContext();
    const { providerId, idempotencyKey, externalTransactionId } = transaction.provider!;

    expect((await repository.findByIdempotencyKey(providerId, idempotencyKey))?.id).toBe(
      transaction.id,
    );
    expect((await repository.findByExternalId(providerId, externalTransactionId))?.id).toBe(
      transaction.id,
    );
    expect(await repository.findByIdempotencyKey('provider-b', idempotencyKey)).toBeNull();
    expect(await repository.findByExternalId('provider-b', externalTransactionId)).toBeNull();
  });

  test('returns null for an unknown id', async () => {
    expect(await load(randomUUID())).toBeNull();
  });
});
