import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { LoggerModule } from 'nestjs-pino';
import ormConfig from './mikro-orm.config';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { SqsModule } from './messaging/sqs.module';
import { HealthModule } from './health/health.module';
import { AuthGuard } from './auth/auth.guard';

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
        // Never log credentials or full request/response bodies.
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
    SqsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
