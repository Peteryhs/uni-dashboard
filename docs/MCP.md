# MCP server

An AI agent can query this dashboard directly over the Model Context Protocol: the same collected,
ranked and freshness-scored data the web and Android clients read, exposed as ten read-only tools.

The design has three constraints, and most of this document is the consequence of them:

1. **It must be a standard MCP server.** It speaks both live protocol eras, because the current
   specification (`2026-07-28`) is stateless and dropped `initialize`, while nearly every deployed
   client still opens with the `2025-11-25` handshake.
2. **It must be read-only.** No tool polls a source, starts an AI job, writes a row, dismisses an
   alert or completes a task. An agent that can only read cannot corrupt the dashboard while you
   are not looking.
3. **It is hosted behind Cloudflare Access.** Access is built for humans with browsers; an agent is
   a machine that must stay connected for months. That mismatch is the real design problem, and it
   is analysed in [Long-term connectivity](#long-term-connectivity-behind-cloudflare-access).

## Endpoint at a glance

| | |
|---|---|
| Path | `/mcp` (Worker route; also served by the local relay) |
| Transport | Streamable HTTP, **stateless**: one POST per JSON-RPC message, one `application/json` response, no session, no GET stream |
| Protocol | dual-era: modern `2026-07-28` (`_meta` per request) and legacy `2024-11-05` … `2025-11-25` (`initialize`) |
| Discovery | `GET /.well-known/oauth-protected-resource` (and `/.well-known/oauth-protected-resource/mcp`) |
| Tools | 10, all annotated read-only |
| Auth | Cloudflare Access assertion and/or application API keys (`MCP_AUTH_MODE`); hashed, scoped, revocable |
| Data cost | D1 reads only, bounded per tool; no writes, no polling, no model calls |
| Body cap | 256 KB per JSON-RPC message |

The endpoint is deliberately **not** served through the SPA asset fallback: `/mcp` and
`/.well-known/*` are in `run_worker_first` in [wrangler.toml](../wrangler.toml), so an MCP request
can never receive `index.html` with a 200.

## Quick start

### Local, stdio (no HTTP, no credentials)

The bridge reads the local SQLite store directly. Use it for desktop clients that launch a
subprocess:

```json
{
  "mcpServers": {
    "uni-dashboard": {
      "command": "node",
      "args": ["C:\\path\\to\\uni-dashboard\\apps\\relay\\src\\cli.mjs", "mcp"],
      "env": { "RELAY_DB": "C:\\path\\to\\uni-dashboard\\relay.db" }
    }
  }
}
```

`node apps/relay/src/cli.mjs mcp` runs the same bridge in a terminal for a smoke test. Call Node
directly rather than through `npm run mcp`: npm writes its own banner to stdout, and a stdio MCP
server's stdout must contain nothing but JSON-RPC lines.

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"shell","version":"0"}}}' | node apps/relay/src/cli.mjs mcp
```

### Local, HTTP

`npm run serve` listens on `http://127.0.0.1:8787`; the MCP endpoint is `/mcp`. With `RELAY_TOKEN`
set, send it as a bearer token:

