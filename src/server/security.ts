/** Minimal request shape so security checks are unit-testable without a socket. */
export interface HttpLike {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface SecurityOptions {
  /** Browser allowlist, e.g. `["https://tikcraft.com","http://localhost:*"]`. */
  allowedOrigins?: string[];
}

function header(headers: HttpLike["headers"], name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function originOf(value: string): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/** Origin allowlist for browser calls — any other origin is rejected before it reaches a handler. */
export class Security {
  constructor(private readonly options: SecurityOptions) {}

  /** طلب متصفح من أصل مش في القائمة = مرفوض قبل أي تنفيذ. */
  rejectForeignOrigin(req: HttpLike): boolean {
    const raw = header(req.headers, "origin");
    return Boolean(raw) && !this.originAllowed(req);
  }

  /** Checks `Origin` (or `Referer` origin) against the configured allowlist. */
  originAllowed(req: HttpLike): boolean {
    const allowed = this.options.allowedOrigins;
    if (!allowed || allowed.length === 0) return true;

    const raw = header(req.headers, "origin") || header(req.headers, "referer");
    const origin = originOf(raw);
    if (!origin) return false;

    for (const entry of allowed) {
      if (entry === origin) return true;
      if (entry.endsWith(":*") && origin.startsWith(entry.slice(0, -1))) return true;
    }
    return false;
  }
}
