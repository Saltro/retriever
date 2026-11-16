import type { FeishuExtensionConfig } from '../../types.js';

export interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: unknown;
}

/** What the sender and the inbound enrichment need from a Feishu API client. */
export interface FeishuTransport {
  request<T = FeishuApiResponse>(
    pathAndQuery: string,
    options?: { method?: string; json?: unknown; timeoutMs?: number },
  ): Promise<T>;
  upload(pathAndQuery: string, form: FormData): Promise<FeishuApiResponse>;
  download(pathAndQuery: string, maxBytes?: number): Promise<Buffer>;
}

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

const BASE_URL = 'https://open.feishu.cn';

/** A stalled request must fail, so the event degrades to a note instead of hanging. */
const JSON_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 60_000;

/** Caches the tenant token and retries once when the token is the thing that expired. */
export class FeishuClient implements FeishuTransport {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private config: FeishuExtensionConfig) {}

  /** JSON in, JSON out: the shape of every endpoint except uploads and downloads. */
  async request<T = FeishuApiResponse>(
    pathAndQuery: string,
    options: { method?: string; json?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(options.json);
    }
    return this.withTokenRetry(async () => {
      const response = await this.send(
        pathAndQuery,
        { method: options.method || (body ? 'POST' : 'GET'), headers, body },
        options.timeoutMs ?? JSON_TIMEOUT_MS,
      );
      const payload = (await response.json().catch(() => ({}))) as FeishuApiResponse;
      fail('request', pathAndQuery, response, payload);
      return payload as T;
    });
  }

  async upload(pathAndQuery: string, form: FormData): Promise<FeishuApiResponse> {
    return this.withTokenRetry(async () => {
      const response = await this.send(
        pathAndQuery,
        { method: 'POST', body: form },
        TRANSFER_TIMEOUT_MS,
      );
      const payload = (await response.json().catch(() => ({}))) as FeishuApiResponse;
      fail('upload', pathAndQuery, response, payload);
      return payload;
    });
  }

  /** Message resources answer with the file itself, so the caller reads the body. */
  async download(pathAndQuery: string, maxBytes?: number): Promise<Buffer> {
    return this.withTokenRetry(async () => {
      const response = await this.send(pathAndQuery, {}, TRANSFER_TIMEOUT_MS);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Feishu download failed path=${pathAndQuery} http=${response.status} ${detail.slice(0, 200)}`,
        );
      }
      const declared = Number(response.headers.get('content-length'));
      if (maxBytes && Number.isFinite(declared) && declared > maxBytes)
        throw new Error(`too large: declared ${declared} bytes, limit ${maxBytes}`);
      return Buffer.from(await response.arrayBuffer());
    });
  }

  private async send(
    pathAndQuery: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const token = await this.getTenantAccessToken();
    return fetch(`${BASE_URL}${pathAndQuery}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async withTokenRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (!isTokenError(error)) throw error;
      this.token = null;
      this.tokenExpiresAt = 0;
      return fn();
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu requires FEISHU_APP_ID and FEISHU_APP_SECRET.');
    }
    const response = await fetch(`${BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as TenantTokenResponse;
    if (!response.ok || body.code || !body.tenant_access_token) {
      throw new Error(
        `Feishu token failed http=${response.status} code=${body.code ?? 'unknown'} msg=${body.msg ?? response.statusText}`,
      );
    }
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(1, body.expire ?? 7200) * 1000;
    return this.token;
  }
}

/** Feishu reports an expired token in the body of an HTTP 200, so both shapes must fail. */
function fail(
  kind: string,
  pathAndQuery: string,
  response: Response,
  payload: FeishuApiResponse,
): void {
  if (response.ok && !payload.code) return;
  throw new Error(
    `Feishu ${kind} failed path=${pathAndQuery} http=${response.status} code=${payload.code ?? 'unknown'} msg=${payload.msg ?? response.statusText}`,
  );
}

function isTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /token|99991663|99991664|99991665|99991668/i.test(message);
}
