import { createHash } from 'node:crypto';

import { IDataObject, IHttpRequestMethods } from 'n8n-workflow';

import {
  AlertRosterDownload,
  AlertRosterHttp,
  AlertRosterHttpError,
  AlertRosterRequestOptions,
} from './AlertRosterHttp';

export interface ResponderCredentials {
  baseUrl: string;
  email: string;
  password: string;
  accountId?: string;
}

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account: { id: string; name: string; slug: string };
  user: { id: string; name: string; email: string; role: string };
}

interface CachedToken {
  token: string;
  /** Epoch milliseconds after which the token must not be reused. */
  expiresAt: number;
  accountId: string;
  userId: string;
}

// Sign in again this long before the server would expire the token, so a
// request started near the boundary does not land on a stale token.
const EXPIRY_MARGIN_MS = 60_000;

/**
 * The cache identity of a responder credential: everything that decides
 * which token a login mints. Two credentials with the same email but a
 * different password or account must never share a token, so those are
 * folded in as a digest rather than left out of the key.
 */
export function credentialIdentity(credentials: ResponderCredentials): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([credentials.password, credentials.accountId ?? '']))
    .digest('hex')
    .slice(0, 16);
  return `${credentials.baseUrl.replace(/\/+$/, '')}:${credentials.email}:${digest}`;
}

/** Where a session keeps its token in the cache object it is given. */
export function cacheKeyFor(identity: string): string {
  return `alertroster:responder:${identity}`;
}

/**
 * A responder-token session: signs in with email + password, caches the
 * short-lived access token in the static-data object it is given (per
 * credential, shared by every node in the workflow), and signs in again when
 * the token expires or the server rejects it.
 *
 * Refresh tokens are deliberately not used. AlertRoster revokes a whole token
 * family on refresh-token reuse, and two concurrent executions sharing one
 * cache would trip that detection. A fresh login every 15 minutes stays far
 * under the per-IP login throttle.
 */
export class ResponderSession {
  private readonly http: AlertRosterHttp;
  private readonly cacheKey: string;

  constructor(
    private readonly credentials: ResponderCredentials,
    private readonly staticData: IDataObject,
  ) {
    this.http = new AlertRosterHttp(credentials.baseUrl);
    this.cacheKey = cacheKeyFor(credentialIdentity(credentials));
  }

  /** The signed-in account id, signing in first if needed. */
  async accountId(): Promise<string> {
    return (await this.session()).accountId;
  }

  /** The signed-in user id, signing in first if needed. */
  async userId(): Promise<string> {
    return (await this.session()).userId;
  }

  async request<T = IDataObject>(
    method: IHttpRequestMethods,
    path: string,
    options: Omit<AlertRosterRequestOptions, 'token'> = {},
  ): Promise<T> {
    return this.withToken((token) => this.http.request<T>(method, path, { ...options, token }));
  }

  /** `AlertRosterHttp.download` on this session, for a route that serves a file. */
  async download(
    method: IHttpRequestMethods,
    path: string,
    options: Omit<AlertRosterRequestOptions, 'token'> = {},
  ): Promise<AlertRosterDownload> {
    return this.withToken((token) => this.http.download(method, path, { ...options, token }));
  }

  private async withToken<T>(send: (token: string) => Promise<T>): Promise<T> {
    const session = await this.session();
    try {
      return await send(session.token);
    } catch (error) {
      // A 401 on an otherwise-valid session means the token was revoked
      // (logout elsewhere, family revocation). Sign in once and retry.
      if (error instanceof AlertRosterHttpError && error.status === 401) {
        this.forget();
        const fresh = await this.session();
        return await send(fresh.token);
      }
      throw error;
    }
  }

  private async session(): Promise<CachedToken> {
    const cached = this.staticData[this.cacheKey] as CachedToken | undefined;
    if (cached && cached.expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
      return cached;
    }
    const fresh = await this.login();
    this.staticData[this.cacheKey] = fresh;
    return fresh;
  }

  private forget(): void {
    delete this.staticData[this.cacheKey];
  }

  private async login(): Promise<CachedToken> {
    const body: IDataObject = {
      email: this.credentials.email,
      password: this.credentials.password,
    };
    if (this.credentials.accountId) {
      body.account_id = this.credentials.accountId;
    }

    let response: LoginResponse;
    try {
      response = await this.http.request<LoginResponse>('POST', '/api/v1/auth/login', { body });
    } catch (error) {
      if (error instanceof AlertRosterHttpError) {
        if (error.code === 'account_choice_required') {
          const accounts = ((error.body as IDataObject).accounts ?? []) as IDataObject[];
          const list = accounts.map((a) => `${a.name ?? a.slug ?? ''} (${a.id})`).join(', ');
          throw new Error(
            `AlertRoster: this email belongs to more than one account. Set Account ID on the credential to one of: ${list}`,
          );
        }
        if (error.status === 401) {
          throw new Error(
            'AlertRoster: sign-in failed (invalid_credentials). Check the email and password, and that this responder has a password set in AlertRoster settings.',
          );
        }
        if (error.status === 429) {
          throw new Error(
            'AlertRoster: sign-in rate limited (30 password logins per 15 minutes per IP). Wait and retry.',
          );
        }
      }
      throw error;
    }

    return {
      token: response.access_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      accountId: response.account.id,
      userId: response.user.id,
    };
  }
}
