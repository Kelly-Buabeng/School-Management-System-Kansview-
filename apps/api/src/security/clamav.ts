import { connect } from 'node:net';

export type ScanVerdict = { status: 'clean' } | { status: 'infected'; signature: string } | { status: 'error'; message: string };

/**
 * Minimal clamd client using the INSTREAM command over TCP (default port 3310).
 * Protocol: "zINSTREAM\0", then chunks of <4-byte big-endian length><data>, then a zero-length chunk.
 * Reply: "stream: OK\0" or "stream: <signature> FOUND\0" or "... ERROR\0".
 */
export class ClamdClient {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30000,
    private readonly chunkSize = 64 * 1024,
  ) {}

  scan(data: Buffer): Promise<ScanVerdict> {
    return new Promise((resolve) => {
      let reply = '';
      let settled = false;
      const done = (v: ScanVerdict) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(v);
      };
      const socket = connect({ host: this.host, port: this.port });
      socket.setTimeout(this.timeoutMs, () => done({ status: 'error', message: 'clamd timeout' }));
      socket.on('error', (err) => done({ status: 'error', message: `clamd connection failed: ${err.message}` }));
      socket.on('data', (chunk) => {
        reply += chunk.toString('utf8');
        if (reply.includes('\0') || reply.includes('\n')) done(parseReply(reply));
      });
      socket.on('end', () => done(parseReply(reply)));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let off = 0; off < data.length; off += this.chunkSize) {
          const part = data.subarray(off, off + this.chunkSize);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length, 0);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
    });
  }
}

export function parseReply(raw: string): ScanVerdict {
  const text = raw.replace(/\0/g, '').trim();
  if (!text) return { status: 'error', message: 'empty reply from clamd' };
  if (/:\s*OK$/.test(text)) return { status: 'clean' };
  const found = /:\s*(.+)\s+FOUND$/.exec(text);
  if (found) return { status: 'infected', signature: found[1]! };
  return { status: 'error', message: text.slice(0, 200) };
}
