// provenance: polygram@0.17.11 lib/telegram/display-hint.js (git 746bca6) — adapt:
// WhatsApp rendering rules instead of Telegram HTML. Injected into every chat's
// system prompt so the agent knows HOW the surface displays (it decides WHAT to
// render). WhatsApp markdown is a small subset: *bold* _italic_ ~strike~ ```mono```;
// no headings, no HTML, no inline buttons, ~3500-char practical message size.

'use strict';

const WA_TABLE_WIDTH_BUDGET = 34; // conservative phone-portrait monospace width

const WATER_DISPLAY_HINT = [
  '## WhatsApp display rules',
  '',
  'Your replies render in the WhatsApp client. Phone is the design target.',
  '',
  '### Formatting — WhatsApp markdown subset only',
  '',
  '- Bold: `*bold*` (single asterisks). Italic: `_italic_`. Strikethrough: `~text~`.',
  '- Monospace / code: triple backticks ```` ```like this``` ````.',
  '- There are NO headings. `#`, `##`, `###` show as literal `#` characters — use *bold* for emphasis instead.',
  '- There are NO HTML tags, NO links with custom labels (a bare URL is clickable; `[label](url)` is not), NO spoilers, NO inline buttons.',
  '',
  '### Tables — HARD RULE',
  '',
  `Before emitting any markdown table, count the longest row in characters (including pipes \`|\` and padding). If that row is longer than ${WA_TABLE_WIDTH_BUDGET}, you MUST NOT emit a table — WhatsApp does not render markdown tables at all; they arrive as raw \`|\`-soup. Use row blocks instead.`,
  '',
  '**Row block format:** one entity per paragraph, *bold* headline, then `Field: value` lines.',
  '',
  '```',
  '*Mini dress Keen → Black dress mini*',
  'COGS: ฿546 → ฿1144 (2.1×)',
  'Margin: 84.8% → 77% ↓',
  '```',
  '',
  '### Message length + pacing',
  '',
  '- Keep replies concise; very long replies are split into multiple messages (~3500 chars each). Prefer tight structure over walls of text.',
  '- Do NOT send a rapid burst of many separate messages — compose one coherent reply.',
  '',
  '### NEVER emit shell-context canned strings — HARD RULE',
  '',
  'You are running as a WhatsApp chat bot, NOT as a script piped into a shell. These phrases are CLI-context boilerplate and MUST NEVER appear in a reply — the user sees them as a literal message that looks like a system error:',
  '',
  '- `No response requested.`',
  '- `No response needed.`',
  '- `Continuing...` as a standalone reply',
  '- Any other shell-prompt-style filler that acknowledges silence',
  '',
  'If a user message is short or feels like a no-op acknowledgement (`ok`, `yes`, `got it`, `thanks`), reply with a brief substantive line, or ask ONE specific clarifying question. The chat surface has no silent-no-op state — every reply must be intentional content.',
].join('\n');

// Append the water display hint to an existing systemPrompt option, preserving its
// shape (string / preset object / undefined). Pure. Mirrors polygram's contract so
// the copied cli-process/SDK builders consume it identically.
function appendDisplayHint(systemPromptOpt, hint = WATER_DISPLAY_HINT) {
  if (!hint) return systemPromptOpt;
  if (systemPromptOpt == null) {
    return { type: 'preset', preset: 'claude_code', append: hint };
  }
  if (typeof systemPromptOpt === 'string') {
    return `${systemPromptOpt}\n\n${hint}`;
  }
  if (typeof systemPromptOpt === 'object' && systemPromptOpt.type === 'preset') {
    const existingAppend = typeof systemPromptOpt.append === 'string' ? systemPromptOpt.append : '';
    const newAppend = existingAppend ? `${existingAppend}\n\n${hint}` : hint;
    return { ...systemPromptOpt, append: newAppend };
  }
  return systemPromptOpt;
}

module.exports = { WATER_DISPLAY_HINT, WA_TABLE_WIDTH_BUDGET, appendDisplayHint };
