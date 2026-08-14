import dns from "node:dns/promises";
import net from "node:net";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      p[0] === 0
    );
  }

  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
  }

  return true;
}

async function validatePublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Local addresses are not allowed.");
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Private or local network addresses are not allowed.");
  }

  return url;
}

export default async function handler(request) {
  if (request.method !== "GET") {
    return json({ error: "Only GET requests are allowed." }, 405);
  }

  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url")?.trim();
  if (!target) {
    return json({ error: "Missing url query parameter." }, 400);
  }

  try {
    const url = await validatePublicHttpUrl(target);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "DIG-GPT-Web/1.0",
          "Accept": "text/html,application/json,text/plain;q=0.9,*/*;q=0.5"
        }
      });

      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_BYTES) {
        return json({ error: "Remote response is too large." }, 413);
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_BYTES) {
        return json({ error: "Remote response is too large." }, 413);
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const textLike = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(contentType);

      if (!textLike) {
        return json({
          ok: response.ok,
          status: response.status,
          url: response.url,
          contentType,
          bytes: buffer.byteLength,
          body: null
        });
      }

      const body = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      return json({
        ok: response.ok,
        status: response.status,
        url: response.url,
        contentType,
        bytes: buffer.byteLength,
        body
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return json(
      { error: timedOut ? "The remote request timed out." : (error?.message || "Request failed.") },
      timedOut ? 504 : 400
    );
  }
}
