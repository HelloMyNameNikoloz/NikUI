'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createSecItemAdapter, createKeychainStore, encodeFrame, decodeFrame, MAX_FRAME } = require('../src/keychainStore');
const { memoryKeychain, keypair, pins } = require('./helpers/keychain');
const { loadIdentity } = require('../src/identity');
const { createSelectedDelivery } = require('../src/daemonDelivery');
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
module.exports = async () => {
  suite('P2 T41: Keychain store retains the get/update/SecretStorage contract');
  const adapter = memoryKeychain(), initial = { 'nikui.identity': keypair(), 'nikui.vapid': keypair() };
  const selection = pins(initial); initial['nikd.selection'] = selection;
  const store = createKeychainStore({ adapter, create: true, initial });
  let events = 0; const sub = store.onDidChange(() => events++);
  check('selected identity and VAPID load exactly without regeneration', pins(Object.fromEntries(store.keys().map((k) => [k, store.get(k)]))).fingerprint === selection.fingerprint);
  await store.store('nikui.slack.userToken', 'synthetic-ქართული\n"\\\u0000👋');
  check('arbitrary UTF-8 secrets roundtrip without normalization', store.get('nikui.slack.userToken') === 'synthetic-ქართული\n"\\\u0000👋');
  const value = store.get('nikui.identity'); value.privateKey = 'mutated-copy';
  check('get returns a defensive copy', store.get('nikui.identity').privateKey !== 'mutated-copy');
  await store.delete('nikui.slack.userToken');
  checkEqual('delete and persisted change events use the same interface', [store.get('nikui.slack.userToken', null), events], [null, 2]);
  sub.dispose(); store.update('new', 1); checkEqual('disposed subscription observes no later changes', events, 2);
  const bytes = Buffer.from(adapter.values.get('store.v1'));
  for (const failure of ['KEYCHAIN_LOCKED', 'KEYCHAIN_DENIED', 'KEYCHAIN_CORRUPT']) {
    adapter.fail(failure);
    checkEqual(failure + ' get fails instead of returning cached values', await code(() => store.get('new')), failure);
    checkEqual(failure + ' update fails without deleting existing bytes', await code(() => store.update('new', 2)), failure);
    check(failure + ' cannot replace/regenerate the selected identity', adapter.values.get('store.v1').equals(bytes));
  }
  adapter.fail(null);
  adapter.values.set('store.v1', Buffer.from('{corrupt'));
  checkEqual('corrupt stored JSON refuses construction', await code(() => createKeychainStore({ adapter })), 'KEYCHAIN_CORRUPT');
  checkEqual('corrupt live store refuses writes without repair', await code(() => store.update('new', 2)), 'KEYCHAIN_CORRUPT');
  adapter.values.set('store.v1', bytes);
  checkEqual('add is nondestructive and never becomes upsert', await code(() => createKeychainStore({ adapter, create: true, initial: {} })), 'KEYCHAIN_DUPLICATE');
  check('failed duplicate add preserved the original bytes', adapter.values.get('store.v1').equals(bytes));
  store.dispose(); checkEqual('disposed stores refuse reads', await code(() => store.get('new')), 'KEYCHAIN_CLOSED');
  const missing = memoryKeychain();
  checkEqual('opening a missing selected store never bootstraps it', [await code(() => createKeychainStore({ adapter: missing })), missing.values.size], ['KEYCHAIN_NOT_FOUND', 0]);

  suite('P2 T41: secret changes dispose the old delivery graph');
  const changing = memoryKeychain(), changedStore = createKeychainStore({ adapter: changing, create: true, initial });
  let stops = 0;
  const delivery = createSelectedDelivery({ selection: { ...selection, store: changedStore, onDidChange: (fn) => changedStore.onDidChange(fn) },
    settings: { get: (_k, fallback) => fallback }, send: async () => ({}), sendApple: async () => ({}) });
  delivery.connect({ listening: true, notifyDevices: () => 0, stop() { stops++; } }); delivery.start();
  changedStore.update('nikui.slack.userToken', 'changed');
  checkEqual('a secret change closes selected listeners before reuse', [delivery.available, stops], [false, 1]);
  changedStore.dispose();

  suite('P2 T66: framed helper process adapter never puts secrets in argv/env/log errors');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nik-keychain-adapter-'));
  const helper = path.join(root, 'fixture-helper'); fs.writeFileSync(helper, '', {mode:0o700});
  const service = 'com.nikui.engine.test.' + crypto.randomBytes(16).toString('hex'), backend = 'login-file-keychain';
  const secret = Buffer.from('synthetic-private-ქართული\n"\\\u0000👋');
  const calls = [];
  const success = (request, extra = {}) => ({ status: 0, signal: null, stderr: Buffer.alloc(0),
    stdout: encodeFrame({ version:1, id:request.id, ok:true, service, backend, ...extra }) });
  let response = (request) => success(request, {found:false});
  const run = (file, argv, opts) => { const request=decodeFrame(opts.input); calls.push({file,argv,env:opts.env,inputOnly:request.data===secret.toString('base64')}); return response(request); };
  try {
    const a = createSecItemAdapter({ helper, service, backend, home:root, run });
    checkEqual('a newline cannot extend a signed service name',await code(()=>createSecItemAdapter({helper,service:service+'\n',home:root,run})),'KEYCHAIN_NAMESPACE');
    checkEqual('a newline cannot extend a Keychain account',await code(()=>a.read('raw\n')),'BAD_STORE_KEY');
    a.add('raw', secret);
    check('secret travels only in framed input', calls[0].inputOnly && calls[0].argv.length === 0 && !JSON.stringify(calls[0].env).includes(secret.toString()));
    checkEqual('helper environment is explicit and contains no inherited credentials', Object.keys(calls[0].env).sort(), ['HOME','LANG','PATH']);
    response=(r)=>success(r,{found:true,accessible:'AfterFirstUnlockThisDeviceOnly',accessibilityReported:true,data:secret.toString('base64')});
    check('framed arbitrary bytes are returned exactly', a.read('raw').equals(secret));
    response=(r)=>success(r,{found:true,accessible:'not-reported-by-file-keychain',accessibilityReported:false,data:secret.toString('base64')});
    check('file-Keychain omitted accessibility is reported without claiming a protection class', a.read('raw').equals(secret)&&a.metadata().accessibilityReported===false);
    for (const failure of ['KEYCHAIN_LOCKED','KEYCHAIN_DENIED','KEYCHAIN_CORRUPT']) {
      response=(r)=>({status:1,signal:null,stderr:Buffer.from(secret),stdout:encodeFrame({version:1,id:r.id,ok:false,error:{code:failure,status:-1,message:secret.toString()}})});
      let error; try {a.update('raw',secret);}catch(e){error=e;}
      check(failure+' is observable without reflecting stdout/stderr/secret text', error?.code===failure&&!error.message.includes(secret.toString()));
    }
    const bad = [
      ['truncated frame',(r)=>({...success(r),stdout:Buffer.from([0,0,0,10,123])})],
      ['trailing frame',(r)=>({...success(r),stdout:Buffer.concat([success(r).stdout,Buffer.from('junk')])})],
      ['wrong request ID',(r)=>success({...r,id:'0'.repeat(32)})],
      ['nonzero success',(r)=>({...success(r),status:1})],
      ['zero-exit failure',(r)=>({status:0,stderr:Buffer.alloc(0),stdout:encodeFrame({version:1,id:r.id,ok:false,error:{code:'KEYCHAIN_LOCKED'}})})],
      ['unexpected stderr',(r)=>({...success(r),stderr:secret})],
      ['wrong backend',(r)=>({...success(r),stdout:encodeFrame({version:1,id:r.id,ok:true,service,backend:'foreign'})})],
      ['wrong service',(r)=>({...success(r),stdout:encodeFrame({version:1,id:r.id,ok:true,service:'com.nikui.engine.test.foreign'})})]
    ];
    for(const [name,f] of bad){response=f;checkEqual(name+' refuses',await code(()=>a.read('raw')),'KEYCHAIN_BAD_FRAME');}
    response=()=>({status:null,signal:'SIGKILL',stderr:Buffer.alloc(0),stdout:Buffer.alloc(0)});
    checkEqual('killed helper refuses without fallback',await code(()=>a.read('raw')),'KEYCHAIN_UNAVAILABLE');
    const tooLong=Buffer.alloc(4);tooLong.writeUInt32BE(MAX_FRAME+1);
    checkEqual('overlong declared frame refuses before parsing',await code(()=>decodeFrame(tooLong)),'KEYCHAIN_BAD_FRAME');
  }finally{fs.rmSync(root,{recursive:true,force:true});}

  require('./helpers/headless').headlessChecks(path.join(__dirname,'fixtures/engine/secrets.js'), {privateListener:true,controlListener:true});

  // Codex owns the complete non-native suite. Claude explicitly opts into
  // SecItem/SMAppService outside the managed sandbox; an unrun native gate is
  // reported separately, never counted as a passing non-native assertion.
  if(process.env.NIKUI_NATIVE_TESTS!=='1'&&!process.env.NIKUI_SIGNED_TEST_ROOT){process.stderr.write('native: pending Claude run (Keychain)\n');return;}
  if(process.platform!=='darwin'||process.arch!=='arm64'){process.stderr.write('native: requires arm64 macOS\n');return;}
  suite('P2 T66: actual development-signed helper; dedicated random test service only');
  const buildRoot=fs.mkdtempSync(path.join(os.tmpdir(),'nik-keychain-real-'));
  const created=new Set();let real;
  try{
    const {buildKeychainHelper}=require('../scripts/build-keychain-helper');
    const build=buildKeychainHelper({output:path.join(buildRoot,'NikKeychain.app')});
    const service=build.servicePrefix+crypto.randomBytes(16).toString('hex');
    real=createSecItemAdapter({...build,helper:build.executable,service,home:buildRoot});
    const target=require('child_process').execFileSync('/usr/bin/otool',['-l',build.executable],{encoding:'utf8'});
    check('helper binary and plist declare macOS 14.0',/minos 14\.0/.test(target)&&fs.readFileSync(path.join(buildRoot,'NikKeychain.app/Contents/Info.plist'),'utf8').includes('<string>14.0</string>'));
    const malformed=spawnSync(build.executable,[],{input:Buffer.from([0,0,0,20,123])});
    check('actual helper frames malformed-input errors and exits nonzero',malformed.status!==0&&decodeFrame(malformed.stdout).error.code==='KEYCHAIN_BAD_FRAME'&&malformed.stderr.length===0);
    const r=spawnSync(build.executable,['forbidden-argument'],{input:Buffer.alloc(0)});
    check('actual helper refuses argv and never logs input',r.status!==0&&decodeFrame(r.stdout).error.code==='KEYCHAIN_BAD_FRAME'&&r.stderr.length===0);
    const valid={version:1,id:'a'.repeat(32),op:'read',service,account:'probe'};
    for(const [name,request,expected]of [
      ['foreign signed prefix',{...valid,service:'com.nikui.engine.dev.'+'a'.repeat(32)},'KEYCHAIN_NAMESPACE'],
      ['service newline',{...valid,service:service+'\n'},'KEYCHAIN_NAMESPACE'],
      ['account newline',{...valid,account:'probe\n'},'KEYCHAIN_BAD_REQUEST'],
      ['request ID newline',{...valid,id:valid.id+'\n'},'KEYCHAIN_BAD_FRAME'],
      ['noncanonical bytes',{...valid,op:'add',data:'YQ'},'KEYCHAIN_BAD_REQUEST'],
      ['extra caller-chosen access group',{...valid,accessGroup:'foreign'},'KEYCHAIN_BAD_REQUEST']
    ]){
      const result=spawnSync(build.executable,[],{input:encodeFrame(request)});
      check('actual helper refuses '+name+' before accessing any item',result.status===1&&decodeFrame(result.stdout).error?.code===expected&&result.stderr.length===0);
    }
    check('actual signed helper has the expected stable designated requirement',require('../src/keychainProbe').requirement(build.executable).includes('identifier "com.nikui.engine.test.keychain"'));
    if(process.env.NIKUI_SIGNED_TEST_ROOT){
      // Explicitly select the final signed service when running inside the
      // workspace sandbox. Native SecItem work belongs to its signed helper.
      const paths=require('../src/daemonPaths').privateRoot(process.env.NIKUI_SIGNED_TEST_ROOT,{create:false});
      if(!paths.root.startsWith('/private/tmp/nik-mac/build/'))throw new Error('Only the private built TEST profile can host the real helper gate');
      const {controlRequest}=require('../src/daemonControl');
      const status=await controlRequest(paths,{op:'status'});
      if(status.package?.label!=='com.nikui.engine.dev'||status.package.testOnly!==true)throw new Error('The selected endpoint is not the signed TEST engine');
      const report=await controlRequest(paths,{op:'package-keychain-selftest'},{timeoutMs:30000});
      check('real signed-package SecItem gate passed with a fresh isolated service',report.ok===true&&report.backend==='login-file-keychain'&&/^com\.nikui\.engine\.test\.[a-f0-9]{32}$/.test(report.service));
      for(const name of ['initiallyMissing','add','accessibility','readArbitraryBytes','nondestructiveDuplicate','rebuildRequirement','rebuiltBytesDiffer','rebuiltHelperReadsExisting','update','missingUpdate','emptyBytes','deleteAndMissing','isolatedNamespace']){
        check('real signed-package '+name,report.checks?.[name]===true);
      }
      check('real signed-package test cleaned all accounts in finally',report.cleanup===true);
      return;
    }
    {
      created.add('probe');real.add('probe',secret);
      const accepted=real.metadata();
      check('D28 login-Keychain write accepts a requested accessibility without provisioning',accepted.backend==='login-file-keychain'&&['AfterFirstUnlockThisDeviceOnly','AfterFirstUnlock'].includes(accepted.accessible));
      check('real SecItem add/read preserves arbitrary UTF-8 bytes',real.read('probe').equals(secret));
      const {requirement}=require('../src/keychainProbe');
      fs.mkdirSync(path.join(buildRoot,'upgrade'),{mode:0o700});
      const upgraded=buildKeychainHelper({output:path.join(buildRoot,'upgrade','NikKeychain.app'),version:'2'});
      const next=createSecItemAdapter({...upgraded,helper:upgraded.executable,service,home:buildRoot});
      check('same signing identity and bundle identifier preserve the designated requirement across rebuild',!!requirement(build.executable)&&requirement(build.executable)===requirement(upgraded.executable));
      check('rebuilt helper reads the item created by the earlier signed helper',next.read('probe').equals(secret));
      real=next;
      checkEqual('real duplicate add exits nonzero without replacement',await code(()=>real.add('probe',Buffer.from('replacement'))),'KEYCHAIN_DUPLICATE');
      check('real failed add retained the existing bytes',real.read('probe').equals(secret));
      real.update('probe',Buffer.from('updated\nქართული\u0000'));
      check('real update is nondestructive and readable',real.read('probe').equals(Buffer.from('updated\nქართული\u0000')));
      checkEqual('real update cannot create a missing item',await code(()=>real.update('missing',secret)),'KEYCHAIN_NOT_FOUND');
      created.add('raw-empty');real.add('raw-empty',Buffer.alloc(0));checkEqual('real empty bytes roundtrip',real.read('raw-empty').length,0);
      check('real delete reports existing item',real.delete('raw-empty')===true);
      check('real read/delete missing are explicit and idempotent',real.read('raw-empty')===null&&real.delete('raw-empty')===false);
      checkEqual('helper refuses a service outside the signed prefix',await code(()=>createSecItemAdapter({...build,helper:build.executable,service:'com.nikui.engine.dev.'+crypto.randomBytes(16).toString('hex'),home:buildRoot}).read('probe')),'KEYCHAIN_NAMESPACE');
    }
  }finally{
    const failures=[];
    if(real)for(const account of created){
      try{real.delete(account);const missing=real.read(account)===null;check('dedicated test account removed in finally: '+account,missing);if(!missing)failures.push(account);}
      catch(_){failures.push(account);}
    }
    fs.rmSync(buildRoot,{recursive:true,force:true});
    if(failures.length)throw Object.assign(new Error('Dedicated test Keychain cleanup failed'),{code:'KEYCHAIN_TEST_CLEANUP_FAILED',service:real.service,accounts:failures});
  }
};
