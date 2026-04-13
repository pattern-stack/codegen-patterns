/**
 * Storage subsystem — protocol (port)
 *
 * IStorageService is the hexagonal port. Use cases inject this interface via
 * STORAGE token. They never depend on a specific backend implementation.
 *
 * All methods throw on failure — callers must handle upload/download errors
 * explicitly. There is no null-return behavior like CacheService.
 *
 * Users who need cloud storage (S3, GCS, R2) implement this interface
 * directly. No Drizzle backend exists — files in Postgres is an antipattern.
 */

// ============================================================================
// IStorageService
// ============================================================================

export interface IStorageService {
  /**
   * Upload a file and return the stored key (same as the input key).
   *
   * @param key - Storage key / path (e.g. 'avatars/user-123.png')
   * @param data - File contents as a Buffer or a ReadableStream
   * @param contentType - Optional MIME type (e.g. 'image/png')
   * @returns The stored key
   * @throws On any write failure
   */
  upload(key: string, data: Buffer | ReadableStream, contentType?: string): Promise<string>;

  /**
   * Download a file by key and return its contents as a Buffer.
   *
   * @throws If the file does not exist or cannot be read
   */
  download(key: string): Promise<Buffer>;

  /**
   * Delete a file by key.
   *
   * @throws If the file does not exist or cannot be deleted
   */
  delete(key: string): Promise<void>;

  /**
   * Return a URL for accessing the file.
   *
   * For local backend: returns a `file://` URI.
   * For cloud backends: returns a presigned URL that expires after `expiresInSeconds`.
   *
   * @param key - Storage key
   * @param expiresInSeconds - URL expiry (ignored by local/memory backends)
   * @throws If the file does not exist
   */
  getUrl(key: string, expiresInSeconds?: number): Promise<string>;

  /**
   * Check whether a file exists at the given key.
   *
   * @returns `true` if the file exists, `false` otherwise
   * @throws Only on unexpected I/O errors (not on simple absence)
   */
  exists(key: string): Promise<boolean>;
}
