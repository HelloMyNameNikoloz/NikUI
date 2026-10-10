/* Talking instead of typing, heard by the laptop.

   The phone only records. The words are worked out on the laptop, by the model
   VoiceInk already keeps there, because a phone has neither the memory nor the
   time to do it as well. What comes back goes into the composer where the
   cursor was and is not sent: speech recognition gets names and code wrong, and
   the person who said it is the one to read it first — unless they pressed send
   while talking, which says they would rather not: the recording stops, and
   what comes back goes with whatever was already typed, without a second tap.

   Nothing listens until the button is pressed, and the microphone is let go
   the moment it is pressed again. The recording lives in this page and nowhere
   else; if the laptop cannot take it yet it is kept here, to be sent again.

   On the wire: 16 kHz mono 16-bit WAV, which is what the model wants, base64 in
   one message on the socket the conversation already holds. */
(function () {
  'use strict';

  const app = window.NikApp;
  if (!app) return;

  const MAX_SECONDS = 300;          // the laptop refuses longer, and so does this
  const SHORTEST = 0.3;             // a tap, not something said
  const RATE = 16000;

  const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" x2="12" y1="18" y2="22"/></svg>';
  const SQUARE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';

  const $ = (id) => document.getElementById(id);
  const link = () => window.nikLink || null;
  const online = () => { const l = link(); return !!(l && l.__state && l.__state() === 'online'); };
  const send = (message) => { const l = link(); if (l) l.postMessage(message); };

  const state = {
    offered: null,      // what the laptop last said about voice, or null for nothing yet
    phase: 'idle',      // idle | recording | sending | held | notice
    take: null,         // the recording being made: { stream, context, ... }
    kept: null,         // a finished recording not yet turned into words: { id, audio, seconds }
    said: '',           // what the bar says when held or noticing
    retry: 'Try again',
    waitBuild: null,    // asking again while the laptop builds the transcriber
    sendAfter: false,   // send pressed while talking: send the words once they are back
    deadline: null
  };

  let button = null;
  let bar = null;

  function start() {
    const actions = document.querySelector('.composer-actions');
    const composer = document.querySelector('.composer');
    if (!actions || !composer || !$('input')) return;

    button = document.createElement('button');
    button.id = 'mic';
    button.className = 'icon-only';
    button.type = 'button';
    button.hidden = true;
    button.innerHTML = MIC;
    button.setAttribute('aria-label', 'Talk');
    button.title = 'Talk — your laptop writes it down';
    actions.insertBefore(button, $('stop') || $('send'));
    button.addEventListener('click', press);
    // Send, while talking, is "stop and send it". Caught on the way down so
    // the client's own send never sees a tap that is not for it.
    actions.addEventListener('click', sendWhileTalking, true);

    bar = document.createElement('div');
    bar.className = 'voice';
    bar.id = 'voice';
    bar.hidden = true;
    bar.setAttribute('role', 'status');
    composer.parentNode.insertBefore(bar, composer);
    bar.addEventListener('click', (event) => {
      const act = event.target.closest('[data-voice]');
      if (act) act.dataset.voice === 'cancel' ? cancel() : act.dataset.voice === 'send' ? resend() : discard();
    });

    window.addEventListener('message', hear);
    // Leaving the app is the end of a recording, never a reason to keep a
    // microphone open behind somebody's back.
    document.addEventListener('visibilitychange', () => { if (document.hidden && state.phase === 'recording') finish('paused'); });
    window.addEventListener('pagehide', () => { if (state.phase === 'recording') drop(); });

    if (online()) ask();
    draw();
  }

  function ask() { send({ type: 'voice:state' }); }

  function hear(event) {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    // The conversation arriving is the surest sign the socket is seated: a
    // welcome can come and go before this script has started listening.
    if (message.type === 'init') { ask(); return; }
    if (message.type === '@welcome' || message.type === '@device') {
      // Whether this device may is the laptop's to say, and it says it here.
      if (message.device && message.device.control === false) state.offered = null;
      ask();
      return draw();
    }
    if (message.type === 'voice:state') {
      state.offered = message;
      // A recording waiting for the laptop's first build goes as soon as it can.
      if (state.waitBuild && message.available && !message.building && !message.needsBuild) {
        stopWaiting();
        resend();
      }
      return draw();
    }
    if (!state.kept || message.id !== state.kept.id) return;
    if (message.type === 'voice:text') return heard(message.text);
    if (message.type === 'voice:no') return refused(message);
  }

  // ---- what is on screen --------------------------------------------------------

  /** Shown when it could be used, or when it could and something is in the way. */
  function shown() {
    const o = state.offered;
    if (state.phase !== 'idle') return true;
    if (!o) return false;
    return !!o.available || o.code === 'NO_MODEL' || o.code === 'BROKEN';
  }

  const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  function draw() {
    if (!button) return;
    button.hidden = !shown();
    const recording = state.phase === 'recording';
    button.classList.toggle('on', recording);
    button.innerHTML = recording ? SQUARE : MIC;
    button.setAttribute('aria-label', recording ? 'Stop and write it down' : 'Talk');
    button.disabled = state.phase === 'sending';
    const go = $('send');
    if (go) go.classList.toggle('voice-live', state.phase === 'recording' || state.phase === 'sending');

    bar.hidden = state.phase === 'idle';
    bar.className = 'voice voice-' + state.phase;
    if (state.phase === 'recording') {
      bar.innerHTML = '<span class="voice-dot"></span><span class="voice-clock">0:00</span>' +
        '<span class="voice-level">' + '<i></i>'.repeat(7) + '</span>' +
        '<button type="button" class="voice-act" data-voice="cancel">Cancel</button>';
      tick();
    } else if (state.phase === 'sending') {
      bar.innerHTML = '<span class="voice-spin"></span><span class="voice-said">Writing it down on your laptop…</span>' +
        '<button type="button" class="voice-act" data-voice="cancel">Cancel</button>';
    } else if (state.phase === 'held') {
      bar.innerHTML = '<span class="voice-said"></span>' +
        (state.waitBuild ? '' : '<button type="button" class="voice-act voice-go" data-voice="send"></button>') +
        '<button type="button" class="voice-act" data-voice="discard">Discard</button>';
      bar.querySelector('.voice-said').textContent = state.said;
      const again = bar.querySelector('[data-voice="send"]');
      if (again) again.textContent = state.retry;
    } else if (state.phase === 'notice') {
      bar.innerHTML = '<span class="voice-said"></span><button type="button" class="voice-act" data-voice="discard">OK</button>';
      bar.querySelector('.voice-said').textContent = state.said;
    } else {
      bar.innerHTML = '';
    }
  }

  /** The clock and the meter, while recording. */
  function tick() {
    const take = state.take;
    if (!take || state.phase !== 'recording' || !bar) return;
    const seconds = take.frames / take.rate;
    const face = bar.querySelector('.voice-clock');
    if (face) face.textContent = clock(seconds) + (seconds > MAX_SECONDS - 30 ? ' / 5:00' : '');
    const bars = bar.querySelectorAll('.voice-level i');
    take.levels.push(Math.min(1, take.level * 4));
    while (take.levels.length > bars.length) take.levels.shift();
    bars.forEach((b, i) => { b.style.transform = 'scaleY(' + Math.max(0.12, take.levels[i] || 0).toFixed(2) + ')'; });
  }

  function notice(words) {
    state.sendAfter = false;
    state.phase = 'notice';
    state.said = words;
    draw();
  }

  function hold(words, retry) {
    state.phase = 'held';
    state.said = words;
    state.retry = retry || 'Try again';
    clearTimeout(state.deadline);
    draw();
  }

  function buzz() {
    const plugins = app.native();
    if (plugins && plugins.Haptics) {
      const call = plugins.Haptics.impact({ style: 'LIGHT' });
      if (call && call.catch) call.catch(() => {});
    }
  }

  // ---- recording ---------------------------------------------------------------

  function sendWhileTalking(event) {
    if (!event.target.closest('#send')) return;
    if (state.phase !== 'recording' && state.phase !== 'sending') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    state.sendAfter = true;
    if (state.phase === 'recording') finish('send');
  }

  function press() {
    if (state.phase === 'recording') return finish('send');
    if (state.phase === 'sending') return;
    const o = state.offered;
    if (o && !o.available) return notice(o.reason || 'Voice is not available on the laptop.');
    if (state.kept) {
      // Something said earlier is still waiting; pressing the mic again is
      // choosing to say it over.
      stopWaiting();
      state.kept = null;
    }
    begin();
  }

  async function begin() {
    const media = navigator.mediaDevices;
    if (!media || !media.getUserMedia) return notice('This phone cannot record here.');
    state.phase = 'recording';
    state.take = { frames: 0, rate: RATE, level: 0, levels: [], chunks: [], starting: true };
    draw();
    const take = state.take;
    let stream;
    try {
      stream = await media.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (err) {
      state.take = null;
      return notice(err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
        ? 'NikUI may not use the microphone. Allow it for NikUI in the phone’s settings, then try again.'
        : 'The microphone could not be opened' + (err && err.message ? ': ' + err.message : '.'));
    }
    // Cancelled while the phone was still asking for permission.
    if (state.take !== take) { stream.getTracks().forEach((t) => t.stop()); return; }

    const Context = window.AudioContext || window.webkitAudioContext;
    let context;
    try { context = new Context({ sampleRate: RATE }); } catch (_) { context = new Context(); }
    try { await context.resume(); } catch (_) { /* running already */ }
    const source = context.createMediaStreamSource(stream);
    // Small, so stopping loses next to nothing and the meter keeps up.
    const node = context.createScriptProcessor(1024, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    node.onaudioprocess = (event) => {
      if (state.take !== take) return;
      const data = event.inputBuffer.getChannelData(0);
      take.chunks.push(new Float32Array(data));
      take.frames += data.length;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      take.level = Math.sqrt(sum / (data.length / 4));
      if (take.frames / take.rate >= MAX_SECONDS) finish('send');
    };
    source.connect(node);
    node.connect(silent);
    silent.connect(context.destination);
    Object.assign(take, { stream, context, source, node, rate: context.sampleRate, starting: false });
    take.timer = setInterval(tick, 120);
    buzz();
  }

  /** Let go of the microphone. Always, whatever happens next. */
  function release(take) {
    if (!take) return;
    clearInterval(take.timer);
    try { if (take.node) { take.node.onaudioprocess = null; take.node.disconnect(); } } catch (_) { /* gone */ }
    try { if (take.source) take.source.disconnect(); } catch (_) { /* gone */ }
    if (take.stream) take.stream.getTracks().forEach((t) => t.stop());
    if (take.context && take.context.state !== 'closed') take.context.close().catch(() => {});
  }

  function drop() {
    const take = state.take;
    state.take = null;
    release(take);
  }

  /** Stop recording: send it, or keep it to send when somebody says so. */
  function finish(then) {
    const take = state.take;
    if (!take || take.ending) return;
    buzz();
    if (take.starting) { drop(); state.sendAfter = false; state.phase = 'idle'; return draw(); }
    take.ending = true;
    if (then === 'paused') return finished(take, then);
    state.phase = 'sending';
    draw();
    // The last moment of sound is still on its way through Web Audio when the
    // button is pressed; cutting it off is cutting off the last word.
    setTimeout(() => { if (state.take === take) finished(take, then); }, 250);
  }

  function finished(take, then) {
    state.take = null;
    release(take);
    const seconds = take.frames / take.rate;
    if (seconds < SHORTEST) return notice('That was too short to hear anything. Hold on a moment longer.');
    state.kept = { id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      audio: encode(take.chunks, take.rate), seconds };
    if (then === 'paused') return hold('Recording stopped when NikUI was left (' + clock(seconds) + ').', 'Send');
    resend();
  }

  function cancel() {
    if (state.take) { drop(); buzz(); }
    stopWaiting();
    clearTimeout(state.deadline);
    state.kept = null;
    state.sendAfter = false;
    state.phase = 'idle';
    draw();
  }

  function discard() { cancel(); }

  // ---- to the laptop and back -------------------------------------------------------

  function resend() {
    const kept = state.kept;
    if (!kept) return cancel();
    if (!online()) return hold('Not connected to your laptop. The recording is kept.', 'Send');
    state.phase = 'sending';
    draw();
    send({ type: 'voice', id: kept.id, audio: kept.audio });
    // The laptop answers or says why; a socket that drops in between does
    // neither, so silence has a limit too.
    clearTimeout(state.deadline);
    state.deadline = setTimeout(() => {
      if (state.phase === 'sending' && state.kept === kept) hold('Your laptop did not answer. The recording is kept.');
    }, 120000 + kept.seconds * 1000);
  }

  function heard(text) {
    clearTimeout(state.deadline);
    state.kept = null;
    const words = String(text || '').trim();
    const then = state.sendAfter;
    state.sendAfter = false;
    if (!words) return notice('Nothing was heard in that recording.');
    put(words);
    state.phase = 'idle';
    draw();
    if (then && $('send')) $('send').click();
  }

  function refused(message) {
    clearTimeout(state.deadline);
    if (message.code === 'BUILDING') {
      hold('Your laptop is setting up voice for the first time, which takes a few minutes. ' +
        'This recording will be sent as soon as it is ready.');
      waitForBuild();
      return;
    }
    if (['OFF', 'WATCH_ONLY', 'UNSUPPORTED'].includes(message.code)) {
      state.offered = { available: false, code: message.code, reason: message.reason };
    }
    hold(message.reason || 'Your laptop could not write that down.');
  }

  function waitForBuild() {
    stopWaiting();
    state.waitBuild = setInterval(() => { if (online()) ask(); }, 15000);
    draw();
  }

  function stopWaiting() {
    if (state.waitBuild) clearInterval(state.waitBuild);
    state.waitBuild = null;
  }

  /** Into the composer where the cursor was, with a space either side if needed. Never sent. */
  function put(words) {
    const input = $('input');
    if (!input) return;
    const value = input.value;
    const from = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
    const to = typeof input.selectionEnd === 'number' ? input.selectionEnd : from;
    const before = value.slice(0, from);
    const after = value.slice(to);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const tail = after && !/^\s/.test(after) ? ' ' : '';
    input.value = before + lead + words + tail + after;
    const at = (before + lead + words).length;
    try { input.setSelectionRange(at, at); } catch (_) { /* not focusable yet */ }
    // The client sizes the field, keeps the draft and lights the send button on input.
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ---- the file ------------------------------------------------------------------

  /** Float samples at whatever rate the phone gave, as a 16 kHz 16-bit mono WAV in base64. */
  function encode(chunks, rate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const all = new Float32Array(total);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }

    // Most phones honour the 16 kHz asked for. One that does not is averaged
    // down: every output sample is the mean of the input it covers.
    const step = rate / RATE;
    const count = Math.min(Math.floor(total / step), MAX_SECONDS * RATE);
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      let value;
      if (step === 1) value = all[i];
      else {
        const a = Math.floor(i * step);
        const b = Math.max(a + 1, Math.floor((i + 1) * step));
        let sum = 0;
        for (let j = a; j < b && j < total; j++) sum += all[j];
        value = sum / (b - a);
      }
      const v = Math.max(-1, Math.min(1, value));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    const bytes = new Uint8Array(44 + pcm.length * 2);
    const view = new DataView(bytes.buffer);
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i); };
    text(0, 'RIFF');
    view.setUint32(4, 36 + pcm.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, pcm.length * 2, true);
    new Int16Array(bytes.buffer, 44).set(pcm);

    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // For the checks: what this screen is doing, without reaching into it.
  window.__voice = () => ({ phase: state.phase, kept: !!state.kept, offered: state.offered,
    waiting: !!state.waitBuild, said: state.said, seconds: state.kept ? state.kept.seconds : 0 });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
