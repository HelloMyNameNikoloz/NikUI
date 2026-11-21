'use strict';

const crypto = require('crypto');

const LISTENER_PING_MS = 30000;
const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/** Notification-only SSE; HTTP Host/Origin/rate guards remain with the server. */
class NotificationStream {
  constructor({ devices, timers = { setInterval, clearInterval }, log = () => {} } = {}) {
    this.devices = devices;
    this.timers = timers;
    this.log = log;
    this.listeners = new Set();
    this.disposed = false;
  }

  issue(client) {
    const device = client && client.device;
    if (this.disposed || !this.devices || !device || device.kind !== 'device') return false;
    const secret = crypto.randomBytes(32).toString('base64url');
    if (!this.devices.setListener(device.id, sha256(secret))) return false;
    client.post({ type: '@listener', secret });
    this.log(`${device.name} can be told things while NikUI is closed`);
    return true;
  }

  authenticate(req) {
    if (this.disposed) return null;
    const offered = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(String(req.headers.authorization || ''));
    return offered && this.devices ? this.devices.byListener(sha256(offered[1])) : null;
  }

  open(req, res, device) {
    if (this.disposed || !device) return false;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    });
    if (req.socket) { req.socket.setTimeout(0); req.socket.setKeepAlive(true, LISTENER_PING_MS); }
    res.write(': listening\n\n');
    const listener = { device: device.id, hash: device.listener.hash, res, timer: null };
    const gone = () => {
      this.timers.clearInterval(listener.timer);
      this.listeners.delete(listener);
      req.removeListener('close', gone);
      res.removeListener('close', gone);
    };
    listener.close = () => { gone(); try { res.end(); } catch (_) { /* already gone */ } };
    listener.timer = this.timers.setInterval(() => this.write(listener, ': ping\n\n'), LISTENER_PING_MS);
    if (listener.timer && listener.timer.unref) listener.timer.unref();
    this.listeners.add(listener);
    req.on('close', gone);
    res.on('close', gone);
    this.log(`${device.name} is listening in the background`);
    return true;
  }

  write(listener, text) {
    const device = this.devices && this.devices.get(listener.device);
    if (this.disposed || !device || !device.listener || device.listener.hash !== listener.hash) {
      listener.close();
      return false;
    }
    try { listener.res.write(text); return true; } catch (_) { return false; }
  }

  notify(message) {
    const event = 'event: notify\ndata: ' + JSON.stringify(Object.assign({ type: '@notify' }, message)) + '\n\n';
    let told = 0;
    for (const listener of [...this.listeners]) {
      if (message && message.to && listener.device !== message.to) continue;
      if (this.write(listener, event)) told++;
    }
    return told;
  }

  stop() { for (const listener of [...this.listeners]) listener.close(); }
  dispose() { if (!this.disposed) { this.disposed = true; this.stop(); } }
}

module.exports = { NotificationStream, LISTENER_PING_MS };
