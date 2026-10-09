'use strict';
const { SlackRoom, MANIFEST, SETUP_URL } = require('../src/slackRoom.js');

/** A service that records what it was asked, and answers like Slack would. */
function fakeService() {
  const calls = [];
  return {
    calls,
    state: () => ({ connected: true, socket: 'live', error: null, me: { id: 'UME', teamId: 'T1' },
      unresolved: [], vips: [], conversations: [{ id: 'D1', title: 'Anna', pending: true }] }),
    thread: async (id, thread) => { calls.push(['thread', id, thread]); return { conversation: { id }, messages: [{ ts: '1.0', html: 'hi' }] }; },
    reply: async (id, text, thread) => { calls.push(['reply', id, text, thread]); if (text === 'boom') { const e = new Error('x'); e.code = 'not_in_channel'; throw e; } return { ts: '2.0' }; },
    seenInNikui: (id) => calls.push(['seen', id]),
    refreshSidebar: async () => calls.push(['refresh']),
    permalink: async (id, ts) => `https://x.slack.com/archives/${id}/p${ts || ''}`
  };
}

function room(service, extra) {
  const said = { vips: null, enabled: null, connected: 0, opened: [] };
  const audit = [];
  const r = new SlackRoom(Object.assign({
    service: () => service,
    settings: () => ({ enabled: true, hasTokens: true, vipList: ['anna@x.com'], clock: '12h' }),
    setVips: async (list) => { said.vips = list; },
    setEnabled: async (on) => { said.enabled = on; },
    connect: async () => { said.connected++; },
    openUrl: (url) => said.opened.push(url),
    audit: (entry) => audit.push(entry)
  }, extra || {}));
  return { r, said, audit };
}

function seat(r, id, how) {
  const posted = [];
  r.join(id, Object.assign({ local: false, control: false, device: { id: 'phone', name: 'Phone', kind: 'device' }, looking: () => true }, how || {}), (m) => posted.push(m));
  return posted;
}

