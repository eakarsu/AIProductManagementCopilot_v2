import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const indexPath = path.join(projectRoot, 'public', 'index.html');

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65_536) throw new Error('request body is too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function credentials() {
  return {
    email: String(process.env.PROVISION_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: String(process.env.PROVISION_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || ''),
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function signToken(email) {
  const body = Buffer.from(JSON.stringify({ email, role: 'admin', exp: Date.now() + 86_400_000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

async function callOpenRouter(prompt) {
  const baseUrl = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'You are a product management copilot. Give concise, evidence-based recommendations.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned an empty response');
  return content;
}

export function validateDraft(body) {
  return typeof body.title !== 'string' || !body.title.trim() || typeof body.evidence !== 'string' || !body.evidence.trim() ? 'title and evidence are required strings' : null;
}

export function createDraft(body) {
  return { id: randomUUID(), status: 'draft', title: body.title.trim(), evidence: body.evidence.trim(), createdAt: new Date().toISOString() };
}

export function createApp() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, { status: 'ok', service: 'product-management-copilot-v2', scope: 'minimal-local-boundary' });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/demo-credentials') {
        if (process.env.NODE_ENV === 'production') return json(res, 404, { error: 'not found' });
        const expected = credentials();
        return expected.email && expected.password
          ? json(res, 200, expected)
          : json(res, 503, { error: 'Demo credentials are not configured' });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(req);
        const expected = credentials();
        if (!expected.email || !expected.password || !safeEqual(String(body.email || '').toLowerCase(), expected.email) || !safeEqual(body.password || '', expected.password)) {
          return json(res, 401, { error: 'Invalid credentials' });
        }
        return json(res, 200, { token: signToken(expected.email), user: { id: 1, email: expected.email, role: 'admin' } });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        const user = verifyToken(req);
        return user ? json(res, 200, { id: 1, email: user.email, role: user.role }) : json(res, 401, { error: 'Not authenticated' });
      }
      if (req.method === 'POST' && url.pathname === '/api/ai/product-brief') {
        const user = verifyToken(req);
        if (!user) return json(res, 401, { error: 'Not authenticated' });
        const body = await readJson(req);
        const content = await callOpenRouter(String(body.prompt || body.question || 'Suggest one measurable product discovery experiment.'));
        return json(res, 200, { content, model: process.env.OPENROUTER_MODEL });
      }
      if (req.method === 'POST' && url.pathname === '/api/opportunities') {
        const body = await readJson(req);
        const validationError = validateDraft(body);
        if (validationError) return json(res, 400, { error: validationError });
        const record = createDraft(body);
        return json(res, 201, { data: record, warning: 'Local draft only; external execution is not connected.' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 500;
      return json(res, status, { error: status === 400 ? 'invalid JSON body' : error.message });
    }
  });
}

const isMainModule = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMainModule) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  const backendPort = Number(process.env.BACKEND_PORT || process.env.PORT || 3000);
  const frontendPort = Number(process.env.FRONTEND_PORT || backendPort + 1);
  createApp().listen(backendPort, '127.0.0.1', () => console.log(`Product copilot API listening on http://127.0.0.1:${backendPort}`));
  createApp().listen(frontendPort, '127.0.0.1', () => console.log(`Product copilot UI listening on http://127.0.0.1:${frontendPort}`));
}
