import { afterAll, beforeAll } from 'vitest';
import { createDemoServer, type DemoServer } from '../../fixtures/demo-app/server.mjs';

/** Boot the bundled demo app once per test file and hand out its origin. */
export function useDemoApp(port: number): { origin: () => string } {
  const holder: { server: DemoServer | null; url: string } = { server: null, url: '' };

  beforeAll(async () => {
    const server = createDemoServer({ port });
    const { url, close } = await server.listen();
    holder.server = server;
    holder.url = url;
    (holder as unknown as { close: () => Promise<void> }).close = close;
  });

  afterAll(async () => {
    const close = (holder as unknown as { close?: () => Promise<void> }).close;
    await close?.();
  });

  return { origin: () => holder.url };
}
