import zlib from 'node:zlib';

/**
 * The slice of ZIP needed to read and write Office Open XML documents.
 *
 * A .xlsx file is a ZIP of XML parts, so a spreadsheet writer needs a ZIP writer. Pulling in an
 * archiver for that would be a lot of dependency for a format whose local-file and central-directory
 * records fit on one screen. Only deflate and store are supported, which is all Excel emits.
 */

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Writes a ZIP archive. Entries keep the order given, which matters for Office: some readers expect
 * `[Content_Types].xml` first.
 */
export function writeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 6 });
    // Storing is smaller for data that does not compress; it also keeps tiny parts readable.
    const stored = deflated.length >= entry.data.length;
    const body = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDirectory, end]);
}

/**
 * Reads a ZIP archive into its entries, keyed by path.
 *
 * The central directory is the authority rather than the local headers, because a file written by
 * a streaming producer can leave the local header's sizes at zero with the real values in a data
 * descriptor — which is exactly what some spreadsheet tools do.
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('Not a ZIP file: no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);

    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    if (uncompressedSize && data.length !== uncompressedSize) {
      throw new Error(`Corrupt ZIP entry ${name}: expected ${uncompressedSize} bytes, got ${data.length}`);
    }
    out.set(name, data);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

/** The record is at the end, but a trailing comment can push it back by up to 64 KB. */
function findEndOfCentralDirectory(buf: Buffer): number {
  const floor = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
