import { Controller, Get, Global, Header, Module } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Registry } from 'prom-client';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { Public } from '../http/auth/public.decorator';
import { DatabaseAndQueueGaugeSources } from './gauge-sources';
import { WageringMetrics } from './wagering-metrics';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: WageringMetrics) {}

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: WageringMetrics,
      inject: [EntityManager, SQSClient, APP_CONFIG],
      useFactory: (em: EntityManager, sqs: SQSClient, config: AppConfig) =>
        new WageringMetrics(
          new Registry(),
          new DatabaseAndQueueGaugeSources(em.fork(), sqs, config.sqs.deadLetterQueueName),
        ),
    },
  ],
  exports: [WageringMetrics],
})
export class MetricsModule {}
