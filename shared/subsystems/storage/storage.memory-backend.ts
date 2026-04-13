/**
 * Storage subsystem — in-memory backend
 *
 * Stores files as Buffers in a Map. Intended for unit tests only.
 * All state is lost when the process exits.
 *
 * - getUrl returns `memory://{key}` (not a real URL, useful for assertions)
 * - All methods throw on failure (missing keys, etc.)
 */
import type { IStorageService } from './storage.protocol';

interface MemoryEntry {
  data: Buffer;
  contentType?: string;
}

export class MemoryStorageBackend implements IStorageService {
  private readonly store = new Map<string, MemoryEntry>();

  async upload(key: string, data: Buffer | ReadableStream, contentType?: string): Promise<string> {
    const buffer = await toBuffer(data);
    this.store.set(key, { data: buffer, contentType });
    return key;
  }

  async download(key: string): Promise<Buffer> {
    const entry = this.store.get(key);
    if (!entry) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    return entry.data;
  }

  async delete(key: string): Promise<void> {
    if (!this.store.has(key)) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    this.store.delete(key);
  }

  async getUrl(key: string, expiresInSeconds?: number): Promise<string> {
    if (!this.store.has(key)) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    return `memory://${key}`;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  /** Clear all stored files. Useful for test teardown. */
  clear(): void {
    this.store.clear();
  }

  /** Return number of stored files. Useful for test assertions. */
  size(): number {
    return this.store.size;
  }
}

async function toBuffer(data: Buffer | ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  const reader = (data as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}
