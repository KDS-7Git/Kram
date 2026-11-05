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
  options: Omit<RequestInit, "body"> & { body?: unknown } = {},
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
  options: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<{ data: T; headers: Headers }> {
  const { body, ...init } = options;
  const method = options.method || "GET";
  if (!navigator.onLine && !["GET", "HEAD"].includes(method))
    throw new ApiIssue(
      "You are offline. Reconnect to save these changes.",
      "OFFLINE",
    );
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
    throw new ApiIssue(
      "Could not reach this Kram instance. Your changes stay in this form. Retry when it is available.",
      "NETWORK_ERROR",
    );
  }
  if (response.status === 204)
    return { data: undefined as T, headers: response.headers };
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
  return { data: result as T, headers: response.headers };
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not save. Keep this page open and retry.";
}
