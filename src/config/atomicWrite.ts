import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Replace `target` with `content` so a crash or power loss can never leave a
 * half-written file: write a temp file in the same directory, flush it to disk,
 * then rename over the target (an atomic replace on the same filesystem). The
 * original file's permissions are kept. `rename` is injectable so a test can
 * prove the old content survives a failure at the last step.
 */
export function writeFileAtomic(
  target: string,
  content: string,
  io: { rename?: (from: string, to: string) => void } = {},
): void {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let mode = 0o644;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* new file: default mode */ }
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeSync(fd, content, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    (io.rename ?? fs.renameSync)(temp, target);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(temp); } catch { /* temp never created or already gone */ }
    throw error;
  }
}
