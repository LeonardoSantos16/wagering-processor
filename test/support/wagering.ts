import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/use-cases/process-wager-transaction.use-case';
import { Money } from '../../src/domain/money/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7IdGenerator } from '../../src/infrastructure/system/uuid-v7-id-generator';

export const PRODUCTION_LOCK_TIMEOUT_MS = 2000;

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export function wageringUseCases(orm: MikroORM, unitOfWork: UnitOfWork = defaultUnitOfWork(orm)) {
  const ids = new UuidV7IdGenerator();
  const clock = { now: () => new Date() };
  return {
    createWallet: new CreateWalletUseCase(unitOfWork, ids, clock),
    processTransaction: new ProcessWagerTransactionUseCase(unitOfWork, ids, clock),
  };
}

export function defaultUnitOfWork(orm: MikroORM): MikroOrmUnitOfWork {
  return new MikroOrmUnitOfWork(orm.em, { lockTimeoutMs: PRODUCTION_LOCK_TIMEOUT_MS });
}

export function newWallet(createWallet: CreateWalletUseCase, amount: string): Promise<Wallet> {
  return createWallet.execute({
    playerId: `player-${randomUUID()}`,
    initialBalance: brl(amount),
    correlationId: randomUUID(),
  });
}

export function commandFor(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    provider: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      roundId: 'round-1',
      gameId: 'game-1',
    },
    walletId: wallet.id,
    playerId: wallet.playerId,
    kind,
    money: brl(amount),
    correlationId: `corr-${randomUUID()}`,
    ...overrides,
  };
}

export const betFor = (wallet: Wallet, amount: string) => commandFor(wallet, WagerTransactionKind.Bet, amount);

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
