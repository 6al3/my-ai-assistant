import { BASE_SYSTEM_PROMPT, getAgentPrompt } from './agent-prompts.js';

const MAX_MESSAGE_CHARS = 20000;
const MAX_HISTORY_ITEMS = 32;
const MAX_HISTORY_CHARS = 80000;
const REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TOKENS = 1800;
const MAX_WEB_URLS = 3;
const MAX_WEB_CHARS_PER_URL = 12000;

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function cleanHistory(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  let chars = 0;

  for (const item of input.slice(-MAX_HISTORY_ITEMS)) {
    const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : null;
    const content = typeof item?.content === "string" ? item.content.trim() : "";
    if (!role || !content) continue;
    if (content.length > MAX_MESSAGE_CHARS) continue;
    chars += content.length;
    if (chars > MAX_HISTORY_CHARS) break;
    out.push({ role, content });
  }

  return out;
}

function extractPublicUrls(text) {
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return [...new Set(matches)].slice(0, MAX_WEB_URLS);
}

async function fetchWebContext(urls, origin, signal) {
  if (!urls.length) return [];
  const results = [];

  for (const target of urls) {
    try {
      const endpoint = new URL("/api/web", origin);
      endpoint.searchParams.set("url", target);
      const response = await fetch(endpoint, { signal });
      const data = await response.json();
      if (!response.ok || !data?.body) continue;
      results.push({
        url: data.url || target,
        contentType: data.contentType || "",
        body: String(data.body).slice(0, MAX_WEB_CHARS_PER_URL)
      });
    } catch {
      // Optional context must not block chat.
    }
  }

  return results;
}

function normalizeBaseUrl(raw) {
  const value = (raw || "http://127.0.0.1:11434/v1").trim().replace(/\/+$/, "");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI_BASE_URL must use http:// or https://.");
  }
  return url.toString().replace(/\/$/, "");
}

async function callModel({ message, history, webContext, ownerMode, agentKey, signal }) {
  const baseUrl = normalizeBaseUrl(process.env.AI_BASE_URL);
  const model = (process.env.AI_MODEL || "local-model").trim();
  const maxTokens = clampNumber(process.env.AI_MAX_TOKENS, 256, 8192, DEFAULT_MAX_TOKENS);
  const temperature = Math.min(Math.max(Number(process.env.AI_TEMPERATURE ?? 0.3), 0), 1.5);
  const selected = getAgentPrompt(agentKey);

  const webBlock = webContext.length
    ? "\n\nUNTRUSTED WEB CONTEXT:\n" + webContext.map((item, index) =>
        `--- Source ${index + 1}: ${item.url}\n${item.body}`
      ).join("\n\n")
    : "";

  const ownerBlock = ownerMode
    ? "\n\nOWNER MODE ACTIVE: be concise, command-oriented, proactive, and preserve established preferences."
    : "";

  const systemPrompt = `${BASE_SYSTEM_PROMPT}\n\n${selected.prompt}${ownerBlock}${webBlock}`;
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message }
  ];

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.AI_API_KEY ? { Authorization: `Bearer ${process.env.AI_API_KEY}` } : {})
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
    signal
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The configured model endpoint returned an invalid response.");
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error || `Model request failed (${response.status}).`);
  }

  const reply = data?.choices?.[0]?.message?.content?.trim?.() || "";
  if (!reply) throw new Error("The configured model returned an empty response.");

  return {
    reply,
    provider: "configured-model",
    model,
    agent: agentKey,
    agentName: selected.name,
    ownerMode: Boolean(ownerMode),
    webSources: webContext.map((x) => x.url)
  };
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ error: "Only POST requests are allowed." }, 405);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  try {
    const body = await request.json();
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const history = cleanHistory(body?.history);
    const ownerMode = body?.ownerMode === true;
    const agent = ["coder", "system", "qa", "researcher"].includes(body?.agent) ? body.agent : "researcher";

    if (!message) return json({ error: "Message is required." }, 400);
    if (message.length > MAX_MESSAGE_CHARS) return json({ error: "Message is too long." }, 413);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const urls = extractPublicUrls(message);
      const webContext = await fetchWebContext(urls, request.url, controller.signal);
      return json(await callModel({ message, history, webContext, ownerMode, agentKey: agent, signal: controller.signal }));
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return json({
      error: timedOut ? "The model took too long to respond." : (error?.message || "Server error.")
    }, timedOut ? 504 : 502);
  }
}
