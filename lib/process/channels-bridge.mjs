#!/usr/bin/env node
// provenance: polygram@0.17.11 lib/process/channels-bridge.mjs (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
// water-bridge — production Channels MCP bridge for CliProcess.
//
// Runs as stdio child of `claude --dangerously-load-development-channels server:water-bridge`.
// Connects back to its parent CliProcess (in the polygram daemon) over a per-session
// unix socket whose path + auth secret are passed via env.
//
// Owns nothing semantic. Pure proxy:
//   daemon  → bridge:  user_msg, perm_verdict, tool_ack, ping
//   bridge → daemon:   hello, session_init, tool, perm_req, pong
//
// The bridge process exits on any of:
//   - stdin EOF/close                       (claude crashed or shutdown)
//   - no ping from daemon for 30s           (daemon stalled or crashed)
//   - hello handshake rejected by daemon
//   - unix socket disconnect
//
// All inbound user content is XML-escaped before placement into the
// <channel> body — prompt-injection defense (P1 security finding).
//
// See docs/0.11.0-channels-driver-plan.md for the full design.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
// Review F#15: validate daemon→bridge messages with the shared zod schema.
// Pre-fix handleDaemonMessage operated on raw JSON.parse output — a
// malformed user_msg (e.g. text=undefined) silently injected the literal
// string "undefined" into Claude's prompt; a malformed tool_ack with
// null tool_call_id silently no-op'd and the bridge timed out on
// awaitToolAck → isError → Claude retry.
import { parseDaemonToBridgeMessage } from './channels-bridge-protocol.js'
import { z } from 'zod'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SESSION_KEY = process.env.WATER_SESSION_KEY
const SOCK        = process.env.WATER_SOCK
const SOCK_SECRET = process.env.WATER_SOCK_SECRET
// P3 naming: align internal variable with the env-var name + wire-format field.
const CLAUDE_SESSION_ID = process.env.WATER_CLAUDE_SESSION_ID

if (!SESSION_KEY || !SOCK || !SOCK_SECRET) {
  process.stderr.write('[water-bridge] missing required env (WATER_SESSION_KEY/SOCK/SOCK_SECRET)\n')
  process.exit(2)
}

// rc.11 diagnostic: bridge stderr goes to claude's TUI which is a tiny
// scrollback. The Music-topic shumorobot live failure leaves no trace of
// whether user_msg ever reached the bridge or whether the MCP notification
// dispatched successfully. Mirror every log line to a per-session file so
// we can definitively pin the failure point.
const LOG_DIR = join(homedir(), '.polygram', 'bridge-logs')
try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
// Filename: session-key gets sanitized (`:` → `_`) for file safety.
const LOG_FILE = join(LOG_DIR, `${String(SESSION_KEY).replace(/[^a-zA-Z0-9_-]/g, '_')}.${process.pid}.log`)
const fileWrite = (line) => { try { appendFileSync(LOG_FILE, line + '\n') } catch {} }

const log = (kind, payload = {}) => {
  const line = `[water-bridge] ${JSON.stringify({ t: Date.now(), kind, ...payload })}`
  process.stderr.write(line + '\n')
  fileWrite(line)
}
log('boot', { session_key: SESSION_KEY, log_file: LOG_FILE, pid: process.pid })

// ─── Stdin EOF → claude crashed; we exit so the daemon notices via socket close ──
process.stdin.on('end',   () => { log('stdin', { event: 'end'   }); process.exit(0) })
process.stdin.on('close', () => { log('stdin', { event: 'close' }); process.exit(0) })

// ─── Watchdog: exit if daemon stops pinging ──
let lastPing = Date.now()
setInterval(() => {
  if (Date.now() - lastPing > 30_000) {
    log('watchdog', { event: 'ping-timeout' })
    process.exit(3)
  }
}, 5_000).unref()

