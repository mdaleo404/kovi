import fs from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT_SIZE = 65535;

// Minimal ZIP reader for the tracked plugin archive: enough to compare entry
// names and bytes without adding a dependency or requiring the zip binary.
export function readZipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - EOCD_SIZE; i >= Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT_SIZE); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`Not a ZIP archive: ${file}`);
  const count = buf.readUInt16LE(eocd + 10);
  const entries = new Map();
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new Error(`Corrupt ZIP central directory: ${file}`);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new Error(`Corrupt ZIP local header for ${name}: ${file}`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const stored = buf.subarray(dataStart, dataStart + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression for ${name}: ${file}`);
    entries.set(name, method === 0 ? Buffer.from(stored) : inflateRawSync(stored));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
