import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

type ZipEntry = {
  name: string;
  data: Buffer;
};

const PLUGIN_ROOT = 'cowork-plugin';
const INCLUDED_PLUGIN_PATHS = ['.claude-plugin', '.mcp.json', 'skills'];

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buffer: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function collectPluginEntries(rootDir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];

  const visit = (relativePath: string) => {
    const absolutePath = path.join(rootDir, relativePath);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolutePath).sort()) {
        visit(path.join(relativePath, child));
      }
      return;
    }
    if (!stat.isFile()) return;
    entries.push({
      name: relativePath.split(path.sep).join('/'),
      data: readFileSync(absolutePath),
    });
  };

  for (const relativePath of INCLUDED_PLUGIN_PATHS) {
    visit(relativePath);
  }
  return entries;
}

export function buildClaudePluginZip(cwd = process.cwd()): Buffer {
  const rootDir = path.join(cwd, PLUGIN_ROOT);
  const entries = collectPluginEntries(rootDir);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(size),
      writeUInt32(size),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
    ]);
    localParts.push(localHeader, entry.data);
    centralParts.push(Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(size),
      writeUInt32(size),
      writeUInt16(name.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      name,
    ]));
    offset += localHeader.length + entry.data.length;
  }

  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(central.length),
    writeUInt32(local.length),
    writeUInt16(0),
  ]);

  return Buffer.concat([local, central, end]);
}
