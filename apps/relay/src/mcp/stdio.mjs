/**
 * stdio transport for MCP clients that launch a subprocess instead of speaking HTTP.
 *
 * Two modes, because two real client shapes exist:
 *   - in-process: read the local SQLite store directly. No network, no credential, no port.
 *   - remote bridge: forward each JSON-RPC line to a deployed `/mcp` over HTTPS, attaching whatever
 *     static headers the deployment needs. This is the only route for desktop clients that cannot
 *     set custom headers themselves: the client can always launch a process, and the process can.
 *
 * stdout carries exactly one JSON-RPC message per line and nothing else. Logs go to stderr, because
 * a stray stdout write corrupts the framing and the client reports a parse error instead.
 */
import { createInterface } from 'node:readline';
import { SqliteStore } from '../store.mjs';
import { handleMcpMessage } from './protocol.mjs';

const MODERN_PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';

function stderr(line) {
  process.stderr.write(`${line}\n`);
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** The Streamable HTTP layer mirrors these from the body; a stdio bridge must reproduce it. */
function mirroredHeaders(message) {
  const headers = new Headers();
  const meta = message?.params?._meta;
  const version = meta?.[MODERN_PROTOCOL_VERSION_KEY];
  if (typeof version === 'string') {
    headers.set('MCP-Protocol-Version', version);
    headers.set('Mcp-Method', String(message.method));
    if (message.method === 'tools/call' && typeof message.params?.name === 'string') {
      headers.set('Mcp-Name', message.params.name);
    }
  }
  return headers;
}

async function forwardRemote(url, baseHeaders, message) {
  const headers = new Headers(baseHeaders);
  headers.set('content-type', 'application/json');
  // The transport contract requires the client to accept both response shapes.
  headers.set('accept', 'application/json, text/event-stream');
  for (const [name, value] of mirroredHeaders(message)) headers.set(name, value);
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) });
  if (response.status === 202) return null;
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // Never surface HTML as a protocol message: name the protocol-level failure instead.
    return {
      jsonrpc: '2.0',
      id: message?.id ?? null,
      error: { code: -32603, message: `Remote MCP endpoint returned non-JSON (HTTP ${response.status})` },
    };
  }
}

/**
 * @param {object} options
 * @param {string} options.dbPath        local SQLite file, used when `url` is absent
 * @param {string|null} options.url      remote `/mcp` endpoint
 * @param {string[]} options.headers     "Name: value" pairs for the remote endpoint
 */
export async function runStdio({ dbPath = 'relay.db', url = null, headers = [] } = {}) {
  const headerMap = new Headers();
  for (const pair of headers) {
    const index = pair.indexOf(':');
    if (index <= 0) throw new Error(`--header expects "Name: value", got "${pair}"`);
    headerMap.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }

  const store = url ? null : new SqliteStore(dbPath);
  const headerCount = [...headerMap.keys()].length;
  stderr(`[mcp] stdio bridge ready (${url ? `remote ${url}` : `local ${dbPath}`}, headers=${headerCount})`);

  const close = () => {
    try { store?.close(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: line is not JSON' } });
      continue;
    }
    const isNotification = message && typeof message === 'object' && !Array.isArray(message) &&
      (message.id === undefined || message.id === null);
    try {
      if (url) {
        const response = await forwardRemote(url, headerMap, message);
        if (!isNotification && response) writeMessage(response);
      } else {
        const result = await handleMcpMessage(message, {
          store,
          now: Date.now(),
          identity: 'stdio',
          runtime: { target: 'node', uptime_scope: 'process', polling: 'manual' },
          log: stderr,
        });
        if (result.body) writeMessage(result.body);
      }
    } catch (error) {
      if (!isNotification) {
        writeMessage({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: error.message } });
      }
    }
  }
  store?.close();
}
