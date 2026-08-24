import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function durableAtomicWrite(path, content, { mode = 0o600 } = {}) {
  if (!path) throw new Error('durable write path is required');
  const directory = dirname(path);
  const temp = `${path}.tmp`;
  await mkdir(directory, { recursive: true });

  let handle;
  try {
    handle = await open(temp, 'w', mode);
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, path);

    // Persist the directory entry when the platform supports directory fsync.
    // Some platforms/filesystems reject opening or syncing directories; the
    // data file has already been fsynced, so only ignore known unsupported cases.
    let directoryHandle;
    try {
      directoryHandle = await open(directory, 'r');
      await directoryHandle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    } finally {
      await directoryHandle?.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true, recursive: true }).catch(() => {});
    throw error;
  }
}