module.exports = async function () {
  suite('Slack through NikUI: who may do what');

  const service = fakeService();
  const { r, said, audit } = room(service);

  const watcher = seat(r, 'w');
  await r.handle('w', { type: 'slack:ready' });
  const first = watcher[0];
  checkEqual('ready answers with the state', first.type, 'slack:state');
  check('the service state is in it', first.state.conversations.length === 1 && first.state.socket === 'live');
  check('and the settings', first.state.enabled && first.state.hasTokens && first.state.clock === '12h'
    && first.state.vipList[0] === 'anna@x.com');
  check('a watching phone may not reply or edit', !first.state.mayReply && !first.state.mayEdit && !first.state.local);
  check('the setup link carries the manifest', SETUP_URL.indexOf('manifest_json=') > 0
    && JSON.parse(decodeURIComponent(SETUP_URL.split('manifest_json=')[1])).settings.socket_mode_enabled === true);
  check('user scopes only: everything happens as you', !MANIFEST.oauth_config.scopes.bot
    && MANIFEST.oauth_config.scopes.user.includes('chat:write') && MANIFEST.oauth_config.scopes.user.includes('im:write'));

  await r.handle('w', { type: 'slack:open', conversation: 'D1' });
  check('opening on a phone counts as seen in NikUI', service.calls.some((c) => c[0] === 'seen' && c[1] === 'D1'));
  check('and loads the thread', watcher.some((m) => m.type === 'slack:thread' && m.messages.length === 1));
  check('opening never replies or marks anything in Slack', !service.calls.some((c) => c[0] === 'reply'));

  watcher.length = 0;
  await r.handle('w', { type: 'slack:reply', id: 'a', conversation: 'D1', text: 'on it' });
  check('a watching phone cannot reply', watcher[0].type === 'slack:sent' && watcher[0].ok === false && /only watch/.test(watcher[0].reason));
  check('and nothing went to Slack', !service.calls.some((c) => c[0] === 'reply'));
  check('the refusal is written down', audit.some((a) => a.action === 'slack reply' && a.allowed === false));

  await r.handle('w', { type: 'slack:vips', vips: ['x'] });
  check('nor change the VIPs', said.vips === null && watcher.some((m) => m.type === 'slack:refused'));

  service.calls.length = 0;
  watcher.length = 0;
  await r.handle('w', { type: 'slack:refresh' });
  check('any seat may ask for a fresher sidebar, no grant needed', service.calls.some((c) => c[0] === 'refresh'));
  check('it is told the state again', watcher.some((m) => m.type === 'slack:state'));
  check('and nothing is written to the trail for it', !audit.some((a) => a.action === 'slack refresh'));

  const steering = seat(r, 's', { control: true });
  await r.handle('s', { type: 'slack:open', conversation: 'D1', thread: '1.0' });
  steering.length = 0;
  await r.handle('s', { type: 'slack:reply', id: 'b', conversation: 'D1', text: 'on it', thread: '1.0' });
  check('a phone that may send prompts replies', steering.some((m) => m.type === 'slack:sent' && m.id === 'b' && m.ok));
  check('in the thread it was looking at', service.calls.some((c) => c[0] === 'reply' && c[1] === 'D1' && c[3] === '1.0'));
  check('and is written down', audit.some((a) => a.action === 'slack reply' && a.allowed === true));
  check('everybody on that conversation sees it land', watcher.some((m) => m.type === 'slack:thread'));

  steering.length = 0;
  await r.handle('s', { type: 'slack:reply', id: 'c', conversation: 'D1', text: '   ' });
  check('nothing to send is not sent', steering[0].ok === false);
  await r.handle('s', { type: 'slack:reply', id: 'd', conversation: 'D1', text: 'boom' });
  check('Slack saying no is said in words', steering.some((m) => m.id === 'd' && m.ok === false && /not in that conversation/.test(m.reason)));

  await r.handle('s', { type: 'slack:vips', vips: [' Anna ', 'anna', '@bob', 42, 'x'.repeat(200)] });
  checkEqual('VIPs are trimmed, deduplicated and only strings', said.vips, ['Anna', '@bob']);

  steering.length = 0;
  await r.handle('s', { type: 'slack:connect' });
  check('tokens are only ever typed on the laptop', said.connected === 0 && steering.some((m) => m.type === 'slack:refused'));

  await r.handle('s', { type: 'slack:link', conversation: 'D1', ts: '1.0' });
  check('a phone gets the link to open itself', steering.some((m) => m.type === 'slack:link' && /archives\/D1/.test(m.url)));

  // The editor's own tab: this machine.
  let looking = false;
  const editor = seat(r, 'e', { local: true, device: null, looking: () => looking });
  service.calls.length = 0;
  await r.handle('e', { type: 'slack:open', conversation: 'D2' });
  check('a tab that popped up on its own has not been read', !service.calls.some((c) => c[0] === 'seen'));
  looking = true;
  r.looked('e');
  check('until you click into it', service.calls.some((c) => c[0] === 'seen' && c[1] === 'D2'));
  await r.handle('e', { type: 'slack:connect' });
  checkEqual('the laptop may connect', said.connected, 1);
  await r.handle('e', { type: 'slack:link', conversation: 'D1' });
  check('and opens links itself', said.opened.length === 1);
  await r.handle('e', { type: 'slack:setup' });
  check('the setup page opens on the laptop, Slack connected or not', said.opened[1] === SETUP_URL);
  await r.handle('e', { type: 'slack:reply', id: 'e1', conversation: 'D2', text: 'hi' });
  check('the editor is not written in the trail', !audit.some((a) => a.detail === 'D2'));

  // Session sign-in: the two values are typed into the laptop's own tab and
  // handed straight to the keychain. A phone is refused, as with app tokens.
  const kept = [];
  const rsess = room(service, { connectWith: async (how) => { kept.push(how); return how.token === 'xoxc-ok' ? { ok: true, who: { user: 'niko' } } : { ok: false, message: 'Slack did not accept that session: nope' }; } }).r;
  const phone = seat(rsess, 'p', { control: true });
  phone.length = 0;
  await rsess.handle('p', { type: 'slack:signIn', token: 'xoxc-ok', cookie: 'xoxd-a' });
  check('a phone may not sign in with a session', kept.length === 0 && phone.some((m) => m.type === 'slack:signedIn' && m.ok === false && /laptop/.test(m.message)));
  const lap = seat(rsess, 'l', { local: true, device: null });
  lap.length = 0;
  await rsess.handle('l', { type: 'slack:signIn', token: 'xoxc-ok', cookie: 'xoxd-a' });
  check('the laptop signs in, and the values reach the keychain path', kept.length === 1 && kept[0].token === 'xoxc-ok' &&
    lap.some((m) => m.type === 'slack:signedIn' && m.ok === true && m.who.user === 'niko'));
  lap.length = 0;
  await rsess.handle('l', { type: 'slack:signIn', token: 'xoxc-bad', cookie: 'xoxd-a' });
  check('a session Slack rejects is said in words, not kept', lap.some((m) => m.type === 'slack:signedIn' && m.ok === false && /did not accept/.test(m.message)));

  editor.length = 0; watcher.length = 0;
  r.focus('D1');
  check('a popup is for the editor', editor.some((m) => m.type === 'slack:focus' && m.conversation === 'D1'));
  check('not for phones, which get a notification', !watcher.some((m) => m.type === 'slack:focus'));

  r.leave('w');
  watcher.length = 0;
  r.broadcast();
  check('a window that left hears nothing more', watcher.length === 0 && editor.some((m) => m.type === 'slack:state'));

  const off = room(null).r;
  const nobody = seat(off, 'n', { control: true });
  await off.handle('n', { type: 'slack:ready' });
  check('with Slack off the state still says what to do', nobody[0].state.socket === 'off' && Array.isArray(nobody[0].state.conversations));
  await off.handle('n', { type: 'slack:reply', id: 'z', conversation: 'D1', text: 'x' });
  check('and a reply says it is not connected', nobody.some((m) => m.id === 'z' && /not connected/.test(m.reason)));
  nobody.length = 0;
  await off.handle('n', { type: 'slack:setup' });
  check('a phone is handed the setup page to open itself', nobody.some((m) => m.type === 'slack:link' && m.url === SETUP_URL));
};
