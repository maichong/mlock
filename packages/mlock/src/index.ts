import net from 'net';
import events from 'events';
import { URL } from 'url';
import PacketWrapper from 'packet-wrapper';
import { ClientOptions } from '..';

const pool: {
  [key: string]: MultiplexSocket;
} = Object.create(null);

export default class LockClient {
  clientId: string;
  socket: MultiplexSocket;
  lockCallbacks: { [key: string]: Function };

  constructor(options: string | ClientOptions) {
    this.clientId = generateId();
    this.lockCallbacks = Object.create(null);
    let socketId: string;
    let host: string;
    let port: number;
    if (typeof options === 'string') {
      let url = new URL(options);
      host = url.hostname;
      port = parseInt(url.port) || 12340;
    } else {
      socketId = options.socketId;
      host = options.host;
      port = options.port || 12340;
    }
    let key = `${host}:${port}`;
    if (!pool[key]) {
      pool[key] = new MultiplexSocket(host, port, socketId);
    }
    this.socket = pool[key];
    this.socket.addClient(this);
  }

  async lock(resource: string, ttl: number, timeout?: number, tolerate?: number): Promise<string> {
    await this.socket.connect();
    let lockId = await this.socket.lock(this, resource, ttl, timeout, tolerate);
    await new Promise((resolve, reject) => {
      this.lockCallbacks[lockId] = (error?: Error) => {
        delete this.lockCallbacks[lockId];
        error ? reject(error) : resolve();
      };
    });
    return lockId;
  }

  async extend(lockId: string, ttl: number): Promise<void> {
    await this.socket.connect();
    await this.socket.extend(lockId, ttl);
  }

  async unlock(lockId: string): Promise<void> {
    await this.socket.connect();
    await this.socket.unlock(lockId);
  }

  destroy() {
    if (this.socket) {
      this.socket.removeClient(this);
      delete this.socket;
      this.lockCallbacks = Object.create(null);
    }
  }
}

class MultiplexSocket extends events.EventEmitter {
  id: string;
  host: string;
  port: number;
  buffer: PacketWrapper;
  socket: net.Socket;
  _onConnect: () => void;
  _onError: (e: Error) => void;
  _waitConnect: Promise<void>;
  clients: LockClient[];
  retry: number;
  callbacks: {
    [requestId: string]: Function;
  };
  locks: {
    [lockId: string]: LockClient;
  };

  constructor(host: string, port: number, id?: string) {
    super();
    this.host = host;
    this.port = port;
    this.id = id || generateId();
    this.callbacks = Object.create(null);
    this.locks = Object.create(null);
    this.clients = [];
    this.connect();
  }

  connect(): Promise<void> {
    if (this._waitConnect) return this._waitConnect;
    this._waitConnect = new Promise((resolve, reject) => {
      this._onConnect = resolve;
      this._onError = reject;
    });
    this.retry = 3;
    this._connect();
    return this._waitConnect;
  }

  _connect() {
    this.buffer = new PacketWrapper();
    this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.socket.write(PacketWrapper.encode(Buffer.from(`connect ${this.id} 1.0`)));
    });
    this.socket.on('error', (e) => {
      // console.error('error', e);
      if (!this.retry) {
        this._waitConnect = null;
        this._onError(e);
      }
    });
    this.socket.on('close', () => {
      // 重新链接
      if (!this.retry || !this.clients.length) return;
      this.retry -= 1;
      setTimeout(() => {
        this._connect();
      }, 1000);
    });
    this.socket.on('data', this.onData);
  }

  onData = (chunk: Buffer) => {
    this.buffer.addChunk(chunk);
    let packet: Buffer;
    while ((packet = this.buffer.read())) {
      console.log('receive:', packet.toString());
      let args = packet.toString().split(' ');
      let cmd = args[0].toLowerCase();
      args.shift();
      switch (cmd) {
        case 'connected':
          this._onConnect();
          break;
        case 'error':
          this.retry = 0;
          this._waitConnect = null;
          this._onError(new Error(args[0]));
          break;
        case 'result':
          this.onResult(args[0], args[1], args.slice(2).join(' '));
          break;
        case 'locked':
          this.onLocked(args[0]);
          break;
        case 'timeout':
          this.onTimeout(args[0]);
          break;
        case 'expired':
          break;
        default:
          console.log('Unkown cmd:', cmd, args.join(' '));
      }
    }
  };

  onResult(requestId: string, success: string, result: string) {
    let fn = this.callbacks[requestId];
    if (!fn) return;
    delete this.callbacks[requestId];

    let error = null;
    let res;
    if (success === 'success') {
      res = result;
    } else {
      error = new Error(result);
    }
    fn(error, res);
  }

  onLocked(lockId: string) {
    let client = this.locks[lockId];
    if (!client) return;
    delete this.locks[lockId];
    let callback = client.lockCallbacks[lockId];
    if (!callback) return;
    callback();
  }

  onTimeout(lockId: string) {
    let client = this.locks[lockId];
    if (!client) return;
    delete this.locks[lockId];
    let callback = client.lockCallbacks[lockId];
    if (!callback) return;
    callback(new Error('Lock timeout'));
  }

  addClient(client: LockClient) {
    this.clients.push(client);
  }

  removeClient(client: LockClient) {
    let index = this.clients.indexOf(client);
    this.clients.splice(index, 1);
    for (let lockId in this.locks) {
      if (this.locks[lockId] === client) {
        delete this.locks[lockId];
      }
    }

    if (Object.keys(this.locks).length) return;
    setTimeout(() => {
      if (Object.keys(this.locks).length) return;
      this._waitConnect = null;
      this.socket.end();
    }, 1000);
  }

  write(message: string) {
    console.log('write:', message);
    this.socket.write(PacketWrapper.encode(Buffer.from(message)));
  }

  send(cmd: string, args: any[]): Promise<string> {
    let requestId = generateId();
    args = [cmd, requestId].concat(args);

    let onSuccess;
    let onError;
    this.callbacks[requestId] = (error: null | Error, result?: string) => {
      delete this.callbacks[requestId];
      error ? onError(error) : onSuccess(result);
    };
    let promise: Promise<string> = new Promise((resolve, reject) => {
      onSuccess = resolve;
      onError = reject;
    });

    this.write(args.join(' '));

    return promise;
  }

  // 调用lock命令，异步返回lock id
  async lock(
    client: LockClient,
    resource: string,
    ttl: number,
    timeout?: number,
    tolerate?: number
  ): Promise<string> {
    let lockId = await this.send('lock', [resource, ttl, timeout || 0, tolerate || 0]);
    this.locks[lockId] = client;
    return lockId;
  }

  extend(lockId: string, ttl: number) {
    return this.send('extend', [lockId, ttl]);
  }

  unlock(lockId: string) {
    return this.send('unlock', [lockId]);
  }
}

function generateId() {
  return Math.random().toString(16).substr(2);
}
