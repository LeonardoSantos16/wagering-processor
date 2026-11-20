import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { LoggerModule } from 'nestjs-pino';
import ormConfig from './infrastructure/persistence/mikro-orm.config';
import { ConfigModule } from './infrastructure/config/config.module';
import { loadConfig } from './infrastructure/config/app-config';
import { SqsModule } from './infrastructure/messaging/sqs.module';
import { HealthModule } from './infrastructure/http/health/health.module';
import { AuthGuard } from './infrastructure/http/auth/auth.guard';
import { GlobalExceptionFilter } from './infrastructure/http/errors/global-exception.filter';
import { WageringModule } from './infrastructure/http/wagering/wagering.module';
import { WalletsModule } from './infrastructure/http/wallets/wallets.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';

const CORRELATION_HEADER = 'x-correlation-id';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: loadConfig().logLevel,
        // Reuse the caller correlation id when present, otherwise generate one.
        genReqId: (req: IncomingMessage, res: ServerResponse) => {
          const header = req.headers[CORRELATION_HEADER];
          const correlationId = (Array.isArray(header) ? header[0] : header) || randomUUID();
          res.setHeader(CORRELATION_HEADER, correlationId);
          return correlationId;
        },
        customProps: (req: IncomingMessage) => ({ correlationId: req.id }),
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        serializers: {
          req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
        autoLogging: {
          ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false,
        },
      },
    }),
    MikroOrmModule.forRoot(ormConfig),
    PersistenceModule,
    SqsModule,
    HealthModule,
    WalletsModule,
    WageringModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
