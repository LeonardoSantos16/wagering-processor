import type { Server } from 'bun';
import { loadConfig } from '../../src/infrastructure/config/app-config';

export interface HeldAction {
  intercepted: Promise<void>;
}

interface Hold {
  action: string;
  intercepted: () => void;
}

// Sits between an application process and LocalStack. Every call is forwarded, except the actions the
// test holds: those never get an answer, so the caller stays stuck at that exact point until it is killed.
export class SqsProxy {
  private readonly holds: Hold[] = [];

  private constructor(
    private readonly server: Server<undefined>,
    private readonly target: string,
  ) {}

  static start(target = loadConfig().aws.endpoint ?? 'http://localhost:4566'): SqsProxy {
    let proxy!: SqsProxy;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (request) => proxy.handle(request),
    });
    proxy = new SqsProxy(server, target.replace(/\/$/, ''));
    return proxy;
  }

  get url(): string {
    return `http://localhost:${this.server.port}`;
  }

  hold(action: string): HeldAction {
    let intercepted!: () => void;
    const promise = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    this.holds.push({ action, intercepted });
    return { intercepted: promise };
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    const action = request.headers.get('x-amz-target')?.replace('AmazonSQS.', '');
    const hold = this.holds.find((candidate) => candidate.action === action);
    if (hold) {
      hold.intercepted();
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()));
      return new Response(null, { status: 499 });
    }

    const { pathname, search } = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const upstream = await fetch(`${this.target}${pathname}${search}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    });
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: responseHeaders });
  }
}
