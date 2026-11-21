import { describe, expect, test } from 'bun:test';
import { UuidV7IdGenerator } from './uuid-v7-id-generator';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UuidV7IdGenerator', () => {
  test('generates version 7 UUIDs', () => {
    expect(new UuidV7IdGenerator().next()).toMatch(UUID_V7);
  });

  test('generates ids that sort in creation order', () => {
    const generator = new UuidV7IdGenerator();
    const ids = Array.from({ length: 100 }, () => generator.next());

    expect([...ids].sort()).toEqual(ids);
  });
});
