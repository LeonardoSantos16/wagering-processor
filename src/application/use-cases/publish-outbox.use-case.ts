import type { Clock } from '../ports/clock';
import type { EventPublisher, PublishFailure } from '../ports/event-publisher';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failures: PublishFailure[];
}

export class PublishOutboxUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  execute(limit: number): Promise<PublishOutboxResult> {
    return this.unitOfWork.run(async ({ outbox }) => {
      const due = await outbox.findDueForUpdate(this.clock.now(), limit);
      if (due.length === 0) {
        return { claimed: 0, published: 0, failures: [] };
      }

      let result;
      try {
        result = await this.publisher.publish(due);
      } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        result = { published: [], failures: due.map((message) => ({ id: message.id, reason })) };
      }

      const published = new Set(result.published);
      const at = this.clock.now();
      for (const message of due) {
        if (published.has(message.id)) {
          message.markPublished(at);
        } else {
          message.scheduleRetry(at);
        }
        await outbox.save(message);
      }
      return {
        claimed: due.length,
        published: due.filter((message) => !message.isPending()).length,
        failures: result.failures,
      };
    });
  }
}
