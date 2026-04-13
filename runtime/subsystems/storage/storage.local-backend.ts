/**
 * Storage subsystem — local filesystem backend
 *
 * Writes files to `{basePath}/{key}` on the local filesystem.
 * Suitable for development only — use an S3/GCS backend in production.
 *
 * - Creates intermediate directories automatically (mkdirSync recursive)
 * - getUrl returns a `file://` URI pointing to the absolute path
 * - All methods throw on failure
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { Readable } from 'stream';
import type { IStorageService } from './storage.protocol';

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

  async getUrl(key: string, expiresInSeconds?: number): Promise<string> {
    const filePath = this.resolvePath(key);
    if (!existsSync(filePath)) {
      throw new Error(`Storage: file not found: ${key}`);
    }
    return `file://${filePath}`;
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.resolvePath(key));
  }

  private resolvePath(key: string): string {
    return join(this.basePath, key);
  }
}

async function toBuffer(data: Buffer | ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  // Convert ReadableStream (Web Streams API) to Buffer
  const reader = (data as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}
