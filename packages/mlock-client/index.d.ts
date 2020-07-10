export interface ClientOptions {
  /**
   * 链接URI，优先于host/port
   */
  uri?: string;
  /**
   * 服务器主机地址，默认localhost
   */
  host?: string;
  /**
   * 服务器端口，默认 12340
   */
  port?: number;
  /**
   * 资源前缀
   */
  prefix?: string;
  /**
   * 默认锁TTL，单位毫秒
   */
  ttl?: number;
  /**
   * 默认上锁超时时间，单位毫秒
   */
  timeout?: number;
  /**
   * 默认容忍锁队列中等待个数，如果超过容忍数，直接报错，不用等待到timeout
   */
  tolerate?: number;
  socketId?: string;
  debug?: boolean;
}

export default class Client {
  constructor(options: string | ClientOptions);

  /**
   * 上锁，上锁成功后返回锁ID
   * @param {string} resource 资源描述字符串，同时锁定多个资源用 | 分隔
   * @param {number} [ttl]
   * @param {number} [timeout]
   * @param {number} [tolerate]
   */
  lock(resource: string, ttl?: number, timeout?: number, tolerate?: number): Promise<string>;

  /**
   * 延时，成功后返回新的过期时间戳
   * @param {string} lock 锁ID
   * @param {number} [ttl]
   */
  extend(lock: string, ttl?: number): Promise<number>;

  /**
   * 解锁
   */
  unlock(lock: string): Promise<void>;
}

export class MlockError extends Error {
  type?: 'connection' | 'request' | 'tolerate' | 'timeout';
}
