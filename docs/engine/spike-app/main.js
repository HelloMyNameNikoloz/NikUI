const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const dir = path.join(os.homedir(), 'Library/Application Support/NikSpike'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const log = (s) => fs.appendFileSync(path.join(dir, 'engine.log'), new Date().toISOString() + ' ' + s + '\n');
log(`start pid=${process.pid} exec=${process.execPath} node=${process.version} PATH=${process.env.PATH} XPC=${process.env.XPC_SERVICE_NAME}`);
// JIT/wasm sanity under hardened runtime
log('wasm ok=' + (new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))) instanceof WebAssembly.Instance));
let sum = 0; for (let i = 0; i < 5e7; i++) sum += i; log('jit loop ok ' + sum);
const sock = path.join(dir, 'control.sock'); try { fs.unlinkSync(sock); } catch {}
net.createServer((c) => c.end(JSON.stringify({ pid: process.pid, uptime: process.uptime() }) + '\n')).listen(sock, () => { fs.chmodSync(sock, 0o600); log('listening ' + sock); });
process.on('SIGTERM', () => { log('SIGTERM: draining'); setTimeout(() => process.exit(0), 200); });
