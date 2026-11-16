import type { FeishuExtensionConfig } from '../../types.js';

export interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: unknown;
}

interface TenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

const BASE_URL = 'https://open.feishu.cn';

/** Caches the tenant token and retries once when the token is the thing that expired. */
export class FeishuClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private config: FeishuExtensionConfig) {}

  /** JSON in, JSON out: the shape of every endpoint except uploads and downloads. */
  async request<T = FeishuApiResponse>(
    pathAndQuery: string,
    options: { method?: string; json?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(options.json);
    }
    const response = await this.requestRaw(pathAndQuery, {
      method: options.method || (body ? 'POST' : 'GET'),
      headers,
      body,
    });
    const payload = (await response.json().catch(() => ({}))) as FeishuApiResponse;
    if (!response.ok || payload.code) {
      throw new Error(
        `Feishu request failed path=${pathAndQuery} http=${response.status} code=${payload.code ?? 'unknown'} msg=${payload.msg ?? response.statusText}`,
      );
    }
    return payload as T;
  }

  async upload(pathAndQuery: string, form: FormData): Promise<FeishuApiResponse> {
    const response = await this.requestRaw(pathAndQuery, { method: 'POST', body: form });
    const payload = (await response.json().catch(() => ({}))) as FeishuApiResponse;
    if (!response.ok || payload.code) {
      throw new Error(
        `Feishu upload failed path=${pathAndQuery} http=${response.status} code=${payload.code ?? 'unknown'} msg=${payload.msg ?? response.statusText}`,
      );
    }
    return payload;
  }

  /** Message resources answer with the file itself, so the caller reads the body. */
  async download(pathAndQuery: string): Promise<Buffer> {
    const response = await this.requestRaw(pathAndQuery);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Feishu download failed path=${pathAndQuery} http=${response.status} ${detail.slice(0, 200)}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async requestRaw(pathAndQuery: string, init: RequestInit = {}): Promise<Response> {
    return this.withTokenRetry(async () => {
      const token = await this.getTenantAccessToken();
      return fetch(`${BASE_URL}${pathAndQuery}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
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

function isTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /token|99991663|99991664|99991665|99991668/i.test(message);
}
