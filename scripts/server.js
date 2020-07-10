const Server = require('../packages/mlock-server').default;

const server = new Server({ debug: true });
server.listen();
