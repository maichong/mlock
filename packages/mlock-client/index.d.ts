export interface ClientOptions {
  socketId?: string;
  host: string;
  port?: number;
  prefix?: string;
  debug?: boolean;
}

export default class Client {
  constructor(options: string | ClientOptions);

  lock(resource: string, ttl: number, timeout?: number, tolerate?: number): Promise<string>;

  extend(lock: string, ttl: number): Promise<void>;

  unlock(lock: string): Promise<void>;
}
