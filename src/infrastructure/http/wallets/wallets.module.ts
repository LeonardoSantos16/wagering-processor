import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from '../../../application/ports/id-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../application/ports/unit-of-work';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import { WalletsController } from './wallets.controller';

@Module({
  controllers: [WalletsController],
  providers: [
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        new CreateWalletUseCase(unitOfWork, ids, clock),
    },
  ],
})
export class WalletsModule {}
