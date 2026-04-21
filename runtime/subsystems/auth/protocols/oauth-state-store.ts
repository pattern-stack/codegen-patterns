/**
 * Auth subsystem — `IOAuthStateStore` port.
 *
 * CSRF protection for the OAuth2 authorize-code callback. Generic across
 * providers. Concrete backends live under `../backends/oauth-state-store/`.
 */
export interface OAuthStateEntry {
  userId: string;
  createdAt: Date;
}

export interface IOAuthStateStore {
  put(state: string, entry: OAuthStateEntry): Promise<void>;
  /** Single-use consume: returns entry if present + valid, deletes it. */
  consume(state: string): Promise<OAuthStateEntry | null>;
}
