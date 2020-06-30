const LockClent = require('../packages/mlock/lib/index').default;

let client = new LockClent({ host: 'localhost' });

(async () => {
  try {
    let lockId = await client.lock('goods-1', 5000);
    console.log('locked', lockId);
    await client.extend(lockId, 1000);
    await client.unlock(lockId);
    client.destroy();
  } catch (e) {
    console.error('connect error:::', e);
  }
})();
