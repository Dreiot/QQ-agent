import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// These are inert synthetic files. No upstream package or executable is used.
export const napFiles = ['node.exe', 'index.js', 'wrapper.node', 'QQNT.dll', 'package.json',
  'config.json', 'napcat/napcat.mjs'];
export const snowFiles = ['node.exe', 'index.mjs', 'package.json', 'release.json', 'check-node-version.cjs',
  'EULA.md', 'PRIVACY.md', 'client/index.html', 'native/snowluma-win32-x64.dll',
  'native/snowluma-win32-x64.node', 'native/websocket-win32-x64.node',
  'native/ffmpeg/ffmpegAddon.win32.x64.node', 'native/sqlite/manifest.json',
  'native/sqlite/LICENSE.sqlite3', 'native/sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node'];

export function filesFor(provider, prefix = '') {
  return Object.fromEntries((provider === 'napcat' ? napFiles : snowFiles).map(name => [
    prefix + name,
    name === 'release.json' ? JSON.stringify({ target: 'win32-x64' })
      : name.endsWith('.json') ? '{}' : 'synthetic fixture; never execute',
  ]));
}

export async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

const table = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored ZIP entries exercise the production validator/extractor, including CRC
// and UNIX entry type checks; the fixture intentionally permits unsafe names.
export function makeZip(files, { symlink = '', corrupt = '' } = {}) {
  const local = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(content), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(0x0314, 4); index.writeUInt16LE(20, 6);
    index.writeUInt32LE(crc, 16); index.writeUInt32LE(data.length, 20);
    index.writeUInt32LE(data.length, 24); index.writeUInt16LE(filename.length, 28);
    index.writeUInt32LE(((name === symlink ? 0xa1ff : 0x81a4) * 65536) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    if (name === corrupt && data.length) data[0] ^= 0xff;
    local.push(header, filename, data); central.push(index, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

let nextPid = 800000;
export function fakeChild({ fail = false, autoSpawn = true } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: ++nextPid, stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kills: [] });
  child.kill = signal => {
    child.kills.push(signal); child.signalCode = signal; child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, signal)); return true;
  };
  if (autoSpawn) queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', fail ? new Error('synthetic spawn failure') : undefined));
  return child;
}
