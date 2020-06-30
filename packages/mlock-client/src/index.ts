import net from 'net';
import events from 'events';
import { URL } from 'url';
import PacketWrapper from 'packet-wrapper';
import { ClientOptions } from '..';

const pool: {
  [key: string]: MultiplexSocket;
} = Object.create(null);

export default class Client {
  clientId: string;
  socket: MultiplexSocket;
  lockCallbacks: { [key: string]: Function };
  options: ClientOptions;

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
      this.options = { host, port };
    } else {
      if (options.prefix?.includes(',') || options.prefix?.includes(' ')) {
        throw new Error('prefix can not includes "," or " "');
      }
      this.options = options;
      socketId = options.socketId;
      host = options.host;
      port = options.port || 12340;
    }
    let key = `${host}:${port}`;
    if (!pool[key]) {
      pool[key] = new MultiplexSocket(host, port, socketId, this.options.debug);
    }
    this.socket = pool[key];
    this.socket.addClient(this);
  }

  async lock(resource: string, ttl: number, timeout?: number, tolerate?: number): Promise<string> {
    if (this.options.debug) {
      console.log(`try to lock ${resource} ttl:${ttl}`);
    }
    if (resource.includes(' ')) throw new Error('resource can not includes " "');
    await this.socket.connect();
    if (this.options.prefix) {
      if (resource.includes(',')) {
        resource = resource
          .split(',')
          .map((r) => this.options.prefix + r)
          .join(',');
      } else {
        resource = this.options.prefix + resource;
      }
    }
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
    if (this.options.debug) {
      console.log(`try to extend ${lockId} ttl:${ttl}`);
    }
    await this.socket.connect();
    await this.socket.extend(lockId, ttl);
  }

  async unlock(lockId: string): Promise<void> {
    if (this.options.debug) {
      console.log(`try to unlock ${lockId}`);
    }
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
  debug: boolean;
  buffer: PacketWrapper;
  socket: net.Socket;
  connected: boolean;
  _onConnect: () => void;
  _onError: (e: Error) => void;
  _waitConnect: Promise<void>;
  clients: Client[];
  retry: number;
  callbacks: {
    [requestId: string]: Function;
  };
  locks: {
    [lockId: string]: Client;
  };

  constructor(host: string, port: number, id?: string, debug?: boolean) {
    super();
    this.host = host;
    this.port = port;
    this.debug = debug;
    this.id = id || generateId();
    this.callbacks = Object.create(null);
    this.locks = Object.create(null);
    this.clients = [];
    this.connect();
  }

  connect(): Promise<void> {
    if (this._waitConnect) return this._waitConnect;
    if (this.debug) {
      console.log('connect...');
    }
    this._waitConnect = new Promise((resolve, reject) => {
      this._onConnect = resolve;
      this._onError = reject;
    });
    this.retry = 10;
    this._connect();
    return this._waitConnect;
  }

  _connect() {
    if (this.debug) {
      console.log('do connect...');
    }
    this.buffer = new PacketWrapper();
    this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.write(`connect ${this.id} 1.0`);
    });
    this.socket.on('error', (e) => {
      if (this.debug) {
        console.error(e.message);
      }
      if (!this.retry) {
        this._waitConnect = null;
        this._onError(e);
      }
    });
    this.socket.on('close', () => {
      // 重新链接
      let connected = this.connected;
      this.connected = false;
      if (!this.retry || !this.clients.length) return;
      this.retry -= 1;
      if (connected) {
        this._waitConnect = new Promise((resolve, reject) => {
          this._onConnect = resolve;
          this._onError = reject;
        });
      }
      setTimeout(() => {
        this._connect();
      }, 1000);
    });
    this.socket.on('data', this.onData);
  }

  onData = (chunk: Buffer) => {
    this.buffer.addChunk(chunk);
    this.onPacket();
  };

  onPacket = () => {
    let packet = this.buffer.read();
    if (!packet) return;
    if (this.debug) {
      console.log('received:', packet.toString());
    }
    let args = packet.toString().split(' ');
    let cmd = args[0].toLowerCase();
    args.shift();
    switch (cmd) {
      case 'connected':
        this.connected = true;
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
    setImmediate(this.onPacket);
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

  addClient(client: Client) {
    this.clients.push(client);
  }

  removeClient(client: Client) {
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
    if (this.debug) {
      console.log('write:', message);
    }
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
    client: Client,
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
