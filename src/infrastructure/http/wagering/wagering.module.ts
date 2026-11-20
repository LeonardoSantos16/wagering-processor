import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/id-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../application/ports/unit-of-work';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case';
import { WageringTransactionsController } from './wagering-transactions.controller';

@Module({
  controllers: [WageringTransactionsController],
  providers: [
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new ProcessWagerTransactionUseCase(unitOfWork, ids, clock),
    },
  ],
  exports: [ProcessWagerTransactionUseCase],
})
export class WageringModule {}
