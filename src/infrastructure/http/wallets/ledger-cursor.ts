import { z } from 'zod';
import type { LedgerPosition } from '../../../application/ports/wallet-ledger.repository';

const cursorSchema = z.object({ c: z.iso.datetime(), i: z.uuid() });

export function encodeLedgerCursor(position: LedgerPosition): string {
  return Buffer.from(JSON.stringify({ c: position.createdAt.toISOString(), i: position.id })).toString(
    'base64url',
  );
}

export function decodeLedgerCursor(cursor: string): LedgerPosition | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = cursorSchema.safeParse(decoded);
  return parsed.success ? { createdAt: new Date(parsed.data.c), id: parsed.data.i } : undefined;
}
