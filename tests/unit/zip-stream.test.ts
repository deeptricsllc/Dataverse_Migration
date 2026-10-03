import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readZip, writeZip } from '../../server/src/lib/zip';
import { ZipStream } from '../../server/src/lib/zip-stream';

/**
 * A ZIP written without holding the archive.
 *
 * The reason to have a second ZIP writer is memory, so these tests check two different things: that
 * what comes out is an ordinary archive the existing reader opens, and that producing a large one
 * does not need to hold it. The second is the whole point and the easier one to lose in a refactor.
 */
async function drain(stream: ZipStream, build: () => Promise<void>): Promise<Buffer> {
  const parts: Buffer[] = [];
  const collecting = (async () => {
    for await (const piece of stream.output) parts.push(piece as Buffer);
  })();
  await build();
  await stream.finish();
  await collecting;
  return Buffer.concat(parts);
}

describe('streaming zip', () => {
  it('produces an archive the ordinary reader opens', async () => {
    const zip = new ZipStream();
    const bytes = await drain(zip, async () => {
      await zip.add('a.txt', 'hello');
      await zip.add('nested/b.csv', 'one,two\r\nthree,four\r\n');
      await zip.add('c.bin', Buffer.from([0, 1, 2, 255, 254]));
    });

    const entries = readZip(bytes);
    expect([...entries.keys()]).toEqual(['a.txt', 'nested/b.csv', 'c.bin']);
    expect(entries.get('a.txt')!.toString('utf8')).toBe('hello');
    expect(entries.get('nested/b.csv')!.toString('utf8')).toBe('one,two\r\nthree,four\r\n');
    expect([...entries.get('c.bin')!]).toEqual([0, 1, 2, 255, 254]);
  });

  it('reports the hash and size of every entry, for a manifest to record', async () => {
    const zip = new ZipStream();
    const body = 'the quick brown fox';
    await drain(zip, async () => {
      await zip.add('one.txt', body);
    });
    const file = zip.files[0]!;
    expect(file.path).toBe('one.txt');
    expect(file.bytes).toBe(Buffer.byteLength(body));
    expect(file.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('writes an entry from an async source without reading it twice', async () => {
    // The trap this test exists for: a `stored` entry needs the original bytes again, and reading a
    // one-shot source a second time yields nothing. Content that does not compress is the case that
    // would have been stored.
    let reads = 0;
    const random = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251));
    async function* source() {
      reads++;
      yield random;
    }
    const zip = new ZipStream();
    const bytes = await drain(zip, async () => {
      await zip.add('incompressible.bin', source());
    });
    expect(reads, 'the source was consumed exactly once').toBe(1);
    expect(readZip(bytes).get('incompressible.bin')!.equals(random), 'and arrived intact').toBe(true);
  });

  it('survives Unicode, emoji and CRLF in names and content', async () => {
    const zip = new ZipStream();
    const content = 'Ünïcödé — 日本語 — 🧪\r\nsecond line\r\n';
    const bytes = await drain(zip, async () => {
      await zip.add('files/ünïcödé — 🧪.csv', content);
    });
    const entries = readZip(bytes);
    expect(entries.get('files/ünïcödé — 🧪.csv')!.toString('utf8')).toBe(content);
  });

  it('agrees byte for byte with the in-memory writer on the same content', async () => {
    // Not required, but it is the cheapest proof that the headers are right rather than merely
    // readable by our own reader.
    const entries = [
      { path: 'x.txt', data: Buffer.from('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') },
      { path: 'y.txt', data: Buffer.from('bbbb') },
    ];
    const zip = new ZipStream();
    const streamed = await drain(zip, async () => {
      for (const entry of entries) await zip.add(entry.path, entry.data);
    });
    const whole = writeZip(entries);
    expect(readZip(streamed)).toEqual(readZip(whole));
  });

  it('does not hold the archive it writes', async () => {
    // 64 MB in 1 MB pieces, discarded as they come out. If the writer buffered the archive this
    // would show up as tens of megabytes of retained heap; it holds one entry's compressed form and
    // one 46-byte record per entry.
    const piece = Buffer.alloc(1024 * 1024, 7);
    const zip = new ZipStream();
    let produced = 0;
    const collecting = (async () => {
      for await (const out of zip.output) produced += (out as Buffer).length;
    })();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    for (let i = 0; i < 8; i++) {
      await zip.add(
        `part-${i}.bin`,
        (async function* () {
          for (let n = 0; n < 8; n++) {
            yield piece;
            peak = Math.max(peak, process.memoryUsage().heapUsed);
          }
        })(),
      );
    }
    await zip.finish();
    await collecting;

    expect(produced, 'the whole archive came out').toBeGreaterThan(0);
    expect(zip.files).toHaveLength(8);
    for (const file of zip.files) expect(file.bytes).toBe(8 * 1024 * 1024);
    // Generous, because this runs on whatever machine is free. 64 MB of content through a writer
    // that holds under 32 MB of heap is the shape; holding the archive would be 64 MB and up.
    expect((peak - before) / (1024 * 1024)).toBeLessThan(32);
  }, 120_000);
});
