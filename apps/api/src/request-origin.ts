import { isIPv4, isIPv6 } from "node:net";

function localIPv4(address: string) {
  const [a, b] = address.split(".").map(Number);
  return a === 127 || a === 10 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b! >= 64 && b! <= 127);
}

function localHostname(hostname: string) {
  if (hostname === "localhost") return true;
  if (isIPv4(hostname)) return localIPv4(hostname);
  const address = hostname.replace(/^\[|\]$/g, "");
  if (!isIPv6(address)) return false;
  if (address === "::1" || /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (!mapped) return false;
  const first = parseInt(mapped[1]!, 16), last = parseInt(mapped[2]!, 16);
  return localIPv4(`${first >>> 8}.${first & 255}.${last >>> 8}.${last & 255}`);
}

/** Local addresses follow the direct request, not proxy headers or a saved IP. */
export function isAllowedRequestOrigin(
  origin: string,
  host: string | undefined,
  encrypted: boolean,
  policy: { appUrl: string; production: boolean },
) {
  try {
    const candidate = new URL(origin);
    // Browser Origin headers contain only a canonical HTTP(S) origin.
    if (!["http:", "https:"].includes(candidate.protocol) || candidate.origin !== origin) return false;
    if (origin === new URL(policy.appUrl).origin) return true;
    if (!policy.production && ["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) return true;
    if (!host || /[\s/\\@?#,%]/.test(host)) return false;
    const direct = new URL(`${encrypted ? "https" : "http"}://${host}`);
    return direct.origin === origin && localHostname(direct.hostname);
  } catch {
    return false;
  }
}