```sh
curl -sS http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $RELAY_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

### Deployed

Use the MCP hostname and a Cloudflare Access **service token** (see
[Authentication](#authentication)):

```sh
curl -sS https://mcp.example.com/mcp \
  -H 'content-type: application/json' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A request authenticated with an application API key instead of Access (see
[Option B](#option-b-application-api-keys-own-auth-no-access-in-the-agent-path)):

```sh
curl -sS https://mcp.example.com/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $UNI_DASHBOARD_MCP_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A modern-era request on the same endpoint (note the required mirrored headers):

```sh
curl -sS https://mcp.example.com/mcp \
  -H 'content-type: application/json' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

## Protocol: two eras on one endpoint

The specification moved to `2026-07-28`, a breaking revision that removes `initialize`,
`notifications/initialized`, `ping`, `Mcp-Session-Id`, the HTTP GET stream and SSE resumability. It
replaces them with per-request metadata in `params._meta` and three mirrored HTTP headers. Its own
compatibility matrix says a **legacy client cannot fall forward to a modern-only server**, and the
maintainers of the common bridge report that essentially every server deployed today is legacy. A
dual-era server is explicitly permitted and is what this implements.

| | Legacy era | Modern era |
|---|---|---|
| Versions | `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` | `2026-07-28` |
| Selected by | an `initialize` request | `params._meta["io.modelcontextprotocol/protocolVersion"]` |
| Opening handshake | `initialize` → `notifications/initialized` | none |
| Per-request metadata | none (connection-scoped capabilities) | `_meta` version + client capabilities on every request |
| Results | plain JSON-RPC results | `resultType: "complete"`, caching hints on `server/discover` and `tools/list` |
| Session | none minted (stateless) | none exists |
| `GET` / `DELETE` | `405` | `405` |
| Unknown method | `200` with `-32601` | `404` with `-32601` |
| Error statuses | `400` only for malformed JSON-RPC | `400` for `-32020`/`-32022`/missing `_meta`; `404` for unknown method |

Wire rules this server enforces:

- `Origin`, when present, must match the endpoint origin; otherwise `403`. Absent `Origin` (the
  normal machine-client case) is allowed. This is DNS-rebinding protection.
- `Accept` must be capable of `application/json`. The server always answers a single JSON object —
  the spec allows either JSON or a request-scoped SSE stream, and JSON is what survives Access.
- `Content-Type: application/json`; JSON-RPC batching is rejected (`400`, `-32600`), because it was
  removed from both live revisions.
- Modern requests must carry `MCP-Protocol-Version`, `Mcp-Method`, and — for `tools/call` —
  `Mcp-Name`; each must equal the body value, or the response is `400`, `-32020`.
- A modern request with an unsupported version gets `400`, `-32022`, with
  `data.supported` and `data.requested`.
- A modern request missing `clientCapabilities` gets `400`, `-32602`.
- Notifications are accepted with `202` and no body. `server/discover` is implemented, as required.
- Server results echo `_meta["io.modelcontextprotocol/serverInfo"]` on every modern result.

Client configuration is era-independent: a client that sends `initialize` gets legacy behaviour; a
client that sends `_meta` gets modern behaviour. No flag, no separate endpoint.

## Tools

All ten tools are read-only (`readOnlyHint: true`, no destructive/idempotent side effects) and
delegate to the same builders the `/v1` routes use, so an agent cannot describe data the app
contradicts.

| Tool | Answers | Args | Source |
|---|---|---|---|
| `get_dashboard` | What needs attention now, already ranked | — | `buildDashboard` (5 cards) |
| `list_recommendations` | Priority-ordered, explainable recommendations | `section`, `group`, `kind`, `limit`, `include_diagnostics` | recommendation engine |
| `get_calendar` | Classes, exams, deadlines, syllabus dates, office hours | `start`, `days` (1–31), `section`, `group`, `include_syllabus` | unified calendar |
| `get_menu` | Posted dishes, outlets, stations, dietary tags, allergens | `date` | saved `menu_item` rows |
| `get_food_recommendation` | Saved personalized dining ranking and its status | `date` | AI result cache (never runs the job) |
| `get_study_spaces` | Live library/floor occupancy and the roomiest floor | — | Waitz rows |
| `get_service_status` | Campus incidents and notices, with severities | `include_all_severities` | status source |
| `get_weather` | Cached hourly forecast and current temperature | `hours` (1–48) | weather cache |
| `get_source_health` | Per-source readiness, freshness, failures, next attempt | — | run receipts + registry |
| `search_stored_items` | Keyword search over saved events, latest menu and notices | `query`, `kinds`, `limit` | stored rows directly |

Data conventions the instructions give the model, and which the tools preserve:

- `observed_at` / `valid_until` are **epoch milliseconds**, not ISO strings.
- `state` is `live`, `ageing`, `stale`, `dead`, `empty`, `degraded` or `failed`; age is measured
  against each source's own cadence, not the wall clock.
- Dates are `YYYY-MM-DD` and default to **America/Toronto**; "today" is the campus day.
- An empty result does not prove nothing is happening — check `get_source_health` first.

Safety properties worth stating plainly:

- **No writes.** Discord-style "just let the agent dismiss alerts" is deliberately not exposed.
- **No polling or AI from a read.** A tool call spends D1 reads only, which keeps it inside a
  Worker's per-invocation budget; the cron remains the only poller.
- **Bounded inputs.** Every argument is validated by a zod schema (the same declaration generates
  the MCP `inputSchema`), and every list has a hard limit.
- **Audit trail.** Each `tools/call` writes one `mcp_audit` row (`token_id`, identity, tool, ok) and
  one log line with the tool name and credential identity, never the arguments:
  `[mcp] tools/call get_menu identity=<email|common_name|token:name#id> ok`.
- **No secrets in output.** Tools expose saved data, never feed URLs, tokens or raw source bodies.

## Authentication

### What `/mcp` accepts

Two credential lanes, selected by `MCP_AUTH_MODE` (default `access`, so existing deployments do not
change behaviour):

| Mode | Accepts | Use when |
|---|---|---|
| `access` (default) | a valid `Cf-Access-Jwt-Assertion` only | `/mcp` sits behind Cloudflare Access |
| `token` | an application API key: `Authorization: Bearer udmcp_…` | `/mcp` is reachable without Access, or you want your own agent credentials |
| `both` | either of the above | Access protects the hostname but agents use keys |

`ACCESS_DISABLED=1` still bypasses authentication for `wrangler dev` and tests only; never set it in
production.

Access lane details:

- The assertion is verified in the Worker against the Access team JWKS — the same code path `/v1`
  uses. It covers browser sessions, Managed OAuth access tokens and service tokens alike.
- An `MCP_ACCESS_AUD` variable pins `/mcp` to the audience tag of a **separate** Access application
  for the agent hostname. Without it the endpoint falls back to `ACCESS_AUD`. With it, an assertion
  minted for the human dashboard cannot open the agent endpoint, even though one Worker serves both.

Every refusal is **JSON-RPC with a `WWW-Authenticate` header**, never HTML and never a redirect from
the application code. That is not cosmetic: the single most damaging long-term failure is an agent
receiving an IdP login page and reporting a JSON parse error for weeks. A credential that is valid
but missing a scope gets `403` with `error="insufficient_scope"`, which is distinct from a bad key.

### Access cannot be the MCP authorization server by itself

The MCP authorization spec wants a resource server to publish **RFC 9728 protected-resource
metadata** and to answer `401` with
`WWW-Authenticate: Bearer resource_metadata="..."`. A spec-following client then discovers the
authorization server (**RFC 8414**), registers (DCR or, as of `2026-07-28`, preferably CIMD), runs
authorization code + PKCE, and sends `Authorization: Bearer` on every request.

Plain Cloudflare Access with `Allow` policies does none of that: an unauthenticated machine client
gets a **302 to the IdP**, which an MCP client cannot complete. There are three workable answers,
and this repository supports all three:

- **Service tokens** (Cloudflare-issued machine identity, static headers) for unattended agents.
- **Application API keys** (this project's own credentials) when you do not want Access in the agent
  path at all — see Option B.
- **Access Managed OAuth** for interactive clients that insist on standard OAuth discovery — the
  standard-compliance path, already enabled for the Android app.

### Option A (primary with Access): service tokens on a dedicated hostname

Topology:

```text
app.example.com      → Worker  → Access app "Dashboard" → Allow (email/IdP SSO)   → /v1, assets
mcp.example.com      → Worker  → Access app "MCP"       → Service Auth (token)    → /mcp
```

Why a dedicated hostname: the human SSO app and the machine app then have independent policies,
independent logs and independent lifetimes. A browser session expiry can never affect `/mcp`, and —
with strict service-token authentication on — an `Allow` policy and a stolen `CF_Authorization`
cookie cannot reach `/mcp` at all.

One-time setup:

1. Point a hostname at the Worker (Workers → Custom Domains, or a `[[routes]]` entry) and add it to
   `run_worker_first` coverage — `/mcp` and `/.well-known/*` already are.
2. Create a **second** Access application for that hostname.
3. Policy action **`Service Auth`**, selector **`Service Token`**. Never `Allow`, never `Bypass`.
4. Turn on **strict service token authentication** (default for organisations created on or after
   2026-10-05; recommended for older ones). Then:
   - failure is `401`/`403`, never a `302` to an HTML login page;
   - no `CF_Authorization` cookie is issued, so every request carries the token headers;
   - `Allow` policies and existing cookies are ignored, which isolates the two apps.
5. Create one service token **per agent/deployment** with an explicit duration (for example
   `8760h`) and turn on **Expiring Access Service Token** notifications.
6. Put that application's AUD tag in `MCP_ACCESS_AUD`; keep `ACCESS_AUD` for the dashboard.
7. Set the token as `CF-Access-Client-Id` and `CF-Access-Client-Secret` in the agent's secret store.
   Create the secret once — Cloudflare shows it a single time.

Agent configuration (Claude Code; Codex uses `http_headers` in `~/.codex/config.toml`):

```sh
claude mcp add --transport http uni-dashboard https://mcp.example.com/mcp \
  --header "CF-Access-Client-Id: <id>.access" \
  --header "CF-Access-Client-Secret: <secret>"
```

```toml
# ~/.codex/config.toml
[mcp_servers.uni-dashboard]
url = "https://mcp.example.com/mcp"
http_headers = { "CF-Access-Client-Id" = "<id>.access", "CF-Access-Client-Secret" = "<secret>" }
```

### Option B: application API keys (own auth, no Access in the agent path)

This is the "own the machine credential" option, without owning an identity provider: no passwords,
no sessions, no OAuth authorization server to maintain. A key is 256 random bits with a `udmcp_`
prefix, stored **only as SHA-256**, scoped (`mcp:read`), optionally expiring, revocable, and
attributed in an audit table. Because the input is generated entropy rather than a human password,
a hash lookup is a complete verification and there is no dictionary to attack if the database leaks.

Enable it with a Worker variable:

```toml
[vars]
MCP_AUTH_MODE = "token"   # "both" if Access also fronts the hostname
```

**Read this before choosing `token`.** It means the Worker no longer requires Cloudflare Access for
`/mcp`. If the hostname is still Access-protected, Access rejects the request before the Worker ever
sees the key — so use `both` and keep the edge credential, or serve `/mcp` on a hostname that Access
does not cover. Anyone who holds a valid key has full read access to the dashboard data. Keys are
not discoverable (no RFC 9728 flow), which is fine for a client configured with a static header and
useless to a client that demands OAuth discovery.

Mint a key — the normal way, in **Settings → MCP** on the deployed dashboard (or on a local relay):

1. Choose a name (the device or agent that will use it) and an expiry, then **Create key**.
2. Copy the key from the one-time reveal. It cannot be shown again.
3. Paste it into the agent's MCP configuration below.

The same tab lists every key with its scope, expiry and last use, and revokes it in place. It also
shows the deployment's auth mode: in Access-only mode it warns that `/mcp` will ignore keys until
`MCP_AUTH_MODE` is `token` or `both`, so nobody mints a credential that silently does nothing.

For scripts and automation, the equivalent owner-only route returns the plaintext exactly once:

```sh
curl -sS https://app.example.com/v1/mcp-tokens \
  -H "CF-Access-Client-Id: $ADMIN_ID" \
  -H "CF-Access-Client-Secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"name":"laptop","expires_in_days":90}'
```

`GET /v1/mcp-tokens` returns `{ tokens, auth: { mode } }` — metadata only, never the plaintext and
never the hash. `DELETE /v1/mcp-tokens/<id>` revokes; a second delete reports `404`.

A headless relay or VM without the dashboard can use the CLI instead, which writes the local SQLite
database directly:

```sh
npm run mcp:token -- create --name laptop --days 90
# {"token":"udmcp_...","id":"...","name":"laptop","scopes":["mcp:read"],"expires_at":...}
```

An agent presents the key as a normal bearer credential, so every client that can set headers works:

```sh
claude mcp add --transport http uni-dashboard https://mcp.example.com/mcp \
  --header "Authorization: Bearer $UNI_DASHBOARD_MCP_KEY"
```

```toml
# ~/.codex/config.toml
[mcp_servers.uni-dashboard]
url = "https://mcp.example.com/mcp"
http_headers = { "Authorization" = "Bearer <key>" }
```

For a client with no header field (Claude Desktop), the stdio bridge attaches it instead:

```json
{
  "mcpServers": {
    "uni-dashboard": {
      "command": "node",
      "args": ["C:\\path\\to\\uni-dashboard\\apps\\relay\\src\\cli.mjs", "mcp",
               "--url", "https://mcp.example.com/mcp",
               "--header", "Authorization: Bearer <key>"]
    }
  }
}
```

Operating rules:

- **Rotate quarterly**: mint a second key with the same name, deploy it to the agent, verify, then
  revoke the old one. There is no overlap requirement because both keys are valid at once.
- **On a leak**: revoke that key with one `DELETE`, then inspect `mcp_audit` for its `token_id` and
  the `last_used_at` window. A key is a bearer credential for read-only data — no writes to undo —
  but the timetable and deadlines are private, so treat it as a privacy incident.
- **Prefer expiry** for anything automated (`--days 90`). No-expiry keys belong in a secret manager.
- **Scopes**: only `mcp:read` exists today. Minting rejects unknown scopes rather than silently
  creating a broader credential; a future write tool gets its own scope.
- **Audit**: each `tools/call` writes one `mcp_audit` row with `token_id`, `identity`
  (`token:<name>#<id>`), method, tool and ok/error. Rows are pruned to a rolling 30 days,
  probabilistically, so the table stays bounded without charging a delete to every call.
- **Rate limiting** is not implemented in the Worker. In `token` mode there is no Access policy in
  front either, so add a Cloudflare rate-limiting rule on the MCP hostname. The tools are read-only
  and bounded, which limits the damage, not the request volume.

### Option C (standard OAuth): Access Managed OAuth

Access Managed OAuth is a real OAuth 2.0 authorization server for the application: RFC 8414
metadata, authorization code + PKCE (S256), refresh tokens, dynamic client registration, and a
`401` (not a `302`) for unauthenticated machine clients. This repository already uses it for Android
sign-in; see [ANDROID-OAUTH.md](ANDROID-OAUTH.md).

How a standard MCP client gets in, when Managed OAuth is enabled on the `/mcp` application:

1. `POST /mcp` without a credential → Access answers `401` with a `resource_metadata` pointer.
2. The client reads the protected-resource metadata (Access publishes one; this Worker also serves
   `/.well-known/oauth-protected-resource` naming the Access team domain, for deployments that
   exempt the well-known paths from Access).
3. RFC 8414 metadata on the Access team domain names the authorization, token and registration
   endpoints.
4. The client registers dynamically, opens the authorization URL in a browser, the owner signs in
   with the IdP, and the client exchanges the code with PKCE.
5. Requests carry `Authorization: Bearer oauth:...`. Access resolves the opaque token, re-checks
   policy, and forwards a signed `Cf-Access-Jwt-Assertion` to the Worker. **The Worker's JWT check
   does not change.**

Configured values in this deployment (from the Android setup): **15-minute access token** and a
**336-hour (two-week) grant session**. The grant session is the refresh-token lifetime: the client
refreshes silently, and when it lapses a human has to complete a browser sign-in again. That is
acceptable for interactive clients and unacceptable for a truly unattended agent, which is why
service tokens remain the primary path.

Two compatibility notes:

- `2026-07-28` deprecates dynamic client registration in favour of Client ID Metadata Documents.
  Access supports DCR, not CIMD. Clients that prefer CIMD fall back to DCR when the metadata
  advertises a `registration_endpoint`, which Access does — but a client that is CIMD-only would
  fail. Record that as a known interop risk, not a solved problem.
- Enabling Managed OAuth replaces the application's `401`/`WWW-Authenticate` behaviour. That is
  better for MCP discovery, but do not put a *different* hand-rolled OAuth server behind the same
  hostname and expect both to work.

### Option D: clients that cannot set headers

Claude Desktop's connector UI has no custom-header field, and a configured `Authorization` header
in Claude Code/Codex disables their OAuth fallback. For those, do not fight the client — run the
stdio bridge with `--url` and let the process attach the service token:

```json
{
  "mcpServers": {
    "uni-dashboard": {
      "command": "node",
      "args": [
        "C:\\path\\to\\uni-dashboard\\apps\\relay\\src\\cli.mjs", "mcp",
        "--url", "https://mcp.example.com/mcp",
        "--header", "CF-Access-Client-Id: <id>.access",
        "--header", "CF-Access-Client-Secret: <secret>"
      ]
    }
  }
}
```

The bridge mirrors the modern-era headers itself, so it works with both client eras.

### Client reality check

| Client | Remote HTTP | Static headers | OAuth discovery |
|---|---|---|---|
| Claude Code | yes | yes (`--header`) | yes (disabled by a configured header) |
| Codex CLI | yes | yes (`http_headers`) | yes |
| Cursor / VS Code | yes | yes (`headers`) | yes |
| Claude Desktop connector | yes | **no documented header field** | yes only |
| `mcp-remote` bridge | yes | yes (`--header`, `--header-file`) | yes |
| `curl` / scripts | yes | yes | not needed |

An application API key is a normal `Authorization: Bearer` header, so every client above that can set
headers uses it exactly like a service token — and, like a configured header in Claude Code or Codex,
it disables their OAuth fallback rather than failing over to it.

## Long-term connectivity behind Cloudflare Access

The endpoint is stateless Streamable HTTP answered with a single JSON object. That choice is the
single most important long-term decision, because it removes the entire class of failures that
comes from holding a connection open across an expiry boundary. AI-agent transports that use
server-sent events are the ones that break: Cloudflare closes idle client connections after **400
seconds**, the origin hop times out at **125 seconds** (`524`), and Workers give in-flight requests
only about **20 minutes** of grace during a runtime update. A stateless POST has none of those
exposure points, and each request is re-authenticated on its own.

### Failure modes and mitigations

| Problem | Mechanism | Long-term symptom | Mitigation |
|---|---|---|---|
| Agent receives `302` → IdP HTML | Default Access behaviour for cookie-less clients | JSON-RPC parse errors misread as server bugs; retry storms against the IdP | Strict service-token auth (→ `401`/`403`); Managed OAuth (→ `401`); the endpoint always answers JSON-RPC, never HTML |
| Browser session expiry mid-use | Application token = policy session (default 24 h); global session ≤ 1 month; then re-auth at the IdP | A dashboard XHR silently becomes HTML | `X-Requested-With: XMLHttpRequest` makes Access return `401` for XHR; irrelevant to `/mcp`, which uses no session |
| Service token expires | Token has an absolute duration chosen at creation | Every agent fails on the same day, months later | Create the token with a long duration, enable the "Expiring Access Service Token" notification (one week), and put rotation on a calendar |
| Secret lost | Shown exactly once | Unrecoverable; recreate and redeploy | Secret manager; documented recreate procedure; per-agent tokens |
| Rotation with immediate revoke | Old secret dies instantly | Hard outage for every agent holding it | Rotate with a 7-day overlap (`previous_client_secret_expires_at`) |
| Two live secrets forgotten | Rotation overlap can be up to 30 days | A leaked old secret stays valid | Cap overlap at 7 days; track the token version |
| `401` vs `403` conflated | `403` means "recognised but not authorised" | Agent retries forever with a valid secret | Retry **once** on `401` (reload secret); never retry `403`; alert a human |
| Long-lived SSE dies | 400 s client idle, 900 s proxy idle, 20 min runtime-update drain | Truncated output; half-finished work | Not implemented: every response is one JSON object; no GET stream, no keepalive |
| `524` on a slow call | 125 s origin read timeout (not applicable to a Worker-terminated request) | Intermittent timeouts on the slowest tool | Keep `/mcp` Worker-terminated; tool calls are D1 reads; if a future tool must be slow, make it async with an explicit handle |
| `waitUntil` work dropped | 30 s cap after the response | Silent audit gaps | The audit line is written inside the request, before the response |
| Runtime updates | In-flight requests, streams and WebSockets get ≤ 20 min grace | Periodic forced disconnects | Stateless requests; client retries once; no server-held state |
| Cookie-jar confusion | Non-strict Access sets `CF_Authorization`; an old cookie rides along | Expired cookie presented; puzzling `401` | Strict service-token mode (no cookie), and stateless clients |
| Access auth logs unavailable | Non-identity events (service tokens) are not in the dashboard | "Which agent did this?" is unanswerable | Worker logs `common_name` (the service-token client ID) on every tool call; use the GraphQL Analytics API for Access events |
| Claims trimmed at ~1 KB | Access trims oversized `custom` claims | Group-based rules silently stop matching | Do not authorise on custom claims; `/mcp` authorises on the assertion only |
| `cloudflared access` used for an agent | Its token is browser-bound and dies with the app session | Re-login required, unattended operation impossible | Never use it for services; Documented by Cloudflare as not for service-to-API use |
| mTLS as the only credential | Enterprise-only; missing cert is `403` at TLS level; CRL enforcement is yours | Cert expiry looks like a connection error; revocation ineffective | Use it as a second factor at most; service tokens are the primary |
| Bypass policy on `/mcp` | Bypass skips policy and request logging | No audit trail, invisible abuse | Never bypass `/mcp`; bypass at most the static discovery path |
| API key leaked (`MCP_AUTH_MODE=token`) | Bearer credential to private timetable/deadline data; no edge policy in front | Full read access until revoked; silent for as long as nobody looks | Revoke by id in one call; `mcp_audit` and `last_used_at` bound the exposure window; keys are stored as hashes so a D1 leak does not hand out credentials |
| Key expiry / forgotten rotation | Absolute expiry chosen at mint | Every agent using that key fails the same day | Quarterly rotation is create-new → deploy → verify → revoke-old; both keys are valid during the overlap |
| Pooled connections closed under you | Edge keep-alive idle is 400 s | Occasional reset on a reused socket | Client retries once on a reused-connection reset; prefer HTTP/2; use the canonical hostname |
| D1 free-tier limits | 50 queries and 10 ms CPU per invocation | `503 exceededCpu` on heavy tools | Tools are bounded D1 reads; no poll alongside a read; limits on every list argument |
| Access JWT TTL undocumented | Sample payloads show `exp = iat + 60 s`; TTL is not guaranteed | Caching an assertion is unsafe | Verify every request; cache signing keys (1 h) not assertions; accept clock skew (implemented) |

### The numbers that drive the design

| Limit | Value | Source of truth |
|---|---|---|
| Access global / application / policy session | 15 min – 1 month (default 24 h) | Cloudflare One → Session management |
| Proxy read timeout | 125 s → `524` (Enterprise can raise to 6,000 s) | Cloudflare connection limits / error 524 |
| Proxy write timeout | 30 s → `524`, not configurable | Cloudflare connection limits |
| Proxy idle timeout | 900 s → `520` | Cloudflare connection limits |
| Client ↔ Cloudflare idle | 400 s, then TCP close | Cloudflare connection limits |
| Worker HTTP request duration | No documented limit while the client is connected | Workers limits |
| Worker `waitUntil` | 30 s after response | Workers limits |
| Worker CPU | 10 ms Free / 30 s default Paid | Workers limits |
| Service-token duration | Chosen at creation (docs use `8760h`, `17520h`) | Service tokens |
| Service-token rotation overlap | 1 hour – 30 days | Service tokens |
| Service tokens per account | 50 | Cloudflare One account limits |
| Managed OAuth access token | 15 min default | Managed OAuth |
| Managed OAuth grant session | 1–2 weeks recommended for CLI/agents | Managed OAuth |

**What is not documented, and therefore not relied on:** there is no published SSE-specific idle
timeout or buffering guarantee (the 400 s client idle and 900 s proxy idle are the real bounds); the
maximum service-token duration and maximum grant session are not published; the Access JWT TTL is
not published; and service-token support for WebSocket upgrades is implied by per-request
authentication but not stated. The design avoids depending on any of them.

### Recommended design, and the alternatives rejected

**Recommended with Access:** dedicated MCP hostname, its own Access application with a `Service Auth`
policy, strict service-token authentication on, one service token per agent, `MCP_ACCESS_AUD` pinned,
and Managed OAuth enabled on the same application only if interactive OAuth clients are wanted. Keep
the human dashboard on its own application. Do not bypass Access for `/mcp`.

**If you want off Access for agents:** serve `/mcp` on a hostname Access does not cover, set
`MCP_AUTH_MODE=token`, and mint application API keys (Option B). Keep Access on the human dashboard.
You trade a vendor-managed identity for a credential layer of roughly 250 lines that you own and test:
hashed keys, explicit scopes, per-key revocation, optional expiry, last-used tracking and audit rows,
with no session management, no password storage and no OAuth authorization server. That is the
smallest honest version of "our own auth" for this app.

Rejected alternatives:

- **Bypass Access for `/mcp` and hand-roll OAuth in the Worker.** You would own registration, token
  storage, revocation, key rotation and consent, and you would lose Access policy enforcement and
  per-request logging — a `Bypass` policy enforces nothing and logs nothing. Managed OAuth already
  ships the standard-compliant version of this. (Plain application API keys are not this: they have
  no OAuth discovery, which is why clients that demand it still need Option C.)
- **Password auth for the owner.** The highest-risk component in any system, for a single-user
  dashboard that already has a working SSO path. There is no upside. If Access must go, use an OIDC
  relying-party integration, not a login form.
- **`cloudflared access` for CLI agents.** Browser-bound, application-session lifetime; Cloudflare
  documents it as not meant for services.
- **mTLS as the only credential.** Enterprise-only, a `403` at TLS level (which agents report as a
  connection error), and revocation is the operator's job. Fine as a second factor.
- **SSE / GET stream for "real-time" data.** Buys server-initiated push this read-only data does not
  need, and pays for it with every timeout and keepalive failure mode above.
- **A long-lived Access session.** Impossible: the maximum is one month and a browser is required
  once it lapses. Service tokens or API keys are the only months-long credentials.

### Rotation and incident runbook

Quarterly, with overlap:

1. `POST /accounts/{account_id}/access/service_tokens/{id}/rotate` with
   `previous_client_secret_expires_at` = now + 7 days.
2. Write the new secret to the secret store. Never to git, never to chat.
3. Restart agents one at a time; verify `initialize` → `tools/list` → one `tools/call` succeeds.
4. Confirm the new secret is authenticating in Access logs; after day 7 the old one dies.

On a suspected leak:

1. **API key lane:** `DELETE /v1/mcp-tokens/<id>` immediately, then read `mcp_audit` for that
   `token_id` and `last_used_at` to bound the exposure window. Mint a replacement, update the agent.
2. **Access lane:** rotate that service token with **revoke immediately** (omit the grace), or delete
   it and issue per-agent replacements.
3. Note that **disabling** a token also kills its previous secret during an active rotation grace.
4. Check Worker logs for the exposed identity (`common_name` or `token:<name>#<id>`) and the Access
   log export (GraphQL for non-identity events) for the exposure window.
5. Rotate every downstream credential the token could reach; the Access token is not the only blast
   radius.

API keys rotate without overlap complexity: mint a second key, deploy it, verify, revoke the first.
Do it quarterly, or on any team change.

Triage:

| Symptom | First check |
|---|---|
| `302` / HTML in agent logs | Strict service-token auth off, or the policy is not `Service Auth` |
| `401` everywhere at once | Token expired, or the secret was rotated without overlap |
| `401` for one agent only | That host's secret store or key is out of date |
| `401` with an API key | Key revoked, expired, or the deployment is in `access` mode |
| `403` ≠ `insufficient_scope` | Policy/selector mismatch, or the AUD does not match `MCP_ACCESS_AUD` |
| `403` with `insufficient_scope` | The key is valid but lacks `mcp:read`; mint a correct key |
| `524` | Something is proxying to a real origin; keep the work in the Worker |
| Duplicate side effects after a retry | Not possible here — every tool is read-only; fix the client's retry anyway |

## Deployment checklist

- [ ] Choose the topology (dedicated `mcp.` hostname recommended; `Path /mcp` on the existing app is
      possible but the AUD then equals the dashboard's, so `MCP_ACCESS_AUD` cannot isolate it).
- [ ] Choose `MCP_AUTH_MODE`: `access` (default), `token`, or `both`. `token`/`both` need minted keys
      and, for `token`, a hostname Access does not cover.
- [ ] Add the hostname/route to the Worker.
- [ ] Access lane: create the Access application for the MCP hostname; policy `Service Auth` /
      Service Token. Enable strict service token authentication.
- [ ] Access lane: create service tokens (long duration, expiry notification, one per agent).
- [ ] Access lane: set `MCP_ACCESS_AUD` (and keep `ACCESS_AUD` for the dashboard).
- [ ] Optionally enable Managed OAuth on the MCP application for interactive OAuth clients.
- [ ] Key lane: mint one API key per agent, store it in that agent's secret store, put rotation on a
      calendar. The plaintext is shown once.
- [ ] `npm run web:build && npm run worker:check && npm run deploy`.
- [ ] Verify: unauthenticated `POST /mcp` returns JSON `401` (not `302`, not HTML); an authorised
      request returns `initialize`; `tools/list` lists ten tools; one `tools/call` returns data.
- [ ] Put the rotation date in a calendar.

## Verification

```sh
npm test                              # includes test/mcp.test.mjs and test/mcp-tokens.test.mjs
node --test test/mcp-tokens.test.mjs  # key minting, hashing, revocation, expiry, scopes, audit, admin routes
node --test test/mcp.test.mjs         # protocol both eras, HTTP binding, auth gates
npm run worker:check                  # bundle the Worker; confirms /mcp imports cleanly
```

Negative checks that matter as much as the happy path:

```sh
# must be 401 JSON-RPC + WWW-Authenticate, never a 302 or HTML
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# must be 405 on GET (stateless, no SSE stream)
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.com/mcp

# must be 405 and never reach a tool
curl -sS -X POST https://mcp.example.com/mcp -H 'content-type: application/json' \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"drop_database"}}'

# key lane: a good key works, a revoked one does not
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp \
  -H 'content-type: application/json' -H "authorization: Bearer $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Run `node --test test/mcp-tokens.test.mjs` after changing anything in the credential path. It covers
the properties that are easy to regress: plaintext never stored, listing never leaks the hash, a
revoked or expired key stops working immediately, a key without `mcp:read` is `403` not `401`, audit
attribution by token id, and the local relay adapter.

## Limits and non-goals

- **Read-only by design.** No tool mutates saved state. If write access is ever wanted, it should be
  a separate, explicitly scoped tool with its own policy and audit trail.
- **One shared data space.** The dashboard is one student's instance; every authorised identity sees
  the same data. There is no per-user tool filtering.
- **No resources, prompts, sampling or subscriptions.** The server declares the `tools` capability
  only; undeclared methods return `-32601`.
- **No SSE.** Every request is answered with one JSON object; `GET` and `DELETE` return `405`.
- **No pagination.** List arguments are bounded (`limit` ≤ 100); the data volumes are personal-scale.
- **Rate limiting is not implemented in the Worker.** In `token` mode there is no Access policy in
  front either, so add a Cloudflare rate-limiting rule on the MCP hostname. The audit table is
  bounded to a rolling 30 days, pruned probabilistically.
- **Keys are managed only through an owner route** (`/v1/mcp-tokens`, under the Access gate) or the
  local CLI. There is no self-service registration; that is deliberate for a single-user dashboard.
- **Audit is Worker logs, not a table.** That is enough to answer "which identity called which tool";
  it is not a durable audit store. Add one before exposing this beyond a single owner.

## Sources

MCP:

- Specification `2026-07-28` — <https://modelcontextprotocol.io/specification/2026-07-28>
- Versioning and dual-era compatibility — <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>
- Streamable HTTP (headers, statuses, stateless rules) — <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- `server/discover` — <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>
- Tools and error split — <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- Request metadata and caching — <https://modelcontextprotocol.io/specification/2026-07-28/basic> and
  <https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching>
- Legacy revision used by current clients — <https://modelcontextprotocol.io/specification/2025-11-25>

Cloudflare:

- Access session management — <https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/>
- Application token (JWT payloads, `common_name`) — <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/>
- Service tokens — <https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>
- Managed OAuth — <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/>
- Authenticate coding agents — <https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/>
- Policies (`Service Auth`, `Bypass`) — <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/>
- Connection limits (proxy/edge timeouts) — <https://developers.cloudflare.com/fundamentals/reference/connection-limits/>
- Error 524 — <https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/>
- Workers limits — <https://developers.cloudflare.com/workers/platform/limits/>
- Cloudflare's own stateless MCP guidance — <https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/>
