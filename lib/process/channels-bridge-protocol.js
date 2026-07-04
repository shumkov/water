// provenance: polygram@0.17.11 lib/process/channels-bridge-protocol.js (git 746bca6) — verbatim*: env prefix WATER_, bridge name water-bridge, vendor path (SHARED-LIB.md).
/**
 * Bridge ↔ daemon socket protocol — typed schemas.
 *
 * Wire format: newline-delimited JSON over a unix socket per session.
 * Both endpoints (CliProcess and channels-bridge.mjs) speak the same
 * message kinds. This module centralizes the shape so both sides safeParse
 * inbound messages with the same constraints — protecting against malformed
 * payloads silently corrupting pending-state Maps.
 *
 * Adding a new message kind:
 *   1. Define its schema below as `<KindName>MessageSchema`
 *   2. Add it to `AnyDaemonToBridgeMessage` or `AnyBridgeToDaemonMessage`
 *   3. Handle it in the corresponding switch (cli-process.js
 *      _onBridgeMsg or channels-bridge.mjs handleDaemonMessage)
 *
 * Validation policy:
 *   - Daemon side uses `safeParse` and drops malformed messages with a warn
 *     (downgrades silent corruption into observable log)
 *   - Bridge side does the same on inbound from daemon
 *   - All validation happens AFTER hello-handshake auth (the auth gate is
 *     the first line of defense; schema is the second)
 */

'use strict';

const { z } = require('zod');

// ─── shared primitives ─────────────────────────────────────────────

const NonEmptyString = z.string().min(1);
const OptionalString = z.string().optional();
const ToolCallId     = z.string().min(1);
const RequestId      = z.string().min(1);
const TurnId         = z.string().min(1);

// ─── bridge → daemon ───────────────────────────────────────────────

const HelloSchema = z.object({
  kind: z.literal('hello'),
  session_key: NonEmptyString,
  secret:      NonEmptyString,
}).passthrough();

const SessionInitSchema = z.object({
  kind: z.literal('session_init'),
  claude_session_id: z.string(),   // may be empty if claude generated one before bridge sees it
}).passthrough();

const ToolCallMessageSchema = z.object({
  kind: z.literal('tool'),
  session: NonEmptyString,
  tool_call_id: ToolCallId,
  // 'ask' (0.12 interactive questions): a blocking tool whose answer rides back
  // on a `question_answer` daemon→bridge message (NOT the fast `tool_ack`); its
  // args are {chat_id, turn_id?, questions:[...]}, not reply-shaped. _dispatchToolCall
  // branches on the name so the reply-only paths (chat_id-mismatch, content-dedup,
  // reply-turn-binding) don't run for it.
  name: z.enum(['reply', 'react', 'edit_message', 'ask']),
  args: z.object({}).passthrough(),
}).passthrough();

const PermRequestMessageSchema = z.object({
  kind: z.literal('perm_req'),
  session: NonEmptyString,
  request_id: RequestId,
  tool_name: NonEmptyString,
  description: z.string(),
  input_preview: z.string(),
}).passthrough();

const PongMessageSchema = z.object({
  kind: z.literal('pong'),
}).passthrough();

// 0.12 Phase 1.6: bridge tells daemon when claude has finished registering
// the bridge as an MCP server (claude sent its first ListToolsRequest).
// Polygram's _waitForBridgeHandshake gates on this in addition to hello,
// eliminating the cold-spawn race (Finding 0.3.A).
const McpReadyMessageSchema = z.object({
  kind: z.literal('mcp-ready'),
  session: NonEmptyString,
}).passthrough();

const AnyBridgeToDaemonMessage = z.discriminatedUnion('kind', [
  HelloSchema,
  SessionInitSchema,
  ToolCallMessageSchema,
  PermRequestMessageSchema,
  PongMessageSchema,
  McpReadyMessageSchema,
]);

// ─── daemon → bridge ───────────────────────────────────────────────

const HelloAckSchema = z.object({
  kind: z.literal('hello_ack'),
}).passthrough();

const HelloRejectSchema = z.object({
  kind: z.literal('hello_reject'),
  reason: z.string().optional(),
}).passthrough();

const UserMessageSchema = z.object({
  kind: z.literal('user_msg'),
  text: z.string(),
  chat_id: z.union([z.string(), z.number()]).optional(),
  user:    OptionalString,
  msg_id:  z.union([z.string(), z.number()]).optional(),
  turn_id: OptionalString,
}).passthrough();

const PermVerdictMessageSchema = z.object({
  kind: z.literal('perm_verdict'),
  request_id: RequestId,
  behavior: z.enum(['allow', 'deny']),
}).passthrough();

const ToolAckMessageSchema = z.object({
  kind: z.literal('tool_ack'),
  tool_call_id: ToolCallId,
  ok: z.boolean(),
  error: z.string().optional(),
  // 0.13: the delivered Telegram message_id, surfaced back to claude so it can
  // `edit_message` that bubble for progressive status. Present on a successful
  // `reply`/`edit_message` ack; absent on errors / re-acks.
  message_id: z.union([z.number(), z.string()]).nullish(),
}).passthrough();

// 0.12 interactive questions: carries the user's answer back for an `ask` tool
// call. Separate from `tool_ack` (which has no payload field and resolves the
// fast reply round-trip) so a blocking question can return a structured result.
// `result` is one of {answers:[...]} | {cancelled:true} | {timedout:true}.
const QuestionAnswerMessageSchema = z.object({
  kind: z.literal('question_answer'),
  tool_call_id: ToolCallId,
  result: z.object({}).passthrough(),
}).passthrough();

const PingMessageSchema = z.object({
  kind: z.literal('ping'),
}).passthrough();

const AnyDaemonToBridgeMessage = z.discriminatedUnion('kind', [
  HelloAckSchema,
  HelloRejectSchema,
  UserMessageSchema,
  PermVerdictMessageSchema,
  ToolAckMessageSchema,
  QuestionAnswerMessageSchema,
  PingMessageSchema,
]);

// ─── helpers ──────────────────────────────────────────────────────

/**
 * Parse + validate a bridge → daemon message. Returns
 * {ok:true, msg} on success or {ok:false, error} on failure.
 *
 * @param {unknown} raw — already JSON.parsed object
 * @returns {{ok: true, msg: object}|{ok: false, error: string}}
 */
function parseBridgeToDaemonMessage(raw) {
  const r = AnyBridgeToDaemonMessage.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: zodErrorBrief(r.error, raw?.kind) };
}

function parseDaemonToBridgeMessage(raw) {
  const r = AnyDaemonToBridgeMessage.safeParse(raw);
  if (r.success) return { ok: true, msg: r.data };
  return { ok: false, error: zodErrorBrief(r.error, raw?.kind) };
}

function zodErrorBrief(err, kindHint) {
  const issues = (err?.issues || []).slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`);
  return `kind=${kindHint || '?'} — ${issues.join('; ') || 'unknown'}`;
}

module.exports = {
  // schemas (exported for tests + downstream consumers)
  HelloSchema,
  SessionInitSchema,
  ToolCallMessageSchema,
  PermRequestMessageSchema,
  PongMessageSchema,
  AnyBridgeToDaemonMessage,
  HelloAckSchema,
  HelloRejectSchema,
  UserMessageSchema,
  PermVerdictMessageSchema,
  ToolAckMessageSchema,
  QuestionAnswerMessageSchema,
  PingMessageSchema,
  AnyDaemonToBridgeMessage,
  // helpers
  parseBridgeToDaemonMessage,
  parseDaemonToBridgeMessage,
};
