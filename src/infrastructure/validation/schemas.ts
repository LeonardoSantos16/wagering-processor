import { z } from 'zod';

export const text = z.string().min(1).max(255);

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});
