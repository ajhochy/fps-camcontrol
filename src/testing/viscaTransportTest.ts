import assert from 'assert';
import dgram from 'dgram';
import pino from 'pino';

/**
 * VISCA replies (2026-10-01): the V-BOT answers every inquiry to port 52381 on the asking machine, not to the
 * port the question came from, so a client on a random port never heard it. All cameras now share one socket
 * on the VISCA port, replies are routed by camera, and a camera's "answering" comes from its real replies.
 * Run: npx ts-node src/testing/viscaTransportTest.ts
 */
const indexPath = require.resolve('../index');
require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: { logger: pino({ level: 'silent' }) } } as any;

let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake camera on 127.0.0.1. `replyTo`: 'source' (most cameras) or a fixed port (the V-BOT's 52381 habit). */
function fakeCamera(replyTo: 'source' | number | 'never'): Promise<{ port: number; heard: number; close: () => void }> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const cam = { port: 0, heard: 0, close: () => sock.close() };
    sock.on('message', (msg, rinfo) => {
      cam.heard++;
      if (replyTo === 'never') return;
      const p = msg.subarray(8);
      const body = p[2] === 0x06 && p[3] === 0x12 ? [0x90, 0x50, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF] : [0x90, 0x50, 0x02, 0xFF]; // position or power
      const reply = Buffer.concat([Buffer.from([0x01, 0x11, 0x00, body.length]), msg.subarray(4, 8), Buffer.from(body)]);
      sock.send(reply, replyTo === 'source' ? rinfo.port : replyTo, '127.0.0.1');
    });
    sock.bind(0, '127.0.0.1', () => { cam.port = sock.address().port; resolve(cam); });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = dgram.createSocket('udp4'); s.bind(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function main(): Promise<void> {
  const standard = await freePort();
  process.env.VISCA_LOCAL_PORT = String(standard); // stands in for 52381
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ViscaClient, viscaTransportInfo } = require('../visca/viscaClient');

  const vbot = await fakeCamera(standard);   // replies only to the fixed port, like the V-BOT
  const birddog = await fakeCamera('source'); // replies to whatever port asked
  const dead = await fakeCamera('never');
  const a = new ViscaClient('cam1', '127.0.0.1', vbot.port, 'vbot');
  const b = new ViscaClient('cam2', '127.0.0.1', birddog.port, 'birddog');
  const c = new ViscaClient('cam3', '127.0.0.1', dead.port, 'generic');
  try {
    a.connect(); b.connect(); c.connect();
    await wait(200);
    check('all cameras share one socket on the VISCA port', viscaTransportInfo().localPort === standard && a.connected && b.connected && c.connected);
    check('a camera that replies only to the VISCA port (the V-BOT) is heard', (await a.probe(1000)) === true && a.lastReplyAt !== null);
    check('a camera that replies to the asking port is heard too', (await b.probe(1000)) === true);
    check('a camera that never replies is reported as not answering', (await c.probe(600)) === false && c.lastReplyAt === null && dead.heard >= 1);
    const before = b.lastReplyAt;
    await a.probe(1000);
    check('replies go to the camera they came from, not to the others', b.lastReplyAt === before);
    const pos = await Promise.race([a.queryPanTilt().then(() => 'answered'), wait(1000).then(() => 'timed out')]);
    check('a position inquiry to the V-BOT gets its answer now (preset save needs it)', pos === 'answered');
    b.close();
    check('closing one camera leaves the shared socket for the others', viscaTransportInfo().localPort === standard && (await a.probe(1000)) === true);
  } finally {
    a.close(); b.close(); c.close(); vbot.close(); birddog.close(); dead.close();
  }
  check('the shared socket closes when the last camera does', viscaTransportInfo().localPort === null);

  // A second copy of the app must not steal the port (or the live app's replies): it falls back.
  const holder = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => holder.bind(standard, () => resolve()));
  const second = new ViscaClient('cam9', '127.0.0.1', 9, 'generic');
  second.connect();
  await wait(300);
  check('when the VISCA port is taken the app falls back to a random port and says replies may not be heard', second.connected && viscaTransportInfo().localPort !== standard && viscaTransportInfo().onStandardPort === false);
  second.close(); holder.close();
  console.log(`visca transport: ${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
