import { randomUUIDv7 } from 'bun';
import type { IdGenerator } from '../../application/ports/id-generator';

export class UuidV7IdGenerator implements IdGenerator {
  next(): string {
    return randomUUIDv7();
  }
}
