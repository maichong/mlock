const Server = require('../packages/mlock-server').default;
const Client = require('../packages/mlock').default;

(async () => {
  try {
    const server = new Server({ debug: true });
    await server.listen();
    let client = new Client({ host: 'localhost', debug: true, prefix: 'lock:' });
    let lockId = await client.lock('goods-1', 5000);
    await client.extend(lockId, 1000);
    await client.unlock(lockId);
    client.destroy();
    await server.close();
  } catch (e) {
    console.error('connect error:::', e);
  }
})();
