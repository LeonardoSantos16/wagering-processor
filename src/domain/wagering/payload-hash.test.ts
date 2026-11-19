import { describe, expect, test } from 'bun:test';
import { computePayloadHash, type PayloadHashFields } from './payload-hash';

const FIELDS: PayloadHashFields = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('computePayloadHash', () => {
  test('is the SHA-256 (hex) of the canonical JSON with sorted keys', () => {
    // Expected value computed independently: sha256 of the hand-written canonical JSON.
    expect(computePayloadHash(FIELDS)).toBe(
      '629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344',
    );
  });

  test('does not depend on key order', () => {
    const reordered: PayloadHashFields = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(FIELDS));
  });

  test('an absent reference and an undefined reference produce the same hash', () => {
    expect(computePayloadHash({ ...FIELDS, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(FIELDS),
    );
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'another-player' }],
    ['walletId', { walletId: 'another-wallet' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'another-game' }],
    ['kind', { kind: 'WIN' }],
    ['money amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['money currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['reference', { referenceExternalTransactionId: 'transaction-100' }],
  ])('changes when %s changes', (_, change) => {
    expect(computePayloadHash({ ...FIELDS, ...change })).not.toBe(computePayloadHash(FIELDS));
  });
});
