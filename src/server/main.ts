import { createLiveServer } from "./index.js";

const port = Number(process.env.PORT ?? 4000);
const origins = process.env.LIVE_ORIGINS
  ? process.env.LIVE_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
  : undefined;
const sessionTtl = Number(process.env.LIVE_SESSION_TTL_MS ?? 0);

const live = createLiveServer({
  secret: process.env.LIVE_SECRET,
  allowedOrigins: origins,
  requireAuth: process.env.LIVE_REQUIRE_AUTH === "1",
  requireSubscription: process.env.LIVE_REQUIRE_SUBSCRIPTION === "1",
  // سقف اتصالات TikTok المتزامنة — اضبطه حسب ذاكرة السيرفر
  maxUpstreams: Number(process.env.LIVE_MAX_UPSTREAMS) || undefined,
  apiUrl: process.env.TIKCRAFT_API_URL,
  internalApiKey: process.env.INTERNAL_API_KEY,
  // التحقق من توكن Supabase داخل السوكت (anon key عام، مش service role)
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  sessionTtlMs: sessionTtl > 0 ? sessionTtl : undefined,
  cookieSecure: process.env.LIVE_COOKIE_SECURE !== "0",
  cookieDomain: process.env.LIVE_COOKIE_DOMAIN || undefined,
  trustProxy: process.env.LIVE_TRUST_PROXY === "1",
  requestLog: process.env.LIVE_REQUEST_LOG === "1",
  // أخطاء جسر الـAPI والكتالوج تظهر في الكونسول بدل ما تتكتم
  onLog: (message: string) => console.log(message),
  // اختياري: كوكيز حساب تيك توك (sessionid=…; sid_tt=…) — تفتح بيانات غرف 18+ والمتابعين
  cookies: () => process.env.TIKTOK_COOKIES || undefined,
});

live.listen(port, () => {
  console.log(`tikcraft socket listening on :${port}`);
  console.log("POST /v1/sessions {username} → socket.io /socket.io (cookie)");
  console.log("GET /health · /v1/metrics · socket.io /socket.io");
});

function shutdown(): void {
  live.close().then(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
