#!/usr/bin/env node
// PROOF: the copied polygram session engine works in water.
//
// Spawns a REAL claude TUI (vendored, pinned 2.1.173) via water's copied CliProcess,
// injects one WhatsApp-shaped message through the channels bridge, and asserts the
// agent's reply comes back through water's tool-dispatcher. This is the gate before
// extracting the engine into a shared library (docs/SHARED-LIB.md).
//
// Run:  node scripts/spikes/prove-session-engine.mjs
// Pass: the reply tool fires within the timeout and its text contains the nonce.

import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);

const { CliProcess, createTmuxRunner, claudeBin } = require('@shumkov/orchestra');
const { ensureVendoredClaudeBin, CLAUDE_CLI_PINNED_VERSION } = claudeBin;

const NONCE = 'PONG-' + Math.floor(Date.now() / 1000);
const CHAT_JID = '120363419377779909@g.us';           // a real WhatsApp group JID shape
const SESSION_KEY = CHAT_JID;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'water-prove-'));

const vendored = ensureVendoredClaudeBin(CLAUDE_CLI_PINNED_VERSION);
if (!vendored.ok) { console.error(`[prove] cannot vendor claude: ${vendored.reason}`); process.exit(1); }
const claudeBinPath = vendored.path;
console.log(`[prove] claude=${claudeBinPath}\n[prove] nonce=${NONCE} chat=${CHAT_JID}\n[prove] cwd=${cwd}`);

const tmuxRunner = createTmuxRunner({ logger: console, sessionPrefix: 'water' });

let replyText = null;
let replyChat = null;
const toolDispatcher = async ({ toolName, text, chatId }) => {
  console.log(`[prove] TOOL ${toolName} chat=${chatId} text=${JSON.stringify((text || '').slice(0, 120))}`);
  if (toolName === 'reply') { replyText = text; replyChat = chatId; return { ok: true, message_id: '3EB0PROOF' }; }
  return { ok: true };
};

const proc = new CliProcess({
  sessionKey: SESSION_KEY, chatId: CHAT_JID, threadId: null, label: 'prove',
  tmuxRunner, botName: 'water-prove', claudeBin: claudeBinPath, toolDispatcher, displayHint: '', logger: console,
  // water's identity — proves the parameterized engine uses water's names end to end.
  sessionPrefix: 'water', bridgeServerName: 'water-bridge', productName: 'water', surfaceName: 'WhatsApp',
});

proc.on('init', (i) => console.log(`[prove] init session=${i.session_id}`));
proc.on('bridge-ready', () => console.log('[prove] bridge-ready'));
proc.on('tool-use', (n) => console.log(`[prove] tool-use ${n}`));

const cleanup = async (code) => { try { await proc.kill('prove-done'); } catch {} try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} process.exit(code); };

(async () => {
  console.log('[prove] start()…');
  const t0 = Date.now();
  await proc.start({ cwd, model: 'sonnet', effort: 'low', permissionMode: 'bypassPermissions' });
  console.log(`[prove] started in ${Date.now() - t0}ms`);

  // Minimal WhatsApp-shaped channel message. The bridge wraps this as a <channel>
  // note; the append-system-prompt (built by CliProcess) teaches the reply contract.
  const prompt = `This is an automated test. Using your reply tool with chat_id="${CHAT_JID}", reply with EXACTLY this text and nothing else: ${NONCE}`;
  console.log('[prove] send()…');
  const result = await Promise.race([
    proc.send(prompt, { context: { user: 'prove', sourceMsgId: 'U1' } }),
    new Promise((_, r) => setTimeout(() => r(new Error('timeout 120s')), 120_000)),
  ]);
  console.log(`[prove] turn result subtype=${result?.metrics?.resultSubtype} alreadyDelivered=${result?.alreadyDelivered}`);

  const ok = typeof replyText === 'string' && replyText.includes(NONCE) && replyChat === CHAT_JID;
  console.log(`\n[prove] RESULT: ${ok ? 'PASS' : 'FAIL'} — reply ${ok ? 'round-tripped through the bridge + tool-dispatcher' : `did NOT match (chat=${replyChat}, text=${JSON.stringify((replyText || '').slice(0, 80))})`}`);
  await cleanup(ok ? 0 : 1);
})().catch(async (e) => { console.error(`[prove] FATAL ${e.stack || e.message}`); await cleanup(1); });

setTimeout(() => { console.error('[prove] HARD-CAP 150s'); cleanup(1); }, 150_000).unref();
