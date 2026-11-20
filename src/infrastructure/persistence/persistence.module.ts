import { Global, Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { CLOCK } from '../../application/ports/clock';
import { ID_GENERATOR } from '../../application/ports/id-generator';
import { UNIT_OF_WORK } from '../../application/ports/unit-of-work';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SystemClock } from '../system/system-clock';
import { UuidV7IdGenerator } from '../system/uuid-v7-id-generator';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

@Global()
@Module({
  providers: [
    {
      provide: UNIT_OF_WORK,
      inject: [EntityManager, APP_CONFIG],
      useFactory: (em: EntityManager, config: AppConfig) =>
        new MikroOrmUnitOfWork(em, { lockTimeoutMs: config.db.lockTimeoutMs }),
    },
    { provide: ID_GENERATOR, useClass: UuidV7IdGenerator },
    { provide: CLOCK, useClass: SystemClock },
  ],
  exports: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
})
export class PersistenceModule {}