// ─── XML-escape inbound user content (prompt-injection defense) ──
// Body escape: covers &, <, > so user text can't open/close <channel> tags
// or inject entity references.
const escapeChannelBody = s =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Attribute escape: review #10. Meta values (chat_id, user, msg_id, turn_id)
// end up inside <channel ... key="value"> attributes. Telegram first_name is
// fully user-controlled and can contain double-quote, single-quote, &, <, >.
// Without escaping, a display name like `" injected="...</channel><system>...`
// breaks out of the attribute and injects into Claude's prompt.
const escapeChannelAttr = s =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

// ─── Per-call pending map: tool calls wait for daemon tool_ack ──
const pendingToolCalls = new Map() // tool_call_id → { resolve, reject, timer }
const TOOL_ACK_TIMEOUT_MS = 30_000

function awaitToolAck(toolCallId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToolCalls.delete(toolCallId)
      reject(new Error('daemon ack timeout'))
    }, TOOL_ACK_TIMEOUT_MS)
    pendingToolCalls.set(toolCallId, { resolve, reject, timer })
  })
}

function resolveToolAck(toolCallId, ok, error, messageId) {
  const p = pendingToolCalls.get(toolCallId)
  if (!p) return
  pendingToolCalls.delete(toolCallId)
  clearTimeout(p.timer)
  // 0.13: resolve with the delivered message_id so the CallTool handler can hand
  // it back to claude (for edit_message). null when the daemon didn't carry one.
  ok ? p.resolve({ message_id: messageId ?? null }) : p.reject(new Error(error || 'daemon rejected delivery'))
}

// ─── 0.12 interactive questions: `ask` blocks for the user's answer ──
// Separate from tool_ack: a question waits for the user, possibly for hours. The
// DAEMON owns the lifecycle — it resolves the ask with the user's answer, or sweeps
// it {timedout} at its configured question timeout (WATER_QUESTION_TIMEOUT_MS,
// default 24h). This local timer is ONLY a last-resort backstop for the narrow case
// where the daemon stays connected but never calls back; it sits a margin ABOVE the
// daemon timeout so the daemon always resolves first (with the proper user-facing
// message). It must track the daemon value — a hardcoded 32min here once fired long
// before the 24h wait, resolving {timedout} on a question the user answered an hour
// later (0.17.5).
const pendingQuestions = new Map() // tool_call_id → { resolve, timer }
const QUESTION_BACKSTOP_MARGIN_MS = 5 * 60 * 1000
const DAEMON_QUESTION_TIMEOUT_MS = Number(process.env.WATER_QUESTION_TIMEOUT_MS) || (24 * 60 * 60 * 1000)
const QUESTION_ANSWER_TIMEOUT_MS = DAEMON_QUESTION_TIMEOUT_MS + QUESTION_BACKSTOP_MARGIN_MS

function awaitQuestionAnswer(toolCallId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(toolCallId)
      resolve({ timedout: true })   // never reject — the agent gets a clean result
    }, QUESTION_ANSWER_TIMEOUT_MS)
    timer.unref?.()   // a pending answer must not, by itself, hold the event loop open
    pendingQuestions.set(toolCallId, { resolve, timer })
  })
}

function resolveQuestionAnswer(toolCallId, result) {
  const p = pendingQuestions.get(toolCallId)
  if (!p) return
  pendingQuestions.delete(toolCallId)
  clearTimeout(p.timer)
  p.resolve(result ?? { cancelled: true })
}

// ─── Socket: connect, handshake, then bidirectional JSON-lines ──
const sock = connect(SOCK)

sock.on('connect', () => {
  log('socket', { event: 'connect' })
  // hello + announce session_id in the same flush; daemon validates secret
  sock.write(JSON.stringify({ kind: 'hello', session_key: SESSION_KEY, secret: SOCK_SECRET }) + '\n')
  sock.write(JSON.stringify({ kind: 'session_init', claude_session_id: CLAUDE_SESSION_ID }) + '\n')
})

sock.on('error', err => {
  log('socket', { event: 'error', message: err.message })
  process.exit(4)
})

sock.on('close', () => {
  log('socket', { event: 'close' })
  process.exit(5)
})

