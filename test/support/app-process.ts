import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { eventually } from './eventually';

const PROJECT_ROOT = join(import.meta.dir, '..', '..');

export type AppEnv = Record<string, string>;

export class AppProcess {
  private output = '';

  private constructor(
    readonly name: string,
    readonly baseUrl: string,
    private readonly child: Subprocess<'ignore', 'pipe', 'pipe'>,
  ) {
    void this.collect(child.stdout);
    void this.collect(child.stderr);
  }

  static async start(name: string, env: AppEnv): Promise<AppProcess> {
    const port = await freePort();
    const child = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env, PORT: String(port) },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const app = new AppProcess(name, `http://localhost:${port}`, child);
    await app.waitUntilReady();
    return app;
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  async kill(): Promise<void> {
    this.child.kill('SIGKILL');
    await this.child.exited;
  }

  describe(): string {
    return `--- ${this.name} (${this.baseUrl}) ---\n${this.output}`;
  }

  private async waitUntilReady(): Promise<void> {
    try {
      await eventually(
        async () => {
          if (this.exited) {
            throw new Error(`process exited with code ${this.child.exitCode}`);
          }
          const response = await fetch(`${this.baseUrl}/health/ready`);
          return response.ok;
        },
        { timeoutMs: 30_000, intervalMs: 100 },
      );
    } catch (error) {
      await this.kill();
      throw new Error(`${this.name} did not become ready: ${String(error)}\n${this.describe()}`);
    }
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.output += decoder.decode(chunk, { stream: true });
    }
  }
}

// Tracks the processes of one test file, so a failing test shows their output and nothing is left running.
export class AppCluster {
  private readonly processes: AppProcess[] = [];

  constructor(private readonly baseEnv: AppEnv) {}

  async start(name: string, env: AppEnv = {}): Promise<AppProcess> {
    const app = await AppProcess.start(name, { ...this.baseEnv, ...env });
    this.processes.push(app);
    return app;
  }

  async killAll(): Promise<void> {
    await Promise.all(this.processes.filter((app) => !app.exited).map((app) => app.kill()));
  }

  async explainFailure<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const output = this.processes.map((app) => app.describe()).join('\n');
      if (error instanceof Error) {
        error.message = `${error.message}\n\nApplication output:\n${output}`;
      }
      throw error;
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('could not allocate a port'));
        }
      });
    });
  });
}
