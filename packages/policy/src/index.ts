import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return isIP(address) === 6 && /^[23]/i.test(address) && !address.toLowerCase().startsWith("2001:db8:");
}
export async function resolveAllowedUrl(
  raw: string,
  allowedOrigins: string[] = [],
): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only HTTP(S) URLs without credentials are supported.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  // Some local proxies answer every domain with a 198.18/15 fake IP. Resolve the
  // original hostname over HTTPS, then pin a validated public IP; never allow the fake range itself.
  if (
    !isIP(hostname) &&
    !allowedOrigins.includes(url.origin) &&
    addresses.length > 0 &&
    addresses.every(({ address }) => /^198\.(18|19)\./.test(address))
  ) {
    addresses = await resolvePublicIPv4(hostname);
  }
  const first = addresses[0];
  if (
    !first ||
    (!allowedOrigins.includes(url.origin) && addresses.some((item) => !publicAddress(item.address)))
  )
    throw new Error("Private network URLs are not allowed.");
  return { url, ...first };
}

const dnsCache = new Map<string, { expires: number; addresses: { address: string; family: number }[] }>();
export async function resolvePublicIPv4(hostname: string): Promise<{ address: string; family: number }[]> {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.addresses;
  const endpoint = new URL("https://cloudflare-dns.com/dns-query");
  endpoint.searchParams.set("name", hostname);
  endpoint.searchParams.set("type", "A");
  const response = await fetch(endpoint, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Public DNS lookup failed");
  const data = (await response.json()) as {
    Status?: number;
    Answer?: { type?: number; data?: string; TTL?: number }[];
  };
  const answers = Array.isArray(data.Answer) ? data.Answer.filter((item) => item.type === 1) : [];
  if (
    data.Status !== 0 ||
    answers.length === 0 ||
    answers.some(
      (item) => typeof item.data !== "string" || isIP(item.data) !== 4 || !publicAddress(item.data),
    )
  )
    throw new Error("Public DNS did not return a public address");
  const addresses = answers.map((item) => ({ address: item.data ?? "", family: 4 }));
  const ttl = Math.min(60, ...answers.map((item) => Math.max(0, item.TTL ?? 0)));
  if (dnsCache.size >= 500) dnsCache.clear();
  dnsCache.set(hostname, { addresses, expires: Date.now() + ttl * 1000 });
  return addresses;
}
