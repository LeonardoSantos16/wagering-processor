import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

// Requires the docker-compose infrastructure (PostgreSQL + LocalStack) to be running.
describe('health endpoints', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /health/live returns 200', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  test('GET /health/ready returns 200 when PostgreSQL and SQS are reachable', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
  });

  test('responses carry a correlation id, reusing the caller one', async () => {
    const res = await fetch(`${baseUrl}/health/live`, {
      headers: { 'x-correlation-id': 'abc-123' },
    });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
  });
});
