/**
 * Storage subsystem — unit tests
 *
 * Tests both the LocalStorageBackend (using os.tmpdir()) and the
 * MemoryStorageBackend. Local backend tests clean up after themselves.
 */
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LocalStorageBackend } from './storage.local-backend';
import { MemoryStorageBackend } from './storage.memory-backend';

// ============================================================================
// Shared behavioural tests — run against both backends
// ============================================================================

function runSharedTests(
  label: string,
  makeBackend: () => LocalStorageBackend | MemoryStorageBackend,
): void {
  describe(label, () => {
    let backend: LocalStorageBackend | MemoryStorageBackend;

    beforeEach(() => {
      backend = makeBackend();
    });

    it('upload returns the key', async () => {
      const key = await backend.upload('test/hello.txt', Buffer.from('hello'));
      expect(key).toBe('test/hello.txt');
    });

    it('download returns the uploaded buffer', async () => {
      const data = Buffer.from('hello world');
      await backend.upload('test/hello.txt', data);
      const result = await backend.download('test/hello.txt');
      expect(result).toEqual(data);
    });

    it('exists returns true after upload', async () => {
      await backend.upload('test/exists.txt', Buffer.from('x'));
      expect(await backend.exists('test/exists.txt')).toBe(true);
    });

    it('exists returns false for unknown key', async () => {
      expect(await backend.exists('test/no-such-file.txt')).toBe(false);
    });

    it('delete removes the file', async () => {
      await backend.upload('test/delete-me.txt', Buffer.from('bye'));
      await backend.delete('test/delete-me.txt');
      expect(await backend.exists('test/delete-me.txt')).toBe(false);
    });

    it('delete throws if file does not exist', async () => {
      await expect(backend.delete('test/ghost.txt')).rejects.toThrow('file not found');
    });

    it('download throws if file does not exist', async () => {
      await expect(backend.download('test/ghost.txt')).rejects.toThrow('file not found');
    });

    it('getUrl throws if file does not exist', async () => {
      await expect(backend.getUrl('test/ghost.txt')).rejects.toThrow('file not found');
    });

    it('upload accepts a ReadableStream', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('stream content'));
          controller.close();
        },
      });
      await backend.upload('test/stream.txt', stream);
      const result = await backend.download('test/stream.txt');
      expect(result.toString()).toBe('stream content');
    });
  });
}

// ============================================================================
// LocalStorageBackend
// ============================================================================

describe('LocalStorageBackend', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  runSharedTests('shared behaviours', () => new LocalStorageBackend(tmpDir));

  it('getUrl returns a file:// URI', async () => {
    const backend = new LocalStorageBackend(tmpDir);
    await backend.upload('img/photo.png', Buffer.from('data'));
    const url = await backend.getUrl('img/photo.png');
    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain('photo.png');
  });

  it('creates nested directories on upload', async () => {
    const backend = new LocalStorageBackend(tmpDir);
    await backend.upload('a/b/c/deep.txt', Buffer.from('deep'));
    const result = await backend.download('a/b/c/deep.txt');
    expect(result.toString()).toBe('deep');
  });

  it('overwrites an existing file on re-upload', async () => {
    const backend = new LocalStorageBackend(tmpDir);
    await backend.upload('test/overwrite.txt', Buffer.from('v1'));
    await backend.upload('test/overwrite.txt', Buffer.from('v2'));
    const result = await backend.download('test/overwrite.txt');
    expect(result.toString()).toBe('v2');
  });
});

// ============================================================================
// MemoryStorageBackend
// ============================================================================

describe('MemoryStorageBackend', () => {
  runSharedTests('shared behaviours', () => new MemoryStorageBackend());

  it('getUrl returns a memory:// URI', async () => {
    const backend = new MemoryStorageBackend();
    await backend.upload('img/photo.png', Buffer.from('data'));
    const url = await backend.getUrl('img/photo.png');
    expect(url).toBe('memory://img/photo.png');
  });

  it('clear removes all stored files', async () => {
    const backend = new MemoryStorageBackend();
    await backend.upload('a.txt', Buffer.from('a'));
    await backend.upload('b.txt', Buffer.from('b'));
    backend.clear();
    expect(backend.size()).toBe(0);
    expect(await backend.exists('a.txt')).toBe(false);
  });

  it('size reflects the number of uploaded files', async () => {
    const backend = new MemoryStorageBackend();
    expect(backend.size()).toBe(0);
    await backend.upload('a.txt', Buffer.from('a'));
    expect(backend.size()).toBe(1);
    await backend.upload('b.txt', Buffer.from('b'));
    expect(backend.size()).toBe(2);
    await backend.delete('a.txt');
    expect(backend.size()).toBe(1);
  });

  it('isolates state between instances', async () => {
    const b1 = new MemoryStorageBackend();
    const b2 = new MemoryStorageBackend();
    await b1.upload('file.txt', Buffer.from('in b1'));
    expect(await b1.exists('file.txt')).toBe(true);
    expect(await b2.exists('file.txt')).toBe(false);
  });
});
