/**
 * Types for the demo application server so tests and the CLI can import it
 * directly from TypeScript while the runtime stays a plain `.mjs` file.
 */
export interface DemoListenResult {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface DemoServer {
  root: string;
  listen(port?: number): Promise<DemoListenResult>;
  close(): Promise<void>;
}

export interface DemoServerOptions {
  /** Directory to serve. Defaults to this package's `public/`. */
  dir?: string;
  /** Preferred port; falls back to an ephemeral one when busy. */
  port?: number;
  /** Quiet request logging. */
  quiet?: boolean;
}

export function createDemoServer(options?: DemoServerOptions): DemoServer;
