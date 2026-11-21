import { Global, Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.aws.region,
          endpoint: config.aws.endpoint,
          credentials: {
            accessKeyId: config.aws.accessKeyId,
            secretAccessKey: config.aws.secretAccessKey,
          },
        }),
    },
  ],
  exports: [SQSClient],
})
export class SqsModule {}
