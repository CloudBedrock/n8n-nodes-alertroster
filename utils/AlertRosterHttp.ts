import { IDataObject, IHttpRequestMethods } from 'n8n-workflow';

/**
 * Refuse to send credentials over cleartext HTTP. Plain HTTP is allowed only
 * for loopback hosts so local development still works.
 */
export function assertSecureBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`AlertRoster: invalid Base URL "${baseUrl}". Use a full https:// URL.`);
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error(
      `AlertRoster: refusing to send credentials over insecure ${url.protocol}// to "${url.hostname}". ` +
        'Use an https:// Base URL (http:// is permitted only for localhost).',
    );
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  assertSecureBaseUrl(trimmed);
  return trimmed;
}

export class AlertRosterHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'AlertRosterHttpError';
  }
}

export interface AlertRosterRequestOptions {
  body?: IDataObject;
  qs?: IDataObject;
  /** Bearer token for this request. Omit for unauthenticated routes. */
  token?: string;
}

/**
 * Thin HTTP client for the AlertRoster REST API. One generic request method
 * that serialises query/body, injects a Bearer token, and surfaces the server's
 * `{"error": "…"}` code. Zero runtime dependencies (Node 20 fetch).
 */
export class AlertRosterHttp {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(baseUrl: string, timeout = 30000) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeout = timeout;
  }

  async request<T = IDataObject>(
    method: IHttpRequestMethods,
    path: string,
    options: AlertRosterRequestOptions = {},
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;

    if (options.qs && Object.keys(options.qs).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.qs)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            params.append(`${key}[]`, String(item));
          }
        } else {
          params.append(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body:
          method !== 'GET' && method !== 'HEAD' && options.body
            ? JSON.stringify(options.body)
            : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed = parseBody(text);

      if (!response.ok) {
        const { code, detail } = describeError(parsed, text || response.statusText);
        throw new AlertRosterHttpError(
          response.status,
          code,
          `HTTP ${response.status}: ${detail}`,
          parsed,
        );
      }

      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseBody(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * AlertRoster errors are `{"error": "<code>"}`, optionally with `details`
 * (a field → messages map on 422) or `scope` (on 403 insufficient_scope).
 */
function describeError(parsed: unknown, fallback: string): { code?: string; detail: string } {
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as IDataObject;
    const code = typeof obj.error === 'string' ? obj.error : undefined;
    const parts: string[] = [];
    if (code) {
      parts.push(code);
    }
    if (typeof obj.scope === 'string') {
      parts.push(`(requires scope ${obj.scope})`);
    }
    if (obj.details && typeof obj.details === 'object') {
      const details = obj.details as Record<string, unknown>;
      const fields = Object.entries(details).map(
        ([field, messages]) =>
          `${field} ${Array.isArray(messages) ? messages.join(', ') : String(messages)}`,
      );
      if (fields.length) {
        parts.push(fields.join('; '));
      }
    }
    if (parts.length) {
      return { code, detail: parts.join(' ') };
    }
  }
  return { detail: fallback };
}
