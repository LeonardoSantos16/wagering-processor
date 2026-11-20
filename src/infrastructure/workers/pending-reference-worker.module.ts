import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ResolvePendingReferenceUseCase } from '../../application/use-cases/resolve-pending-reference.use-case';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { WageringModule } from '../http/wagering/wagering.module';
import { PendingReferenceWorker } from './pending-reference.worker';
import { PollingLoop } from './polling-loop';

@Injectable()
export class PendingReferenceWorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private loop: PollingLoop | undefined;

  constructor(
    private readonly resolvePendingReference: ResolvePendingReferenceUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const { workerEnabled, batchSize, pollIntervalMs } = this.config.pendingReference;
    if (!workerEnabled) {
      return;
    }
    const worker = new PendingReferenceWorker(this.resolvePendingReference, { batchSize });
    this.loop = new PollingLoop(() => worker.runOnce(), {
      name: PendingReferenceWorker.name,
      intervalMs: pollIntervalMs,
    });
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }
}

@Module({
  imports: [WageringModule],
  providers: [PendingReferenceWorkerLifecycle],
})
export class PendingReferenceWorkerModule {}
