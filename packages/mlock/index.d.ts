export interface ClientOptions {
  socketId?: string;
  host: string;
  port?: number;
}

export default class LockClient {
  constructor(options: string | ClientOptions);

  lock(resource: string, ttl: number, timeout?: number, tolerate?: number): Promise<string>;

  extend(lock: string, ttl: number): Promise<void>;

  unlock(lock: string): Promise<void>;
}