// ─── Inbound from daemon → forward into Claude as MCP notifications ──
let buf = ''
// utf8 setEncoding reassembles multibyte sequences split across data events —
// without it a char straddling a chunk boundary decodes to U+FFFD (mirrors
// the daemon-side channels-bridge-server.js fix).
sock.setEncoding('utf8')
sock.on('data', chunk => {
  // Review R5: only `ping` resets the watchdog. Non-ping noise (user_msg
  // bursts, tool_acks, perm_verdicts) used to satisfy the liveness check
  // even when the daemon's ping loop had silently died. lastPing is now
  // updated ONLY in the case 'ping' branch below.
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let raw
    try { raw = JSON.parse(line) } catch { log('parse-error', { line: line.slice(0, 200) }); continue }
    // Review F#15: zod-validate before dispatch. Malformed messages drop with
    // a log instead of silently corrupting downstream state. hello_ack /
    // hello_reject are skipped here because they're pre-auth and the
    // discriminated union expects only post-auth shapes — handle them
    // directly off the raw payload.
    if (raw.kind === 'hello_ack' || raw.kind === 'hello_reject') {
      handleDaemonMessage(raw)
      continue
    }
    const parsed = parseDaemonToBridgeMessage(raw)
    if (!parsed.ok) {
      log('daemon-msg-schema-invalid', { kind: raw?.kind, error: parsed.error })
      continue
    }
    handleDaemonMessage(parsed.msg)
  }
})

function handleDaemonMessage(msg) {
  switch (msg.kind) {
    case 'hello_ack':
      log('handshake', { event: 'ack' })
      break

    case 'hello_reject':
      log('handshake', { event: 'reject', reason: msg.reason })
      process.exit(6)
      break

    case 'user_msg':
      log('user_msg-rx', { text_len: msg.text?.length, turn_id: msg.turn_id, chat_id: msg.chat_id })
      mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: escapeChannelBody(msg.text),
          meta: {
            // Review #10: attribute-safe escape for ALL meta values, not just
            // content. Telegram first_name is user-controlled and was previously
            // raw — could break out of the attribute via quote injection.
            chat_id: escapeChannelAttr(msg.chat_id ?? ''),
            user:    escapeChannelAttr(msg.user ?? ''),
            msg_id:  escapeChannelAttr(msg.msg_id ?? ''),
            turn_id: escapeChannelAttr(msg.turn_id ?? ''),
          },
        },
      }).then(
        () => log('user_msg-notify-ok', { turn_id: msg.turn_id }),
        (e) => log('notify-error', { kind: 'user_msg', error: e.message }),
      )
      break

    case 'perm_verdict':
      mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      }).catch(e => log('notify-error', { kind: 'perm_verdict', error: e.message }))
      break

    case 'tool_ack':
      resolveToolAck(msg.tool_call_id, msg.ok, msg.error, msg.message_id)
      break

    case 'question_answer':
      resolveQuestionAnswer(msg.tool_call_id, msg.result)
      break

    case 'ping':
      // R5: ping is the ONLY signal that proves the daemon's ping-loop is
      // healthy. Update watchdog timestamp here, not on the generic 'data'
      // event — otherwise unrelated traffic could mask a dead ping-loop.
      lastPing = Date.now()
      sock.write(JSON.stringify({ kind: 'pong' }) + '\n')
      break

    default:
      log('unknown-kind', { kind: msg.kind })
  }
}

// ─── MCP server: capabilities + reply tool ──
const mcp = new Server(
  { name: 'water-bridge', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    // Phase 0 finding: Claude refers to tools by their prefixed MCP name.
    // Mention the prefixed form explicitly so reasoning doesn't drift.
    instructions:
      'Inbound user messages arrive as <channel source="water-bridge" chat_id="..." user="..."> tags. ' +
      'Always reply via the `mcp__water-bridge__reply` tool — passing chat_id verbatim — before ending a turn. ' +
      'For long tool calls, send a brief progress reply first so the user is not waiting in silence.',
  },
)

