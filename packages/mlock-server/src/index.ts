import Server from './server';

process.title = 'mlock-server';

const server = new Server({ port: 12340 });
