import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DIG_LOCAL_PORT || 8787);
const OLLAMA = process.env.DIG_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.DIG_LOCAL_MODEL || 'qwen2.5:7b';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const agents = {
  coder: {
    name: 'Coder',
    instructions: 'You are DIG Coder. Help with software design, debugging, testing, and defensive lab automation. Be concise and practical. Do not claim to have executed anything you did not execute.'
  },
  system: {
    name: 'System',
    instructions: 'You are DIG System. Focus on architecture, reliability, local system operations, observability, recovery, and defensive security. Prefer safe local changes and explain tradeoffs.'
  },
  qa: {
    name: 'QA',
    instructions: 'You are DIG QA. Challenge assumptions, find regressions, design tests, and verify claims. Ask for evidence when a result is not proven.'
  }
};

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store'
  });
  res.end(data);
}

async function readBody(req, max = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function askOllama(agentKey, message, history = []) {
  const agent = agents[agentKey];
  if (!agent) throw new Error('unknown_agent');

  const messages = [
    { role: 'system', content: agent.instructions },
    ...history.slice(-24).filter(x => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string'),
    { role: 'user', content: message }
  ];

  const response = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, messages }),
    signal: AbortSignal.timeout(120_000)
  });

  if (!response.ok) throw new Error(`ollama_${response.status}`);
  const data = await response.json();
  return String(data?.message?.content || '').trim();
}

async function teamReply(message, history) {
  const replies = [];
  for (const key of ['coder', 'system', 'qa']) {
    replies.push({ agent: key, name: agents[key].name, reply: await askOllama(key, message, history) });
  }
  return replies;
}

async function serveFile(res, file, type) {
  try {
    const data = await fs.readFile(path.join(__dirname, file));
    res.writeHead(200, {
      'content-type': `${type}; charset=utf-8`,
      'content-length': data.length,
      'cache-control': 'no-store'
    });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not_found' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return serveFile(res, 'index.html', 'text/html');
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        localOnly: true,
        host: HOST,
        model: MODEL,
        agents: Object.entries(agents).map(([id, value]) => ({ id, name: value.name }))
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      const agent = String(body.agent || 'coder');
      const history = Array.isArray(body.history) ? body.history : [];
      if (!message) return json(res, 400, { error: 'message_required' });
      if (message.length > 12_000) return json(res, 400, { error: 'message_too_long' });

      if (agent === 'team') {
        return json(res, 200, { agent: 'team', replies: await teamReply(message, history), model: MODEL });
      }

      const reply = await askOllama(agent, message, history);
      return json(res, 200, { agent, name: agents[agent].name, reply, model: MODEL });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    const code = error?.message === 'request_too_large' ? 413 : 500;
    return json(res, code, {
      error: 'local_chat_error',
      detail: error?.message === 'unknown_agent' ? 'unknown_agent' : 'Local model unavailable or request failed'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DIG Local Agent Chat: http://${HOST}:${PORT}`);
  console.log(`Local model: ${MODEL} via ${OLLAMA}`);
  console.log('Qubes/qrexec: disabled for this mode');
});
