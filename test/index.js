const assert = require('assert');
const Server = require('../packages/mlock-server').default;
const Client = require('../packages/mlock-client').default;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  {
    console.log('1 -------------------');
    const port = 12341;
    const server = new Server({ debug: true, port });
    await server.listen();
    let client = new Client({ host: 'localhost', port, debug: true, prefix: 'lock:' });
    let lockId = await client.lock('goods-1|goods-2', 5000);
    let expiredAt = await client.extend(lockId, 1000);
    assert(typeof expiredAt === 'number');
    console.log('new expiredAt', expiredAt);
    await client.unlock(lockId);
    let status = await client.status();
    console.log('status:', JSON.stringify(status, null, 2));
    console.log('ping...');
    console.log(await client.ping());
    await delay(5000);
    client.destroy();
    await server.close();
  }

  {
    console.log('\n2 -------------------');
    const port = 12342;
    const server = new Server({ debug: true, port });
    await server.listen();
    let client = new Client({ host: 'localhost', port, debug: true, prefix: 'lock:' });
    let lockId = await client.lock('goods-1|goods-2', 5000);
    await server.close();
    await delay(2000);
    client.extend(lockId, 1000).then(
      () => {
        throw new Error('should throw error!');
      },
      (error) => {
        if (error.message !== 'lock not exist!') throw error;
      }
    );
    await delay(5000);
    await server.listen();
    await delay(2000);
    client.destroy();
    await delay(2000);
    await server.close();
  }
})();
