#!/usr/bin/env node
'use strict';
// This executable is copied to a private bin directory and put on PATH. It
// never delegates to a real Tailscale command or makes a network request.
const fs = require('fs');
const file = process.env.NIKUI_R27_TAILSCALE_CONFIG || require('path').resolve(__dirname, '../routes.json');
if (!file) throw Error('PRIVATE_TAILSCALE_FIXTURE_REQUIRED');
const args = process.argv.slice(2), config = JSON.parse(fs.readFileSync(file));
fs.appendFileSync(process.env.NIKUI_R27_TAILSCALE_LOG || require('path').resolve(__dirname, '../route-calls.jsonl'), JSON.stringify(args) + '\n');
if (args.join(' ') === 'serve status --json') process.stdout.write(JSON.stringify(config));
else if (args.join(' ') === 'status --json') process.stdout.write(JSON.stringify({ BackendState: 'Running',
  Self: { DNSName: 'fixture.tail123.ts.net.' }, CertDomains: ['fixture.tail123.ts.net'] }));
else if (args[0] === 'serve' && args.includes('--https=443')) {
  const handlers = config.Web['fixture.tail123.ts.net:443'].Handlers;
  if (args.at(-1) === 'off') {
    if (!args.includes('--set-path=/')) throw Error('UNSCOPED_ROUTE_DELETION');
    delete handlers['/'];
  } else {
    const proxy = args.find((a) => /^http:\/\/127\.0\.0\.1:\d+$/.test(a));
    if (!proxy) throw Error('UNKNOWN_ROUTE_COMMAND');
    handlers['/'] = { Proxy: proxy };
  }
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
} else throw Error('FORBIDDEN_TAILSCALE_COMMAND: ' + args.join(' '));
