import net from 'net';
import PacketWrapper from 'packet-wrapper';
import { ServerOptions } from '..';

declare module 'net' {
  export interface Socket {
    id: string;
    checkConnectTimer?: any;
  }
}

interface Item {
  lock: Lock;
  active: boolean;
}

interface Lock {
  socket: string;
  lock: string;
  resources: string[];
  items: {
    [resource: string]: Item;
  };
  activeCount: number;
  locked: boolean;
  // 请求超时时间
  timeoutAt: number;
  // 上锁超时时间
  expiredAt: number;
  // 锁时间
  ttl: number;
}

interface OfflineMessage {
  socketId: string;
  time: number;
  args: string[];
}

interface Status {
  startAt: number;
  lockCount: number;
  intoleranceCount: number;
  timeoutCount: number;
  lockedCount: number;
  expiredCount: number;
  finishedCount: number;
  extendCount: number;
  extendFailedCount: number;
}

export default class Server {
  server: net.Server;
  options: ServerOptions;
  sockets: {
    [id: string]: net.Socket | null;
  };
  queues: {
    [resource: string]: Item[];
  };
  locks: {
    [lock: string]: Lock;
  };
  checkTimer: NodeJS.Timeout;
  offlineMessages: OfflineMessage[];
  serverStatus: Status;

  constructor(options: ServerOptions) {
    this.options = options || {};

    this.sockets = Object.create(null);
    this.queues = Object.create(null);
    this.locks = Object.create(null);
    this.offlineMessages = [];
    this.serverStatus = {
      startAt: Date.now(),
      lockCount: 0,
      intoleranceCount: 0,
      timeoutCount: 0,
      lockedCount: 0,
      expiredCount: 0,
      finishedCount: 0,
      extendCount: 0,
      extendFailedCount: 0
    };
  }

  listen() {
    if (this.server) return Promise.reject(new Error('Already listened!'));
    if (this.options.debug) {
      console.log('listen...');
    }
    this.server = net.createServer((socket) => {
      console.log('new conn', `${socket.remoteAddress}:${socket.remotePort}`);
      socket.checkConnectTimer = setTimeout(() => {
        socket.checkConnectTimer = null;
        this.sendError(socket, 'auth timeout!');
      }, 10000);
      let buffer = new PacketWrapper();
      socket.on('data', (chunk) => {
        if (this.options.debug) {
          console.log(
            `recevied data: ${socket.remoteAddress}:${socket.remotePort} length: ${chunk.length}`
          );
        }
        buffer.addChunk(chunk);
        let packet: Buffer;
        while ((packet = buffer.read())) {
          this.onMessage(socket, packet.toString());
        }
      });

      socket.on('close', () => {
        if (!this.server) return;
        if (!socket.id) {
          console.log(`disconnected ${socket.remoteAddress}:${socket.remotePort}`);
          return;
        }
        this.sockets[socket.id] = null;
        console.log(`disconnected ${socket.remoteAddress}:${socket.remotePort} ${socket.id}`);
      });
    });

    return new Promise((resolve, reject) => {
      this.server.on('error', (e) => {
        if (this.options.debug) {
          console.error('error', e);
        }
        let server = this.server;
        this.server = null;
        server.close();
        reject(e);
      });
      this.server.listen(this.options.port || 12340, () => {
        if (this.options.debug) {
          console.log('server listened');
        }
        resolve();
      });
    });
  }

