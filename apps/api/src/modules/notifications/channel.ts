import { readFileSync } from 'node:fs';

export interface NtfyConfiguration { baseUrl: string; topic: string; token: string }
export type NtfyConfigurationResult = { configured: true; value: NtfyConfiguration } | { configured: false; errorCode: 'CHANNEL_NOT_CONFIGURED' | 'CHANNEL_CONFIG_INVALID' };

/** Only an explicitly configured topic and credential enable outbound access. */
export function ntfyConfiguration(): NtfyConfigurationResult {
  let token = process.env.NTFY_TOKEN?.trim() || '';
  try {
    if (process.env.NTFY_TOKEN_FILE) token = readFileSync(process.env.NTFY_TOKEN_FILE, 'utf8').trim() || token;
    const base = process.env.NTFY_BASE_URL?.trim(), topic = process.env.NTFY_TOPIC?.trim();
    if (!base || !topic || !token) return { configured: false, errorCode: 'CHANNEL_NOT_CONFIGURED' };
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^[a-zA-Z0-9_-]{1,128}$/.test(topic) || token.length > 4096) return { configured: false, errorCode: 'CHANNEL_CONFIG_INVALID' };
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return { configured: true, value: { baseUrl: url.toString(), topic, token } };
  } catch { return { configured: false, errorCode: 'CHANNEL_CONFIG_INVALID' }; }
}

export interface ChannelOutcome { accepted: boolean; httpStatus: number | null; errorCode: string | null }

/** Acceptance is an ntfy receipt; it does not prove phone display or a read. */
export async function publishNtfy(channel: NtfyConfiguration, message: { title: string; body: string; priority?: number; click?: string }): Promise<ChannelOutcome> {
  try {
    const response = await fetch(channel.baseUrl, {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${channel.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: channel.topic, title: message.title, message: message.body, priority: message.priority ?? 3, ...(message.click ? { click: message.click } : {}) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { accepted: false, httpStatus: response.status, errorCode: response.status === 401 || response.status === 403 ? 'CHANNEL_AUTH_FAILED' : 'CHANNEL_HTTP_FAILED' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { accepted: false, httpStatus: response.status, errorCode: 'CHANNEL_RESPONSE_INVALID' };
    let body = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        body += decoder.decode(value, { stream: true });
        if (body.length > 64000) { await reader.cancel(); return { accepted: false, httpStatus: response.status, errorCode: 'CHANNEL_RESPONSE_INVALID' }; }
      }
    } finally { reader.releaseLock(); }
    try {
      const receipt: unknown = JSON.parse(body);
      if (!receipt || typeof receipt !== 'object' || !('id' in receipt) || typeof receipt.id !== 'string' || !receipt.id || !('topic' in receipt) || receipt.topic !== channel.topic) return { accepted: false, httpStatus: response.status, errorCode: 'CHANNEL_RESPONSE_INVALID' };
    } catch { return { accepted: false, httpStatus: response.status, errorCode: 'CHANNEL_RESPONSE_INVALID' }; }
    return { accepted: true, httpStatus: response.status, errorCode: null };
  } catch { return { accepted: false, httpStatus: null, errorCode: 'CHANNEL_UNREACHABLE' }; }
}
