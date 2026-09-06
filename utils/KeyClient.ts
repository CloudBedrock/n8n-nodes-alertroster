import { IDataObject, IHttpRequestMethods } from 'n8n-workflow';

import { AlertRosterHttp, AlertRosterRequestOptions } from './AlertRosterHttp';

export type Lane = 'async' | 'sync';

const LANE_PREFIXES: Record<Lane, string[]> = {
  async: ['ark_async_'],
  sync: ['ark_sync_', 'art_'],
};

const LANE_LABELS: Record<Lane, string> = {
  async: 'Event operations need a source integration key starting with ark_async_',
  sync: 'Incident operations need a source integration key starting with ark_sync_ or an account API token starting with art_',
};

/**
 * Bearer-key client for the Lane A / Lane B routes. Checks the key prefix
 * against the lane before sending, because the server answers every
 * credential problem with the same bare 401.
 */
export class KeyClient {
  private readonly http: AlertRosterHttp;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly lane: Lane,
  ) {
    this.http = new AlertRosterHttp(baseUrl);
    const key = apiKey.trim();
    if (!LANE_PREFIXES[lane].some((prefix) => key.startsWith(prefix))) {
      const shown = key.length > 12 ? `${key.slice(0, 12)}…` : key;
      throw new Error(`AlertRoster: ${LANE_LABELS[lane]} (got "${shown}").`);
    }
  }

  /** True when the key is an account API token, which must name a source_id on create. */
  get isAccountToken(): boolean {
    return this.apiKey.trim().startsWith('art_');
  }

  async request<T = IDataObject>(
    method: IHttpRequestMethods,
    path: string,
    options: Omit<AlertRosterRequestOptions, 'token'> = {},
  ): Promise<T> {
    return this.http.request<T>(method, path, { ...options, token: this.apiKey.trim() });
  }
}
