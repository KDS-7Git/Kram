import { offline, clearOfflineAccount, setOfflineAccount, restoreOfflineAccount, readCached, cacheRead, queueProgress, projectQueuedTask } from "./offline";
import type { ProgressInput, Bootstrap } from "@kram/shared";
import type { ApiError, Settings, User } from "@kram/shared";

export interface AuthMe {
  user: User | null;
  setupRequired: boolean;
  csrfToken: string;
  defaults: Settings;
  setupAllowed: boolean;
  setupTokenRequired: boolean;
}
let csrfToken = "";

export class ApiIssue extends Error {
  code: string;
  details?: unknown;
  status?: number;
  constructor(
    message: string,
    code = "REQUEST_FAILED",
    details?: unknown,
    status?: number,
  ) {
    super(message);
    this.name = "ApiIssue";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  options: Omit<RequestInit, "body"> & { body?: unknown; skipOfflineQueue?: boolean } = {},
): Promise<T> {
  return (await request<T>(path, options)).data;
}

export async function apiList<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams(path.split("?")[1]);
    query.set("limit", "200");
    if (cursor) query.set("cursor", cursor);
    const response = await request<T[]>(`${path.split("?")[0]}?${query}`, {
      signal,
    });
    items.push(...response.data);
    cursor = response.headers.get("X-Next-Cursor");
    if (cursor && cursors.has(cursor))
      throw new ApiIssue("The list could not finish loading. Please retry.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

async function request<T>(
  path: string,
  options: Omit<RequestInit, "body"> & { body?: unknown; skipOfflineQueue?: boolean } = {},
): Promise<{ data: T; headers: Headers }> {
  const { body, skipOfflineQueue, ...init } = options;
  const method = options.method || "GET";
  const requestAccount=offline.currentAccount();
  const eventTask = method === 'POST' && /^\/tasks\/[a-f\d-]+\/events$/i.test(path) ? path.split('/')[2] : null;
  const queue = async () => {
    if (!eventTask || skipOfflineQueue) throw new ApiIssue('You are offline. Reconnect to save these changes.', 'OFFLINE');
    const input = body as ProgressInput;
    await queueProgress(eventTask, input);
    const task = await projectQueuedTask(eventTask, input);
    return { data: { queued: true, task } as T, headers: new Headers() };
  };
  const cached = async () => {
    if(!offline.currentAccount())await restoreOfflineAccount();
    if(requestAccount&&offline.currentAccount()!==requestAccount)throw new ApiIssue('Sign in to load this account’s saved pages.','UNAUTHENTICATED',undefined,401);
    if (path === '/auth/me') {
      const saved = await readCached<{data:Bootstrap;headers:[string,string][]}>('/bootstrap');
      if (saved) return {data:{user:saved.data.data.user,csrfToken:'',setupRequired:false,defaults:saved.data.data.user.settings,setupAllowed:false,setupTokenRequired:false} as T,headers:new Headers()};
    }
    const saved = await readCached<{data:T;headers:[string,string][]}>(path);
    if (!saved) throw new ApiIssue('This page has no saved offline copy. Open it once while connected.', 'OFFLINE_UNAVAILABLE');
    window.dispatchEvent(new CustomEvent('kram-cache-status',{detail:{cached:true,savedAt:saved.savedAt}}));
    return {data:saved.data.data,headers:new Headers(saved.data.headers)};
  };
  if (!navigator.onLine) return ['GET','HEAD'].includes(method) ? cached() : queue();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD"].includes(method)) headers.set("X-CSRF-Token", csrfToken);
  if (
    body &&
    typeof body === "object" &&
    "clientEventId" in body &&
    typeof body.clientEventId === "string"
  )
    headers.set("Idempotency-Key", body.clientEventId);
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (['GET','HEAD'].includes(method)) { try { return await cached(); } catch { /* Show the connection failure if no saved page exists. */ } }
    if (eventTask && !skipOfflineQueue) return queue();
    throw new ApiIssue(
      "Could not reach this Kram instance. Your changes stay in this form. Retry when it is available.",
      "NETWORK_ERROR",
    );
  }
  if (response.status === 204) {
    if(path==='/auth/logout')await clearOfflineAccount().catch(()=>undefined);
    return { data: undefined as T, headers: response.headers };
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiIssue(
      "The server did not return a readable response. Retry in a moment.",
      "BAD_RESPONSE",
    );
  }
  if (!response.ok) {
    const error = result as ApiError;
    throw new ApiIssue(
      error.error?.message ||
        "Could not save. Your changes remain in this form.",
      error.error?.code || "REQUEST_FAILED",
      error.error?.details,
      response.status,
    );
  }
  if (
    result &&
    typeof result === "object" &&
    "csrfToken" in result &&
    typeof result.csrfToken === "string"
  )
    csrfToken = result.csrfToken;
  if (path.startsWith('/auth/') && result && typeof result === 'object' && 'user' in result) {
    const user = result.user as User | null;
    await setOfflineAccount(user?.id ?? null).catch(()=>undefined);
  }
  if (path === '/auth/logout') await clearOfflineAccount().catch(()=>undefined);
  if (method === 'GET') {
    await cacheRead(path, {data:result,headers:[...response.headers.entries()]},requestAccount).catch(()=>undefined);
    if(path==='/bootstrap')window.dispatchEvent(new CustomEvent('kram-cache-status',{detail:{cached:false}}));
  }
  return { data: result as T, headers: response.headers };
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not save. Keep this page open and retry.";
}
