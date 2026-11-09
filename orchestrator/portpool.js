import net from 'node:net';
const inUse = new Set();
function canBind(p) {
  return new Promise(res => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(p, '127.0.0.1');
  });
}
export async function allocate(start = 7500, end = 7900) {
  for (let p = start; p <= end; p++) {
    if (inUse.has(p)) continue;
    if (await canBind(p)) { inUse.add(p); return p; }
  }
  throw new Error('no free ports');
}
export function release(p) { inUse.delete(p); }
