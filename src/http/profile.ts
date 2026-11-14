import { randomUa } from "./ua.js";

/** إحصائيات البروفايل العامة (متابعين/متابَعين/لايكات) + الصورة. */
export interface ProfileStats {
  nickname: string;
  avatar: string;
  followers: number | null;
  following: number | null;
  hearts: number | null;
}

/**
 * نسخة `embed` من صفحة الحساب بترجّع بيانات البروفايل من غير تسجيل دخول
 * (الصفحة العادية بترجّع تحدي/حجب، و`room/info` بيفشل في غرف 18+).
 * النتيجة cached 10 دقائق لأن الصفحة ~300KB.
 */
const cache = new Map<string, { value: ProfileStats | null; expiresAt: number }>();
const TTL_MS = 10 * 60_000;

function readNumber(html: string, key: string): number | null {
  const match = html.match(new RegExp(`"${key}":(\\d+)`));
  return match ? Number(match[1]) : null;
}

function readText(html: string, key: string): string {
  const match = html.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return "";
  }
}

export async function fetchProfileStats(
  username: string,
  timeoutMs = 10_000,
): Promise<ProfileStats | null> {
  const clean = username.trim().replace(/^@/, "");
  if (!clean) return null;

  const cached = cache.get(clean);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let value: ProfileStats | null = null;
  try {
    const response = await fetch(`https://www.tiktok.com/embed/@${encodeURIComponent(clean)}`, {
      headers: { "User-Agent": randomUa(), "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const html = await response.text();
      const followers = readNumber(html, "followerCount");
      if (followers !== null) {
        value = {
          nickname: readText(html, "nickname"),
          avatar: readText(html, "avatarLarger") || readText(html, "avatarThumb"),
          followers,
          following: readNumber(html, "followingCount"),
          hearts: readNumber(html, "heartCount"),
        };
      }
    }
  } catch {
    value = null;
  }

  cache.set(clean, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}
