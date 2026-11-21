import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/id-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../application/ports/unit-of-work';
import { PendingReferencePolicy } from '../../../application/services/pending-reference-policy';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case';
import { ResolvePendingReferenceUseCase } from '../../../application/use-cases/resolve-pending-reference.use-case';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { GetWagerTransactionQuery } from '../../../application/queries/get-wager-transaction.query';
import { InstrumentedProcessWagerTransaction } from '../../metrics/instrumented-process-wager-transaction';
import { WageringMetrics } from '../../metrics/wagering-metrics';
import { ProviderTransactionsController } from './provider-transactions.controller';
import { WageringTransactionsController } from './wagering-transactions.controller';

@Module({
  controllers: [WageringTransactionsController, ProviderTransactionsController],
  providers: [
    {
      provide: GetWagerTransactionQuery,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWagerTransactionQuery(unitOfWork),
    },
    {
      provide: PendingReferencePolicy,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new PendingReferencePolicy({ ttlMs: config.pendingReference.ttlMs }),
    },
    {
      provide: InstrumentedProcessWagerTransaction,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, PendingReferencePolicy, WageringMetrics],
      useFactory: (
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        policy: PendingReferencePolicy,
        metrics: WageringMetrics,
      ) =>
        new InstrumentedProcessWagerTransaction(
          new ProcessWagerTransactionUseCase(unitOfWork, ids, clock, policy),
          metrics,
        ),
    },
    {
      provide: ResolvePendingReferenceUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, PendingReferencePolicy],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock, policy: PendingReferencePolicy) =>
        new ResolvePendingReferenceUseCase(unitOfWork, ids, clock, policy),
    },
  ],
  exports: [InstrumentedProcessWagerTransaction, ResolvePendingReferenceUseCase],
})
export class WageringModule {}
