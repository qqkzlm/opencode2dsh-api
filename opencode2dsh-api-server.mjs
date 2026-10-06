#!/usr/bin/env node
// Local OpenAI-compatible HTTP API in front of the installed @opencode2dsh/dsh-plugin.
// Only listens on loopback. External clients can use:
//   baseURL: http://127.0.0.1:8791/v1
//   apiKey: public
import http from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOG_DIR = process.env.OPENCODE2DSH_LOG_DIR || join(homedir(), '.opencode2dsh', 'api-logs');
const LOG_REQUESTS = (process.env.OPENCODE2DSH_LOG_REQUESTS || '1') !== '0';
const LOG_MAX_BODY = Number(process.env.OPENCODE2DSH_LOG_MAX_BODY || '20000');
await mkdir(LOG_DIR, { recursive: true });

function requestId() {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;
}

function truncate(value, max = LOG_MAX_BODY) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

async function writeRequestLog(entry) {
  if (!LOG_REQUESTS) return;
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  try {
    await appendFile(join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`), line, 'utf8');
  } catch (error) {
    console.error(`[opencode2dsh-api] failed to write request log: ${error?.message || error}`);
  }
}

function summarizeChunks(events) {
  const counts = {};
  let textChars = 0;
  let toolDeltas = 0;
  for (const chunk of events) {
    counts[chunk.type] = (counts[chunk.type] || 0) + 1;
    if (chunk.type === 'text-delta') textChars += chunk.text?.length || 0;
    if (chunk.type === 'tool-call-delta') toolDeltas += 1;
  }
  return { counts, textChars, toolDeltas };
}

const HOST = process.env.OPENCODE2DSH_API_HOST || '127.0.0.1';
const PORT = Number(process.env.OPENCODE2DSH_API_PORT || '8791');
const API_KEY = process.env.OPENCODE2DSH_API_KEY || 'public';
const REFRESH_SECONDS = Number(process.env.OPENCODE2DSH_REFRESH_SECONDS || '300');
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE2DSH_REQUEST_TIMEOUT_MS || '120000');

const pluginCandidates = [
  process.env.OPENCODE2DSH_PLUGIN_PATH,
  join(process.cwd(), 'node_modules', '@opencode2dsh', 'dsh-plugin', 'lib', 'index.js'),
  join(
    homedir(),
    '.dsh',
    'profiles',
    'desktop',
    'node_modules',
    '@opencode2dsh',
    'dsh-plugin',
    'lib',
    'index.js',
  ),
].filter(Boolean);
let plugin = null;
let pluginLoadError = null;
for (const candidate of pluginCandidates) {
  try {
    plugin = await import(pathToFileURL(candidate).href);
    console.log(`[opencode2dsh-api] loaded plugin from ${candidate}`);
    break;
  } catch (error) {
    pluginLoadError = error;
  }
}
if (!plugin) throw new Error(`opencode2dsh plugin not found (tried ${pluginCandidates.join(', ')}): ${pluginLoadError?.message || pluginLoadError}`);

let adapter = null;
const quietLogger = { info: () => {}, warn: (...args) => console.warn(...args), error: (...args) => console.error(...args) };
const pluginContext = {
  logger: quietLogger,
  llm: {
    registerAdapter: (providers, nextAdapter) => {
      adapter = nextAdapter;
      console.log(`[opencode2dsh-api] registered provider route: ${providers.join(',')}`);
    },
  },
  effect: () => {},
};
plugin.apply(pluginContext, { mode: 'adapter', providerId: 'opencode2dsh', refreshSeconds: REFRESH_SECONDS });

// Give the background catalog a moment to warm up, without blocking startup.
await new Promise((resolve) => setTimeout(resolve, 2500));
if (!adapter) throw new Error('opencode2dsh adapter failed to register');

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function unauthorized(res) {
  json(res, 401, { error: { message: 'Invalid API key. Use the configured local API key.', type: 'invalid_api_key' } });
}

function checkAuth(req, res) {
  const header = req.headers.authorization || '';
  if (header !== `Bearer ${API_KEY}`) {
    unauthorized(res);
    return false;
  }
  return true;
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

function openAIText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'image_url') return '[image omitted: image_url parts are not supported by this bridge]';
      return '';
    }).join('');
  }
  return '';
}

// OpenAI history -> harness blocks. Must preserve assistant tool_calls and
// tool results, otherwise multi-turn tool use breaks: the model would never
// see what the external tool returned.
function toHarnessMessages(openaiMessages) {
  const out = [];
  for (const message of openaiMessages || []) {
    const role = message?.role;
    if (role === 'assistant') {
      const blocks = [];
      const text = openAIText(message.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls || []) {
        blocks.push({
          type: 'tool-call',
          id: String(call?.id || `call-${Date.now()}-${blocks.length}`),
          name: String(call?.function?.name || 'unknown'),
          arguments: typeof call?.function?.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call?.function?.arguments ?? {}),
        });
      }
      if (message.function_call) {
        blocks.push({
          type: 'tool-call',
          id: `call-${Date.now()}-${blocks.length}`,
          name: String(message.function_call.name || 'unknown'),
          arguments: typeof message.function_call.arguments === 'string'
            ? message.function_call.arguments
            : JSON.stringify(message.function_call.arguments ?? {}),
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: String(message.tool_call_id ?? message.toolCallId ?? ''),
          content: [{ type: 'text', text: openAIText(message.content) || '(no output)' }],
        }],
      });
      continue;
    }
    if (role === 'function') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: String(message.name ?? ''),
          content: [{ type: 'text', text: openAIText(message.content) || '(no output)' }],
        }],
      });
      continue;
    }
    out.push({
      role: role === 'system' ? 'system' : 'user',
      content: [{ type: 'text', text: openAIText(message.content) }],
    });
  }
  return out;
}

function toHarnessTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || tool.function.name,
      parameters: tool.function.parameters || { type: 'object', properties: {} },
    }));
  // OpenCode free tier drops requests whose body lacks an agent-tool shape,
  // so external one-shot tool schemas are appended rather than replacing it.
  const names = new Set(mapped.map((tool) => tool.name));
  for (const name of ['bash', 'read']) {
    if (!names.has(name)) {
      mapped.push({ name, description: 'Reserved for the host runtime; do not call it.', parameters: { type: 'object', properties: {} } });
    }
  }
  return mapped;
}

function completionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

async function handleModels(res, id) {
  const models = adapter.listModels('opencode2dsh');
  if (id) {
    const found = models.find((model) => model.id === id);
    if (!found) return json(res, 404, { error: { message: `Model ${id} not found`, type: 'not_found' } });
    return json(res, 200, { object: 'model', id: found.id, created: Math.floor(Date.now() / 1000), owned_by: 'opencode2dsh' });
  }
  return json(res, 200, {
    object: 'list',
    data: models.map((model) => ({
      object: 'model',
      id: model.id,
      created: Math.floor(Date.now() / 1000),
      owned_by: 'opencode2dsh',
    })),
  });
}

async function collectStream(options, onEvent) {
  let text = '';
  let reasoning = '';
  const toolCalls = new Map();
  let usage;
  let finishReason = 'stop';

  for await (const chunk of adapter.stream(options)) {
    onEvent?.(chunk);
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
    else if (chunk.type === 'tool-call-delta') {
      const upstreamIndex = Number.isInteger(chunk.index) ? chunk.index : 0;
      const current = toolCalls.get(upstreamIndex) || { id: chunk.id, name: chunk.name, arguments: '' };
      current.id = chunk.id || current.id;
      current.name = chunk.name || current.name;
      current.arguments += chunk.argumentsDelta || '';
      toolCalls.set(upstreamIndex, current);
    } else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish') finishReason = chunk.reason.kind === 'tool-calls' ? 'tool_calls' : 'stop';
  }

  const orderedToolCalls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
  // Mixed text + tool_calls is legal OpenAI: if any tool call exists the
  // terminal reason must be tool_calls, otherwise external clients stop.
  if (orderedToolCalls.length > 0) finishReason = 'tool_calls';

  return { text, reasoning, toolCalls: orderedToolCalls, usage, finishReason };
}

function describeChunkForLog(chunk) {
  if (chunk.type === 'text-delta') return { type: chunk.type, index: chunk.index, chars: chunk.text?.length || 0 };
  if (chunk.type === 'reasoning-delta') return { type: chunk.type, index: chunk.index, chars: chunk.text?.length || 0 };
  if (chunk.type === 'tool-call-delta') {
    return {
      type: chunk.type, index: chunk.index, id: chunk.id, name: chunk.name,
      argumentsDeltaChars: chunk.argumentsDelta?.length || 0,
      argumentsDelta: truncate(chunk.argumentsDelta || '', 2000),
    };
  }
  if (chunk.type === 'finish') return { type: chunk.type, reason: chunk.reason };
  if (chunk.type === 'usage') return { type: chunk.type, usage: chunk.usage };
  return { type: chunk.type, index: chunk.index };
}

function toCompletionObject(model, collected) {
  const message = { role: 'assistant', content: collected.text };
  if (collected.toolCalls.length > 0) {
    message.tool_calls = collected.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    }));
  }
  return {
    id: completionId('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: collected.finishReason }],
    usage: {
      prompt_tokens: collected.usage?.inputTokens ?? 0,
      completion_tokens: collected.usage?.outputTokens ?? 0,
      total_tokens: (collected.usage?.inputTokens ?? 0) + (collected.usage?.outputTokens ?? 0),
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      });
      res.end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      return json(res, 200, { status: 'ok', provider: 'opencode2dsh', baseURL: `http://${HOST}:${PORT}/v1` });
    }
    if ((url.pathname === '/v1/models' || url.pathname === '/models') && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      return handleModels(res);
    }
    const modelMatch = url.pathname.match(/^\/(v1\/models|models)\/(.+)$/);
    if (modelMatch && req.method === 'GET') {
      if (!checkAuth(req, res)) return;
      return handleModels(res, decodeURIComponent(modelMatch[2]));
    }
    if ((url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') && req.method === 'POST') {
      if (!checkAuth(req, res)) return;
      const body = await readJson(req);
      const id = requestId();
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const events = [];
      let clientClosed = false;
      req.on('close', () => { clientClosed = true; controller.abort(); });
      const recordEvent = (chunk) => { events.push(describeChunkForLog(chunk)); };
      try {
        const options = {
          provider: 'opencode2dsh',
          model: body.model,
          messages: toHarnessMessages(body.messages),
          tools: toHarnessTools(body.tools),
          tool_choice: body.tool_choice,
          temperature: body.temperature,
          maxTokens: body.max_tokens ?? body.maxTokens,
          signal: controller.signal,
        };
        if (body.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'access-control-allow-origin': '*',
          });
          const id = completionId('chatcmpl');
          const created = Math.floor(Date.now() / 1000);
          const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const roleChunk = () => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
          let started = false;
          let usage;
          let finishReason = 'stop';
          let toolCallCount = 0;
          const toolIndexByUpstream = new Map();
          for await (const chunk of adapter.stream(options)) {
            recordEvent(chunk);
            if (chunk.type === 'text-delta') {
              if (!started) { send(roleChunk()); started = true; }
              send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] });
            } else if (chunk.type === 'tool-call-delta') {
              if (!started) { send(roleChunk()); started = true; }
              const upstreamIndex = Number.isInteger(chunk.index) ? chunk.index : 0;
              if (!toolIndexByUpstream.has(upstreamIndex)) toolIndexByUpstream.set(upstreamIndex, toolCallCount++);
              const normalizedIndex = toolIndexByUpstream.get(upstreamIndex);
              send({
                id, object: 'chat.completion.chunk', created, model: body.model,
                choices: [{ index: 0, delta: { tool_calls: [{ index: normalizedIndex, id: chunk.id, type: 'function', function: { name: chunk.name, arguments: chunk.argumentsDelta || '' } }] }, finish_reason: null }],
              });
            } else if (chunk.type === 'usage') usage = chunk.usage;
            else if (chunk.type === 'finish') finishReason = chunk.reason.kind === 'tool-calls' ? 'tool_calls' : 'stop';
          }
          if (toolCallCount > 0) finishReason = 'tool_calls';
          send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: usage ? { prompt_tokens: usage.inputTokens ?? 0, completion_tokens: usage.outputTokens ?? 0, total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } : undefined });
          res.write('data: [DONE]\n\n');
          res.end();
          await writeRequestLog({
            requestId: id, path: url.pathname, stream: true, model: body.model,
            durationMs: Date.now() - startedAt, clientClosed, finishReason,
            chunkSummary: summarizeChunks(events), firstChunks: events.slice(0, 20), lastChunks: events.slice(-20),
            request: { messages: truncate(body.messages), tools: truncate(body.tools), tool_choice: body.tool_choice },
          });
          return;
        }
        const collected = await collectStream(options, recordEvent);
        const response = toCompletionObject(body.model, collected);
        await writeRequestLog({
          requestId: id, path: url.pathname, stream: false, model: body.model,
          durationMs: Date.now() - startedAt, clientClosed, finishReason: collected.finishReason,
          textChars: collected.text.length, toolCalls: collected.toolCalls,
          chunkSummary: summarizeChunks(events), firstChunks: events.slice(0, 20), lastChunks: events.slice(-20),
          request: { messages: truncate(body.messages), tools: truncate(body.tools), tool_choice: body.tool_choice },
        });
        return json(res, 200, response);
      } catch (error) {
        await writeRequestLog({
          requestId: id, path: url.pathname, stream: Boolean(body.stream), model: body.model,
          durationMs: Date.now() - startedAt, clientClosed, error: error?.message || String(error),
          chunkSummary: summarizeChunks(events), firstChunks: events.slice(0, 20), lastChunks: events.slice(-20),
          request: { messages: truncate(body.messages), tools: truncate(body.tools), tool_choice: body.tool_choice },
        });
        if (controller.signal.aborted && !res.headersSent) {
          return json(res, clientClosed ? 499 : 408, { error: { message: clientClosed ? 'Client disconnected before completion' : 'Request timed out', type: clientClosed ? 'client_closed' : 'timeout' } });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    return json(res, 404, { error: { message: 'Not found', type: 'not_found' } });
  } catch (error) {
    console.error(`[opencode2dsh-api] request failed: ${error?.stack || error}`);
    if (!res.headersSent) json(res, 500, { error: { message: error?.message || 'Internal server error', type: 'server_error' } });
    else res.end();
  }
});

server.on('clientError', (error, socket) => {
  console.error(`[opencode2dsh-api] client error: ${error?.message || error}`);
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log(`[opencode2dsh-api] listening on http://${HOST}:${PORT}/v1`);
  console.log(`[opencode2dsh-api] local API key: ${API_KEY}`);
});
