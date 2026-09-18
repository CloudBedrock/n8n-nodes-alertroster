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

/** A response kept as bytes, for a route that serves a file. */
export interface AlertRosterDownload {
  body: Buffer;
  contentType: string;
  /** From `content-disposition`, when the server names the file. */
  fileName?: string;
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
    return this.send(method, path, options, async (response) => {
      const text = await response.text();
      const parsed = parseBody(text);
      if (!response.ok) {
        throw errorFrom(response, parsed, text);
      }
      return parsed as T;
    });
  }

  /**
   * Like `request`, but keeps the body as bytes and reads the content type
   * and the `content-disposition` filename, for a route that serves a file.
   * Errors are still the server's JSON and are raised the same way.
   */
  async download(
    method: IHttpRequestMethods,
    path: string,
    options: AlertRosterRequestOptions = {},
  ): Promise<AlertRosterDownload> {
    return this.send(method, path, { ...options, accept: '*/*' }, async (response) => {
      if (!response.ok) {
        const text = await response.text();
        throw errorFrom(response, parseBody(text), text);
      }
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        fileName: fileNameFrom(response.headers.get('content-disposition')),
      };
    });
  }

  /**
   * One request, with the timeout covering the whole exchange: the body is
   * consumed inside the same window as the headers, so a stalled transfer is
   * aborted rather than waited on forever.
   */
  private async send<T>(
    method: IHttpRequestMethods,
    path: string,
    options: AlertRosterRequestOptions & { accept?: string },
    consume: (response: Response) => Promise<T>,
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
      Accept: options.accept ?? 'application/json',
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
      return await consume(response);
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorFrom(response: Response, parsed: unknown, text: string): AlertRosterHttpError {
  const { code, detail } = describeError(parsed, text || response.statusText);
  return new AlertRosterHttpError(
    response.status,
    code,
    `HTTP ${response.status}: ${detail}`,
    parsed,
  );
}

/**
 * The file name a `content-disposition` header carries, reduced to a bare
 * name: the header is the server's, so a path or a control character in it
 * must not reach a downstream file node. RFC 5987 `filename*=` is
 * percent-decoded; the plain `filename=` form is not, and a decode that
 * fails leaves the raw name.
 */
export function fileNameFrom(disposition: string | null): string | undefined {
  if (!disposition) {
    return undefined;
  }
  const match = /filename(\*)?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (!match) {
    return undefined;
  }
  let name = match[2];
  if (match[1]) {
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
  }
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f]/g, '').trim();
  return clean || undefined;
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