  close() {
    let server = this.server;
    if (!server) return Promise.reject(new Error('Already closed!'));
    this.server = null;
    console.log('close...');
    clearTimeout(this.checkTimer);
    this.checkTimer = null;
    for (let socketId in this.sockets) {
      let socket = this.sockets[socketId];
      if (!socket) continue;
      if (socket.checkConnectTimer) {
        clearTimeout(socket.checkConnectTimer);
        socket.checkConnectTimer = null;
      }
      socket.end();
    }
    this.sockets = Object.create(null);
    this.queues = Object.create(null);
    this.locks = Object.create(null);
    this.offlineMessages = [];
    return new Promise((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
  }

  onMessage(socket: net.Socket, text: String) {
    if (this.options.debug) {
      console.log(`recevied message: ${socket.remoteAddress}:${socket.remotePort} ${text}`);
    }
    let list = text.split(' ');
    let args = ([socket] as any[]).concat(list.slice(1));
    let cmd = list[0].toLowerCase();
    if (!socket.id && cmd !== 'connect') return this.sendError(socket, 'shoule connect first!');
    switch (cmd) {
      case 'connect':
        // @ts-ignore
        this.connect(...args);
        return;
      case 'status':
        // @ts-ignore
        this.status(...args);
        return;
      case 'lock':
        // @ts-ignore
        this.lock(...args);
        return;
      case 'extend':
        // @ts-ignore
        this.extend(...args);
        return;
      case 'unlock':
        // @ts-ignore
        this.unlock(...args);
        return;
      default:
        this.sendError(socket, 'invalid message!');
    }
  }

  connect(socket: net.Socket, socketId: string, apiVersion: string) {
    if (socket.id) {
      return this.sendError(socket, 'duplicate connect!');
    }
    if (!socketId) {
      return this.sendError(socket, 'socketId is required!');
    }
    if (!apiVersion) {
      return this.sendError(socket, 'apiVersion is required!');
    }
    if (this.sockets[socketId] === null) {
      // reconnected
      socket.id = socketId;
      console.log('reconnected', `${socket.remoteAddress}:${socket.remotePort}`, socketId);
      // TODO: 重连后处理
    } else if (this.sockets[socketId]) {
      return this.sendError(socket, 'connection conflicted!');
    } else {
      console.log('connected', `${socket.remoteAddress}:${socket.remotePort}`, socketId);
    }
    socket.id = socketId;
    this.sockets[socketId] = socket;
    if (socket.checkConnectTimer) {
      clearTimeout(socket.checkConnectTimer);
      socket.checkConnectTimer = null;
    }

    this.send(socket, ['connected', '1.0']);

    let msgTimeout = Date.now() - 2000;
    this.offlineMessages = this.offlineMessages.filter((msg) => {
      if (msg.time < msgTimeout) return false;
      if (msg.socketId !== socketId) return true;
      this.send(socket, msg.args);
      return false;
    });
  }

  status(socket: net.Socket) {
    this.send(socket, [
      'status',
      JSON.stringify(
        Object.assign(
          {
            socketCount: Object.keys(this.sockets).length,
            currentLocks: Object.keys(this.locks).length,
            liveTime: Date.now() - this.serverStatus.startAt
          },
          this.serverStatus
        )
      )
    ]);
  }

  lock(
    socket: net.Socket,
    request: string,
    resource: string,
    ttl: string,
    timeout: string,
    tolerate: string
  ) {
    const now = Date.now();
    let data = {
      ttl: parseInt(ttl),
      timeout: parseInt(timeout),
      tolerate: parseInt(tolerate)
    };
    if (Number.isNaN(data.ttl) || data.ttl <= 0) {
      return this.sendResult(socket, request, false, 'ttl should be integer!');
    }

    let lockId = now.toString(16) + Math.random().toString(16).substr(2);

    let resources = resource.split('|');

    this.serverStatus.lockCount += 1;
    let lock: Lock = {
      socket: socket.id,
      lock: lockId,
      resources,
      items: Object.create(null),
      activeCount: 0,
      locked: false,
      timeoutAt: data.timeout ? now + data.timeout : 0,
      expiredAt: 0,
      ttl: data.ttl
    };

    for (let resource of resources) {
      let item: Item = {
        lock,
        active: false
      };
      if (!this.queues[resource]) {
        this.queues[resource] = [];
      }
      if (data.tolerate && this.queues[resource].length > data.tolerate) {
        this.serverStatus.intoleranceCount += 1;
        this.sendResult(socket, request, false, 'can not tolerate!');
        for (let rid in lock.items) {
          this.queues[rid].pop();
        }
        return;
      }
      lock.items[resource] = item;
      this.queues[resource].push(item);
    }

    this.locks[lockId] = lock;

    this.sendResult(socket, request, true, lockId);

    clearTimeout(this.checkTimer);
    this.check();
  }

  extend(socket: net.Socket, request: string, lockId: string, ttl: string) {
    let lock = this.locks[lockId];
    if (!lock) return this.sendResult(socket, request, false, 'lock not exist!');

    if (!lock.locked) return this.sendResult(socket, request, false, 'not locked yet!');

    let ttlNum = parseInt(ttl);
    if (!ttlNum || ttlNum <= 0)
      return this.sendResult(socket, request, false, 'ttl should be integer!');

    lock.expiredAt += ttlNum;

    this.sendResult(socket, request, true, lock.expiredAt.toString());

    clearTimeout(this.checkTimer);
    this.check();
  }

  unlock(socket: net.Socket, request: string, lockId: string) {
    let lock = this.locks[lockId];
    if (!lock) return this.sendResult(socket, request, false, 'lock not exist!');
    delete this.locks[lockId];

    for (let rid in lock.items) {
      removeItem(this.queues[rid], lock.items[rid]);
    }

    this.sendResult(socket, request, true, 'done');

    clearTimeout(this.checkTimer);
    this.check();
  }

  sendResult(socket: net.Socket, request: string, success: boolean, data: string) {
    this.send(socket, ['result', request, success ? 'success' : 'failed', data]);
  }

  sendError(socket: net.Socket, message: string) {
    this.send(socket, ['error', message]);
    if (socket.checkConnectTimer) {
      clearTimeout(socket.checkConnectTimer);
      socket.checkConnectTimer = null;
    }
    socket.end();
  }

  send(socket: net.Socket, args: string[]) {
    if (this.options.debug) {
      console.log(`send: ${socket.remoteAddress}:${socket.remotePort} ${args.join(' ')}`);
    }
    socket.write(PacketWrapper.encode(Buffer.from(args.join(' '))));
  }

  sendToSocket(socketId: string, args: any[]) {
    let socket = this.sockets[socketId];
    if (socket) {
      return this.send(socket, args);
    }
    this.offlineMessages.push({ socketId, time: Date.now(), args });
  }

  /**
   * 检查锁队列
   */
  check = () => {
    const now = Date.now();
    const msgTimeout = Date.now() - 2000;
    // 下次检查时间
    let nextCheckAt = 0;

    for (let lockId in this.locks) {
      let lock = this.locks[lockId];
      if (lock.timeoutAt && lock.timeoutAt < now) {
        // 已超时
        delete this.locks[lockId];
        // 移除Items
        for (let rid in lock.items) {
          removeItem(this.queues[rid], lock.items[rid]);
        }
        this.sendToSocket(lock.socket, ['timeout', lockId]);
        this.serverStatus.timeoutCount += 1;
        continue;
      }

      if (lock.expiredAt && lock.expiredAt < now) {
        // 已超时
        delete this.locks[lockId];
        // 移除Items
        for (let rid in lock.items) {
          removeItem(this.queues[rid], lock.items[rid]);
        }
        this.sendToSocket(lock.socket, ['expired', lockId]);
        this.serverStatus.expiredCount += 1;
        continue;
      }
    }

    // 上新锁
    for (let resource in this.queues) {
      let queue = this.queues[resource];
      if (!queue.length) {
        // 空队列
        delete this.queues[resource];
        continue;
      }
      // 首元素
      let firstItem = queue[0];
      let lock = firstItem.lock;
      if (!firstItem.active) {
        firstItem.active = true;
        lock.activeCount += 1;
        if (lock.activeCount >= lock.resources.length) {
          // 上锁成功
          lock.locked = true;
          lock.timeoutAt = 0;
          lock.expiredAt = now + lock.ttl;
          this.sendToSocket(lock.socket, ['locked', lock.lock, lock.expiredAt]);

          this.serverStatus.lockedCount += 1;
        }
      }
      if (lock.locked) {
        if (!nextCheckAt || nextCheckAt > lock.expiredAt) {
          nextCheckAt = lock.expiredAt;
        }
      }
    }

    // 离线数据过期
    while (this.offlineMessages.length && this.offlineMessages[0].time) {
      if (this.offlineMessages[0].time > msgTimeout) {
        break;
      }
      this.offlineMessages.shift();
    }

    this.checkTimer = setTimeout(this.check, nextCheckAt ? now - nextCheckAt : 100);
    // end of check
  };
}

function removeItem<T>(array: T[], item: T): number {
  let index = array.indexOf(item);
  array.splice(index, 1);
  return index;
}
