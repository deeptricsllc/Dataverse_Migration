import { createHash, type Hash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import zlib from 'node:zlib';
import { crc32 } from './zip';

/**
 * A ZIP writer that never holds the archive.
 *
 * `writeZip` builds the whole thing in memory, which is right for a spreadsheet and wrong for an
 * evidence package: a lineage export of ten million records is a file nobody should have to fit in
 * RAM twice. ZIP is designed for this — entries are written one after another and the central
 * directory goes at the end — so the only thing kept here is one 46-byte record per entry plus its
 * name, and a hash of each entry as it goes past.
 *
 * Sizes are known before each entry is closed because the content is deflated as it streams, so no
 * data descriptors are needed and the archive is an ordinary one any reader opens.
 */

export interface ZipStreamFile {
  path: string;
  /** Bytes as stored in the archive, after compression. */
  compressedBytes: number;
  /** Bytes of the original content. */
  bytes: number;
  /** SHA-256 of the original content, for a manifest to record. */
  sha256: string;
}

export class ZipStream {
  /** What the reader will see, in order. Bounded by the number of entries, not their size. */
  private readonly central: Buffer[] = [];
  readonly files: ZipStreamFile[] = [];
  private offset = 0;
  private closed = false;
  /** Backpressure-aware sink the caller pipes somewhere. */
  readonly output = new PassThrough();

  /** Writes one entry from an async source of chunks, hashing and compressing as it passes. */
  async add(path: string, source: AsyncIterable<Buffer | string> | Buffer | string): Promise<void> {
    if (this.closed) throw new Error('ZipStream is already finished');
    const name = Buffer.from(path, 'utf8');
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let bytes = 0;
    let crc = -1;

    // Deflate streams out while the source streams in; the compressed entry is the only thing that
    // has to be held, because its length goes in the header that precedes it.
    const deflate = zlib.createDeflateRaw({ level: 6 });
    const collecting = (async () => {
      for await (const piece of deflate) chunks.push(piece as Buffer);
    })();

    for await (const piece of normalize(source)) {
      bytes += piece.length;
      hash.update(piece);
      crc = updateCrc(crc, piece);
      if (!deflate.write(piece)) await once(deflate, 'drain');
    }
    deflate.end();
    await collecting;

    const deflated = Buffer.concat(chunks);
    const digest = hash.digest('hex');
    const finalCrc = (crc ^ -1) >>> 0;
    // Storing beats deflate for content that does not compress, but it needs the original bytes a
    // second time. That is only safe for a buffer or a string; a one-shot async source is deflated
    // whatever the ratio, because reading it twice would silently store nothing.
    const replayable = typeof source === 'string' || Buffer.isBuffer(source);
    const stored = replayable && deflated.length >= bytes;
    const body = stored
      ? Buffer.from(typeof source === 'string' ? Buffer.from(source, 'utf8') : source)
      : deflated;
    const method = stored ? 0 : 8;

    await this.push(localHeader(name, method, finalCrc, body.length, bytes));
    await this.push(body);
    this.central.push(centralRecord(name, method, finalCrc, body.length, bytes, this.offset));
    this.offset += 30 + name.length + body.length;
    this.files.push({ path, compressedBytes: body.length, bytes, sha256: digest });
  }

  /** Writes the central directory and ends the stream. Nothing may be added afterwards. */
  async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const directory = Buffer.concat(this.central);
    await this.push(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(this.offset, 16);
    await this.push(end);
    this.output.end();
  }

  /** Aborts the archive, so a reader sees a broken stream rather than a plausible short one. */
  destroy(error: Error): void {
    this.closed = true;
    this.output.destroy(error);
  }

  private async push(buf: Buffer): Promise<void> {
    if (!this.output.write(buf)) await once(this.output, 'drain');
  }
}

function normalize(source: AsyncIterable<Buffer | string> | Buffer | string): AsyncIterable<Buffer> {
  if (typeof source === 'string') return Readable.from([Buffer.from(source, 'utf8')]);
  if (Buffer.isBuffer(source)) return Readable.from([source]);
  return (async function* () {
    for await (const piece of source) {
      yield typeof piece === 'string' ? Buffer.from(piece, 'utf8') : piece;
    }
  })();
}

function updateCrc(crc: number, buf: Buffer): number {
  // The same table as `crc32`, applied incrementally. `crc32` is kept for whole buffers.
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return c;
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

function localHeader(
  name: Buffer,
  method: number,
  crc: number,
  compressed: number,
  uncompressed: number,
): Buffer {
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed, 18);
  local.writeUInt32LE(uncompressed, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  return local;
}

function centralRecord(
  name: Buffer,
  method: number,
  crc: number,
  compressed: number,
  uncompressed: number,
  offset: number,
): Buffer {
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed, 20);
  central.writeUInt32LE(uncompressed, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  name.copy(central, 46);
  return central;
}

function once(emitter: { once: (event: string, fn: (arg?: unknown) => void) => unknown }, event: string) {
  return new Promise<void>((resolve) => emitter.once(event, () => resolve()));
}

/** Kept so callers can hash a whole buffer the same way the stream does. */
export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export type { Hash };
export { crc32 };
