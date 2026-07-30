#!/usr/bin/env node

'use strict';

const { call, socketPathFor, readSecret } = require('../lib/ipc/client');

function usage() {
  console.error('Usage: water-ipc <account> ping|busy|injectTurn|sendText|containmentProbeStart|containmentProbeStop [json-payload]');
}

async function main(argv = process.argv.slice(2)) {
  const [account, op, payloadText] = argv;
  if (
    !account
    || ![
      'ping',
      'busy',
      'injectTurn',
      'sendText',
      'containmentProbeStart',
      'containmentProbeStop',
    ].includes(op)
  ) {
    usage();
    return 2;
  }

  let payload = {};
  if (payloadText !== undefined) {
    try {
      payload = JSON.parse(payloadText);
    } catch {
      console.error('water-ipc: payload must be valid JSON');
      return 2;
    }
  }

  const response = await call({
    path: socketPathFor(account),
    op,
    payload,
    secret: op === 'ping' ? null : readSecret(account),
  });
  if (!response.ok) {
    console.error(`water-ipc: ${op} unavailable`);
    return 1;
  }
  if (op === 'busy') {
    const inFlight = Number(response.in_flight);
    if (response.account !== account || !Number.isSafeInteger(inFlight) || inFlight < 0) {
      console.error('water-ipc: busy unavailable');
      return 1;
    }
    console.log(JSON.stringify({ account, in_flight: inFlight }));
  } else {
    console.log(JSON.stringify(response));
  }
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      const op = process.argv[3] || 'request';
      console.error(`water-ipc: ${op} unavailable`);
      process.exitCode = 1;
    });
}

module.exports = { main };