// 0.12 Phase 1.6 — MCP-ready signal (cold-spawn race fix, Finding 0.3.A).
// Claude's MCP client calls ListTools exactly once during server registration
// (after Initialize, before notifications can be routed). When that first
// call arrives here, we know claude has the bridge fully registered and
// will route incoming notifications to our 'claude/channel' capability.
// We tell the daemon by writing a single {kind:'mcp-ready'} message, and
// polygram's _waitForBridgeHandshake gates send() on this in addition to
// the existing daemon-side hello. Before this fix, polygram's handshake
// resolved when the bridge connected to the daemon socket — BEFORE claude
// finished MCP registration — and user_msg notifications were silently
// dropped 33% of the time (probe-cold-spawn.mjs).
let _mcpReadySent = false
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (!_mcpReadySent) {
    _mcpReadySent = true
    log('mcp-ready', { trigger: 'first ListToolsRequest' })
    try { sock.write(JSON.stringify({ kind: 'mcp-ready', session: SESSION_KEY }) + '\n') } catch (err) {
      log('mcp-ready-write-fail', { error: err.message })
    }
  }
  return {
  tools: [{
    name: 'reply',
    description: 'Send a message back to the originating Telegram chat. ' +
                 'chat_id MUST match the chat_id from the inbound <channel> tag. ' +
                 'turn_id MUST echo the turn_id from the inbound <channel> tag (when present) ' +
                 'so concurrent turns route their replies correctly. ' +
                 'ALWAYS set consumed_turn_ids to the turn_id of EVERY <channel> message this ' +
                 'reply answers or absorbs (including mid-turn follow-ups) — it is how polygram ' +
                 'confirms delivery of follow-ups. ' +
                 'Returns {ok, message_id}: keep the message_id to update that bubble in place ' +
                 'with `edit_message` (progressive status on long tasks).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Echo of chat_id from inbound channel meta.' },
        turn_id: { type: 'string', description: 'Echo of turn_id from inbound channel meta (required for correct turn routing).' },
        text:    { type: 'string', description: 'Message body (markdown ok).' },
        files:   { type: 'array',  items: { type: 'string' }, description: 'Optional absolute file paths to attach.' },
        interim: {
          type: 'boolean',
          description: 'Set true ONLY for a short status/progress update on a long task '
            + '(e.g. "Looking into that now…"). An interim reply is shown to the user but is '
            + 'NOT the turn\'s answer — you MUST still deliver the real result as a later reply '
            + 'with interim omitted/false in the SAME turn. NEVER end a turn on an interim reply.',
        },
        // 0.13 D2 Tier 2C: the fold-acknowledgment contract. The single turn_id
        // field can't express a combined reply that covers a mid-turn follow-up
        // (P0 spike Q-B: claude echoes only the trigger id) — this array can.
        consumed_turn_ids: {
          type: 'array', items: { type: 'string' },
          description: 'turn_id of EVERY <channel> message this reply answers or has absorbed since your last reply, including mid-turn follow-ups. Set it on EVERY reply, even short one-line ones; if you answered two messages in one reply, list BOTH turn_ids. Omitting a folded follow-up makes polygram treat it as dropped.',
        },
      },
      required: ['chat_id', 'text'],
    },
  }, {
    // 0.13: edit a message already sent via `reply`, in place — the progressive-
    // status primitive. Update one bubble instead of sending several.
    name: 'edit_message',
    description: 'Edit a message you previously sent via `reply`, in place. Use this for ' +
                 'progressive status on a long task: send a short status with `reply`, take the ' +
                 'returned message_id, then `edit_message` it as you make progress (ending with ' +
                 'the final answer). Keep status in PLAIN LANGUAGE — never tool names like Bash/Edit. ' +
                 'One bubble only (no chunking); for long content use `reply` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id:    { type: 'string', description: 'Echo of chat_id from inbound channel meta.' },
        turn_id:    { type: 'string', description: 'Echo of turn_id from inbound channel meta.' },
        message_id: { type: 'number', description: 'The message_id returned by the `reply` tool call you want to update.' },
        text:       { type: 'string', description: 'New full message body (markdown ok) — replaces the old text.' },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  }, {
    // 0.12 interactive questions: ask the Telegram user a multiple-choice question
    // as tap-to-answer inline buttons. USE THIS instead of any interactive menu —
    // it returns the user's selection(s) as the tool result. Blocks until answered.
    name: 'ask',
    description: 'Ask the Telegram user a multiple-choice question (rendered as inline ' +
                 'keyboard buttons; supports multiSelect + a free-text "Other"). Use this ' +
                 'for ANY choice/confirmation — never present a numbered list and wait, and ' +
                 'never use a terminal selection menu. Blocks until the user answers; returns ' +
                 '{answers:[{header,selected:[label...],other?}]} (or {cancelled}/{timedout}).',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Echo of chat_id from inbound channel meta.' },
        turn_id: { type: 'string', description: 'Echo of turn_id from inbound channel meta.' },
        questions: {
          type: 'array', description: 'Up to 4 questions, asked one at a time.',
          items: {
            type: 'object',
            properties: {
              header:      { type: 'string', description: 'Short chip label (≤12 chars).' },
              question:    { type: 'string', description: 'The question text.' },
              multiSelect: { type: 'boolean', description: 'Allow selecting several options (checkboxes).' },
              allowOther:  { type: 'boolean', description: 'Offer a free-text "type my own" answer (default true).' },
              options: {
                type: 'array', description: '2–4 options.',
                items: { type: 'object', properties: {
                  label:       { type: 'string', description: 'Button label (≤40 chars).' },
                  description: { type: 'string', description: 'Shown in the message body.' },
                } },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['chat_id', 'questions'],
    },
  }],
  }
})

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply' && req.params.name !== 'ask' && req.params.name !== 'edit_message') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  const toolCallId = randomUUID()

  // `ask` blocks for the user's answer (question_answer), NOT a fast tool_ack.
  if (req.params.name === 'ask') {
    const answerP = awaitQuestionAnswer(toolCallId)
    try {
      sock.write(JSON.stringify({
        kind: 'tool', session: SESSION_KEY, tool_call_id: toolCallId, name: 'ask', args: req.params.arguments,
      }) + '\n')
    } catch (e) {
      // The daemon never received the ask → no row, no sweep. Resolve the awaiter
      // now (clears the 20-min timer) instead of stranding the agent on it.
      resolveQuestionAnswer(toolCallId, { cancelled: true, error: `bridge write failed: ${e?.message || e}` })
    }
    const result = await answerP
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  }

  const ackP = awaitToolAck(toolCallId)
  sock.write(JSON.stringify({
    kind: 'tool',
    session: SESSION_KEY,
    tool_call_id: toolCallId,
    name: req.params.name,
    args: req.params.arguments,
  }) + '\n')
  try {
    const ack = await ackP
    // Return {ok, message_id} as JSON so claude can read the delivered bubble's
    // id and `edit_message` it later (progressive status). For a plain reply with
    // no id (solo sticker/reaction) message_id is null.
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: ack?.message_id ?? null }) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `delivery failed: ${err.message}` }], isError: true }
  }
})

// ─── Permission relay: Claude Code → bridge → daemon → human → verdict back ──
// Review F#14: only request_id + tool_name are required. description /
// input_preview MAY be empty (Bash with no args, future tool variants, slim
// tools that don't carry a preview). Pre-fix any of those four being absent
// or empty rejected the whole notification — MCP silently dropped the perm
// request, no approval card surfaced, Claude blocked forever waiting for a
// verdict that never came. Now those two are optional+defaulted to '' so
// the perm request always relays.
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id:    z.string().min(1),
    tool_name:     z.string().min(1),
    description:   z.string().optional().default(''),
    input_preview: z.string().optional().default(''),
  }).passthrough(),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  sock.write(JSON.stringify({
    kind: 'perm_req',
    session: SESSION_KEY,
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  }) + '\n')
})

await mcp.connect(new StdioServerTransport())
log('startup', { pid: process.pid, node: process.version, session_key: SESSION_KEY })
