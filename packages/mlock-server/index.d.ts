import * as net from 'net';

export interface ServerOptions {
  port?: number;
  debug?: boolean;
}

export default class Server {
  server: net.Server;
  options: ServerOptions;

  constructor(options: ServerOptions);

  listen(): Promise<void>;
  close(): Promise<void>;
}
