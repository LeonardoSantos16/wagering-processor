import { Registry } from 'prom-client';
import { type GaugeSources, WageringMetrics } from '../../src/infrastructure/metrics/wagering-metrics';

export function testMetrics(sources: Partial<GaugeSources> = {}): WageringMetrics {
  return new WageringMetrics(new Registry(), {
    outboxLagSeconds: async () => 0,
    dlqMessages: async () => 0,
    ...sources,
  });
}

export async function metricValue(
  metrics: WageringMetrics,
  name: string,
  labels: Record<string, string> = {},
): Promise<number | undefined> {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) {
    throw new Error(`metric ${name} is not registered`);
  }
  const { values } = await metric.get();
  return values.find((value) =>
    Object.entries(labels).every(([key, expected]) => value.labels[key] === expected),
  )?.value;
}

export function scrapedValue(body: string, sample: string): number {
  const line = body.split('\n').find((candidate) => candidate.startsWith(`${sample} `));
  return line ? Number(line.slice(sample.length + 1)) : 0;
}
