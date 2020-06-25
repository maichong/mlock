const PacketWrapper = require('packet-wrapper');
const net = require('net');

let socket = net.createConnection({
  host: '127.0.0.1',
  port: 12340
});

socket.on('error', (e) => {
  console.error(e.message);
});

socket.on('connect', () => {
  process.stdin.on('data', (data) => {
    if (data.length === 1 && data[0] === 0x0a) return;
    socket.write(PacketWrapper.encode(data.slice(0, data.length - 1)));
  });
});

const buffer = new PacketWrapper();
socket.on('data', (chunk) => {
  buffer.addChunk(chunk);
  let packet;
  while ((packet = buffer.read())) {
    console.log(packet.toString());
  }
});

socket.on('close', () => {
  process.exit();
});
