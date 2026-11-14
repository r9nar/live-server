import type { IncomingMessage, ServerResponse } from "node:http";

/** Error payload shared by every endpoint. */
export type Failure = {
  ok: false;
  status: number;
  error: string;
  code?: string;
  retryAfterMs?: number;
};

/** Request id per in-flight response, echoed in error bodies. */
export const requestIds = new WeakMap<ServerResponse, string>();

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  402: "SUBSCRIPTION_REQUIRED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
  502: "UPSTREAM_ERROR",
  503: "UNAVAILABLE",
};

export function codeFor(status: number): string {
  return STATUS_CODES[status] ?? (status >= 500 ? "INTERNAL" : "ERROR");
}

export function header(headers: IncomingMessage["headers"], name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = header(req.headers, "x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function bearerToken(req: IncomingMessage): string {
  const value = header(req.headers, "authorization");
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
