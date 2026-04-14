/**
 * Storage subsystem — local filesystem backend
 *
 * Writes files to `{basePath}/{key}` on the local filesystem.
 * Suitable for development only — use an S3/GCS backend in production.
 *
 * - Creates intermediate directories automatically (mkdirSync recursive)
 * - getUrl returns a `file://` URI pointing to the absolute path
 * - All methods throw on failure
 * - resolvePath validates against path traversal attacks
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { Readable } from 'stream';
import type { IStorageService } from './storage.protocol';
import { toBuffer } from './storage.utils';

export class LocalStorageBackend implements IStorageService {
  private readonly basePath: string;

  constructor(basePath: string = './storage') {
    this.basePath = resolve(basePath);
  }

  async upload(key: string, data: Buffer | ReadableStream, contentType?: string): Promise<string> {
    const filePath = this.resolvePath(key);
    mkdirSync(dirname(filePath), { recursive: true });

    const buffer = await toBuffer(data);
    writeFileSync(filePath, buffer);
    return key;
  }

  async download(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);
    if (!existsSync(filePath)) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    return readFileSync(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    if (!existsSync(filePath)) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    unlinkSync(filePath);
  }

  async getUrl(key: string, _expiresInSeconds?: number): Promise<string> {
    const filePath = this.resolvePath(key);
    if (!existsSync(filePath)) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    return `file://${filePath}`;
  }

  async exists(key: string): Promise<boolean> {
    try {
      return existsSync(this.resolvePath(key));
    } catch {
      // resolvePath throws on traversal attempt — treat as non-existent
      return false;
    }
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = this.listRecursive(this.basePath);
    if (prefix === undefined) return keys;
    return keys.filter((k) => k.startsWith(prefix));
  }

  async downloadStream(key: string): Promise<ReadableStream> {
    const filePath = this.resolvePath(key);
    if (!existsSync(filePath)) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    const nodeStream = createReadStream(filePath);
    return Readable.toWeb(nodeStream) as ReadableStream;
  }

  private resolvePath(key: string): string {
    const resolved = resolve(this.basePath, key);
    if (!resolved.startsWith(this.basePath + sep)) {
      throw new Error(`Invalid storage key (path traversal attempt): ${key}`);
    }
    return resolved;
  }

  /** Recursively list all files under dir, returning keys relative to basePath. */
  private listRecursive(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const keys: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        keys.push(...this.listRecursive(full));
      } else {
        keys.push(relative(this.basePath, full));
      }
    }
    return keys;
  }
}
