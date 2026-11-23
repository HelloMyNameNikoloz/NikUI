'use strict';
const fs = require('fs'), path = require('path');
const { cutoverFixture, mkdir, errorCode } = require('../../helpers/engine-cutover');
const { memoryKeychain, keypair, pins } = require('../../helpers/keychain');
const { exportSelectedContext, buildSelectedTransfer, validateSelectedTransfer, createGenerationImporter } = require('../../../src/engineImport');
const { createSyntheticOwner, hash } = require('../../../src/engineOwner');
const { createKeychainStore } = require('../../../src/keychainStore');
const { createParticipantGate } = require('../../../src/engineTransfer');
const base = fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);
async function selected(dir, { fault = () => {}, count = 2, authority = null, completeAuthority = false, ownerFault, prepare = () => {} } = {}) {
  const f = await cutoverFixture(dir, { count, fault: ownerFault });
  f.secrets['nikui.identity'] = keypair(); f.secrets['nikui.vapid'] = keypair(); f.secrets['nikui.slack.userToken'] = 'synthetic-slack-private';
  const selection = pins(f.secrets), adapter = memoryKeychain();
  const deviceKey = keypair(), point = require('../../../src/push').rawPoint(require('crypto').createPublicKey({key:Buffer.from(deviceKey.publicKey,'base64url'),type:'spki',format:'der'}));
  const devices = [{ id:'paired-test-phone', name:'Test phone', publicKey:deviceKey.publicKey, fingerprint:require('../../../src/identity').fingerprintOf(Buffer.from(deviceKey.publicKey,'base64url')),
    pairedAt:1,lastSeenAt:2,lastAddress:null,control:true,protection:'software',biometric:false,
    listener:{hash:'a'.repeat(64),at:2},apns:{token:'c'.repeat(64),at:2},push:{endpoint:'https://push.invalid/test',keys:{p256dh:point.toString('base64url'),auth:Buffer.alloc(16,7).toString('base64url')},at:2}}];
  for (const source of f.sources) {
    source.context.globalState.update('nikui.devices', devices);
    source.engine.manager.list[0].queue[0].attachments[0].data = Buffer.from('full-image-ქართული').toString('base64');
    const exportState = () => exportSelectedContext({ context: source.context, engine: source.engine, selection, authority, completeAuthority,
      settings: { version: 1, user: { model: 'fixture-model', 'apns.keyFile': path.join(f.selected, 'provider-key.p8') }, projects: [{root:source.home,approved:true,values:{model:'fixture-project'},provenance:{profile:'test-profile',workspace:source.home,rawScope:'workspace'}}] }, provenance: { profile: 'test-profile', workspace: source.home, rawScope: 'workspace' },
      secrets: { get: (key) => f.secrets[key] }, keeper: { metaVersion: 1, runs: [] }, files: { durable: () => ({ version: 1, places: {} }) } });
    source.exportState = exportState;
  }
  prepare(f);
  let starts = 0, runtime;
  const options = { root: f.targetRoot, target: 'test-service', owner: f.owner, secretAdapter: adapter, testOnly: true, fault,
    activate(state, generation, member, store) { starts++; runtime = { state, generation, member, store }; } };
  const importer = createGenerationImporter(options);
  const t = await f.owner.begin({ generation: 0, to: 'service', target: 'test-service', inventory: f.inventory() });
  const sources = [];
  for (const source of f.sources) sources.push(await source.quiesce(t.token));
  const envelope = buildSelectedTransfer(t, sources, { selectedSource: sources[0].member.id });
  await f.owner.exported(t.token, envelope.hash);
  return { f, adapter, options, importer, envelope, t, sources, selection, get starts() { return starts; }, get runtime() { return runtime; },
    async close() { importer.dispose(); await f.close(); } };
}
async function commit(s) { const receipt = s.importer.import(s.envelope); await s.f.owner.imported(s.t.token, receipt); await s.importer.commit(s.t.token); return receipt; }
async function release(s) { await s.f.owner.started(s.t.token, { generation: 1, target: 'test-service', hash: s.envelope.hash, oldResourcesReleased: true }); await s.f.owner.release(s.t.token); }
module.exports = async () => {
  suite('P2 T41/T50/T51: selected keys, complete context APIs, inactive Keychain generation');
  const s = await selected(path.join(base, 'selected'));
  try {
    const receipt = s.importer.import(s.envelope);
    checkEqual('selected import stages all sources, exact queue counts and ledger maxima without activation', [receipt.sources, receipt.instances, receipt.queues, receipt.inactive, s.starts], [2, 2, 2, true, 0]);
    checkEqual('before commit recovery retains inactive state', s.importer.recover().action, 'remain-inactive');
    checkEqual('inactive import cannot start', await errorCode(() => s.importer.start(s.t.token)), 'STALE_GENERATION');
    check('selected delivery preserves exact grants, device IDs, push/APNs/listener records', hash(s.sources[0].state.global['nikui.devices']) === hash(s.sources[1].state.global['nikui.devices']));
    checkEqual('APNs reference is preserved without reading the provider key', [s.sources[0].state.settings.user['apns.keyFile'], fs.existsSync(s.sources[0].state.settings.user['apns.keyFile'])], [path.join(s.f.selected,'provider-key.p8'),false]);
    checkEqual('inactive import cannot mutate', await errorCode(() => s.importer.mutate(() => {})), 'IMPORT_INACTIVE');
    const before = s.adapter.values.size;
    checkEqual('identical import returns its original receipt', s.importer.import(s.envelope), receipt);
    checkEqual('identical import creates no new items', s.adapter.values.size, before);
    check('disk manifest contains no host/VAPID/Slack credentials', !fs.readFileSync(s.importer.file, 'utf8').includes(s.f.secrets['nikui.identity'].privateKey) &&
      !fs.readFileSync(s.importer.file, 'utf8').includes(s.f.secrets['nikui.vapid'].privateKey) && !fs.readFileSync(s.importer.file, 'utf8').includes('synthetic-slack-private'));
    await s.f.owner.imported(s.t.token, receipt);
    checkEqual('owner commit cannot bypass Keychain revalidation', await errorCode(() => s.f.owner.commit(s.t.token)), 'IMPORT_REVALIDATION_REQUIRED');
    s.adapter.fail('KEYCHAIN_LOCKED');
    checkEqual('Keychain lock immediately before commit retains the source generation', [await errorCode(() => s.importer.commit(s.t.token)), s.f.owner.status().generation], ['KEYCHAIN_LOCKED',0]);
    s.adapter.fail(null); await s.importer.commit(s.t.token);
    checkEqual('committed inactive generation is recoverable', s.importer.recover().action, 'recover-target');
    await s.importer.start(s.t.token); await release(s);
    checkEqual('one committed activation receives exact selected pins', [s.starts, s.runtime.generation, s.runtime.store.get('nikd.selection')], [1, 1, s.selection]);
    checkEqual('target receives complete queues and maxima without summing duplicate ledger copies', [s.runtime.state.queues[0].items[0].text.length,
      s.runtime.state.queues[0].items[0].attachments[0].data.length > 0, s.runtime.state.ledger.instances.shared.cost], [s.sources[0].state.queues[0].items[0].text.length, true, 4]);
    s.runtime.store.update('nikui.slack.userToken', 'post-cutover-private');
    s.importer.mutate((state) => { state.createdAfterCutover = 'current'; state.ledger.instances.new = { cost: 9, tokens: 25, turns: 1 }; });
    checkEqual('reimport does not overwrite current work or current credentials', [s.importer.import(s.envelope), s.importer.snapshot().records[0].state.createdAfterCutover,
      s.runtime.store.get('nikui.slack.userToken') === 'post-cutover-private'], [receipt, 'current', true]);
    await s.importer.start(s.t.token); checkEqual('repeated start never activates a second writer', s.starts, 1);
    checkEqual('committed generation cannot be discarded', await errorCode(() => s.importer.discard(s.t.token)), 'IMPORT_ACTIVE');
  } finally { await s.close(); }

  suite('P2 T50/T51: full payload/provenance/hash refusal before secret writes');
  const v = await selected(path.join(base, 'invalid'));
  try {
    const cases = [
      ['outer payload hash', (e) => { e.value.target = 'tampered'; }, 'IMPORT_HASH_MISMATCH', false],
      ['source provenance', (e) => { e.value.sources[0].state.provenance.profile = 'unselected'; }, 'EXPORT_PROVENANCE_INVALID'],
      ['source install', (e) => { e.value.sources[0].member.scope.install = 'other-install'; }, 'EXPORT_PROVENANCE_INVALID'],
      ['queue bytes', (e) => { e.value.sources[0].state.queues[0].items[0].text += 'tampered'; }, 'EXPORT_QUEUE_HASH'],
      ['duplicate queue instance', (e) => { e.value.sources[0].state.queues.push(e.value.sources[0].state.queues[0]); }, 'EXPORT_QUEUE_HASH'],
      ['file payload', (e) => { e.value.sources[0].state.files.durable.version = 2; }, 'EXPORT_FILE_HASH'],
      ['invalid device grant', (e) => { e.value.sources[0].state.global['nikui.devices'][0].control = 'yes'; }, 'EXPORT_DELIVERY_INVALID'],
      ['invalid listener hash', (e) => { e.value.sources[0].state.global['nikui.devices'][0].listener.hash = 'bad'; }, 'EXPORT_DELIVERY_INVALID'],
      ['missing secret inventory', (e) => { e.value.sources[0].state.inventory.secrets.pop(); }, 'EXPORT_INVENTORY_INCOMPLETE'],
      ['host/VAPID mismatch', (e) => { e.value.sources[0].state.secrets['nikui.vapid'] = keypair(); }, 'EXPORT_IDENTITY_INVALID'],
      ['wrong host pin', (e) => { e.value.sources[0].state.selection.fingerprint = 'wrong'; }, 'EXPORT_IDENTITY_INVALID'],
      ['invalid instance metadata', (e) => { e.value.sources[0].state.instances[0].customTitle = {}; }, 'EXPORT_INSTANCE_INVALID'],
      ['noncanonical private key', (e) => { e.value.sources[0].state.secrets['nikui.identity'].privateKey += '!'; }, 'EXPORT_IDENTITY_INVALID'],
      ['negative accounting', (e) => { e.value.sources[0].state.ledger.instances.shared.cost = -1; }, 'EXPORT_ACCOUNTING_INVALID'],
      ['unknown folder assignment', (e) => { e.value.sources[0].state.folders.assign.unknown = 'missing'; }, 'EXPORT_FOLDER_INVALID'],
      ['incomplete authority', (e) => { e.value.sources[0].state.completeAuthority = true; }, 'EXPORT_AUTHORITY_INCOMPLETE'],
      ['settings outside provenance', (e) => { e.value.sources[0].state.settings.projects = [{ root: '/unselected', approved: true, values: {}, provenance: {profile:'x',workspace:'x',rawScope:'x'} }]; }, 'EXPORT_SETTINGS_INVALID'],
      ['foreign fields', (e) => { e.value.sources[0].state.unknown = 'refuse'; }, 'EXPORT_INVALID']
    ];
    for (const [name, change, code, recalculate = true] of cases) {
      const e = structuredClone(v.envelope); change(e); if (recalculate) { for (const src of e.value.sources) src.ack.hash = hash(src.state); e.hash = hash(e.value); }
      checkEqual(name + ' refuses before staging', await errorCode(() => v.importer.import(e)), code);
    }
    checkEqual('invalid payloads produce zero secret items and zero starts', [v.adapter.values.size, v.starts, fs.existsSync(v.importer.file)], [0, 0, false]);
  } finally { await v.close(); }

  suite('Real legacy prPane: an unset width (null) imports');
  const paneWidth = await selected(path.join(base, 'pane-width-null'), { prepare: (f) => { for (const source of f.sources) source.engine.manager.list[0].prPane = { open: false, tab: 'conversation', width: null, full: false }; } });
  try {
    checkEqual('the export carries the null width', paneWidth.envelope.value.sources[0].state.instances[0].prPane?.width, null);
    checkEqual('legacy null pane width imports', await errorCode(() => paneWidth.importer.import(paneWidth.envelope)), null);
  } finally { await paneWidth.close(); }

  suite('P2 T50: duplicate instance accounting uses maxima across full payloads and ledgers');
  const maxima = await selected(path.join(base, 'maxima'));
  try {
    const sources = structuredClone(maxima.sources), first = sources[0].state.instances[0];
    first.totalCost = 2; first.usage = {input:20,output:4}; first.turns = 2;
    const duplicate = structuredClone(first); duplicate.totalCost = 3; duplicate.usage = {input:10,output:8}; duplicate.turns = 3;
    sources[1].state.instances = [duplicate]; sources[1].state.queues = [{instance:duplicate.id,items:duplicate.queue,hash:hash(duplicate.queue)}];
    sources[1].state.workspace['nikui.sessions.v1'] = [structuredClone(duplicate)];
    sources[1].state.files.exportedSessionIDs = [duplicate.id];
    sources[1].state.fileHashes.exportedSessionIDs = hash([duplicate.id]);
    sources[1].state.ledger.instances[first.id] = {cost:7,tokens:40,turns:4};
    for (const src of sources) src.ack.hash = hash(src.state);
    const result = buildSelectedTransfer(maxima.t,sources,{selectedSource:sources[0].member.id});
    const projected = require('../../../src/engineImport').materialize(result.value);
    checkEqual('duplicated instance appears once with per-field maxima', [projected.instances.length,projected.instances[0].totalCost,projected.instances[0].usage,projected.instances[0].turns], [1,3,{input:20,output:8},3]);
    checkEqual('ledger and session observations merge by maxima without duplicate sums', projected.ledger.instances[first.id], {cost:7,tokens:40,turns:4});
  } finally { await maxima.close(); }

  suite('P2 T41/T51: injected locked/denied/corrupt stores never regenerate or fall back');
  for (const failure of ['KEYCHAIN_LOCKED', 'KEYCHAIN_DENIED', 'KEYCHAIN_CORRUPT']) {
    const s = await selected(path.join(base, failure), { count: 1 });
    try {
      s.adapter.fail(failure);
      checkEqual(failure + ' refuses inactive import visibly', await errorCode(() => s.importer.import(s.envelope)), failure);
      checkEqual(failure + ' has zero activation or generated replacement keys', [s.starts, s.adapter.values.size], [0, 0]);
      s.adapter.fail(null); s.importer.import(s.envelope); await s.f.owner.imported(s.t.token, s.importer.import(s.envelope)); await s.importer.commit(s.t.token);
      s.adapter.fail(failure);
      checkEqual(failure + ' after commit refuses start with fence retained', [await errorCode(() => s.importer.start(s.t.token)), s.starts, s.f.owner.status().admission], [failure, 0, 'closed']);
    } finally { s.adapter.fail(null); await s.close(); }
  }

  suite('P2 T51/T52: corrupt staged payloads block the atomic generation commit');
  const corrupt = await selected(path.join(base,'corrupt-stage'),{count:1});
  try {
    const receipt=corrupt.importer.import(corrupt.envelope);await corrupt.f.owner.imported(corrupt.t.token,receipt);
    const bytes=fs.readFileSync(corrupt.importer.file), original=JSON.parse(bytes);
    const cases=[
      ['receipt counts',(record)=>{record.receipt.queues++;}],
      ['initial state',(record)=>{record.initial.instances[0].queue[0].text+='changed';record.initialHash=hash(record.initial);}],
      ['inactive mutable state',(record)=>{record.state.instances[0].queue[0].text+='changed';}],
      ['source provenance',(record)=>{record.transfer.sources[0].state.provenance.profile='foreign';}]
    ];
    for(const [name,change] of cases){const saved=structuredClone(original);change(saved.records[0]);require('../../../src/engineOwner').atomicJson(corrupt.importer.file,saved);
      check(name+' corruption refuses commit',await errorCode(()=>corrupt.importer.commit(corrupt.t.token))!==null);
      checkEqual(name+' corruption leaves old generation fenced',[corrupt.f.owner.status().generation,corrupt.starts],[0,0]);fs.writeFileSync(corrupt.importer.file,bytes);}
    const account=original.records[0].account,runtimeBytes=Buffer.from(corrupt.adapter.values.get(account)),runtime=JSON.parse(runtimeBytes);runtime.values['nikui.devices'][0].control=false;
    corrupt.adapter.values.set(account,Buffer.from(JSON.stringify(runtime)));
    checkEqual('changed staged grants refuse commit despite a valid keypair',await errorCode(()=>corrupt.importer.commit(corrupt.t.token)),'IMPORT_SECRET_MISMATCH');corrupt.adapter.values.set(account,runtimeBytes);
    const evidence=original.records[0].evidenceAccount,old=Buffer.from(corrupt.adapter.values.get(evidence));corrupt.adapter.values.set(evidence,Buffer.from('{broken'));
    checkEqual('corrupt Keychain evidence refuses commit without repair',await errorCode(()=>corrupt.importer.commit(corrupt.t.token)),'KEYCHAIN_CORRUPT');
    checkEqual('corrupt evidence never flips ownership',corrupt.f.owner.status().generation,0);corrupt.adapter.values.set(evidence,old);
    let discardRace;await corrupt.f.owner.commit(corrupt.t.token,{verifyImport:(receipt)=>{const proof=corrupt.importer.verifyInactive(receipt);try{corrupt.importer.discard(corrupt.t.token);}catch(e){discardRace=e.code;}return proof;}});
    checkEqual('commit lock prevents a concurrent discard after revalidation',[discardRace,corrupt.adapter.values.size,corrupt.f.owner.status().generation],['WRITER_FENCED',2,1]);
  } finally { await corrupt.close(); }

  suite('P2 T51: retained receipt capacity refuses before new secret writes');
  const capacity=await selected(path.join(base,'capacity'),{count:1});
  try {
    const importer=createGenerationImporter({...capacity.options,maxImports:1});
    importer.import(capacity.envelope);importer.discard(capacity.t.token);
    await capacity.f.owner.abort(capacity.t.token,{targetInactive:true,importDiscarded:true,allSourcesReachable:true});
    for(const source of capacity.f.sources)await source.gate.reopenAfterAbort();
    const t=await capacity.f.owner.begin({generation:0,to:'service',target:'test-service',inventory:capacity.f.inventory()});
    const sources=[];for(const source of capacity.f.sources)sources.push(await source.quiesce(t.token));
    const envelope=buildSelectedTransfer(t,sources,{selectedSource:sources[0].member.id});await capacity.f.owner.exported(t.token,envelope.hash);
    checkEqual('a full receipt store refuses a new import',[await errorCode(()=>importer.import(envelope)),capacity.adapter.values.size,importer.snapshot().records.length],['IMPORT_CAPACITY',0,1]);importer.dispose();
  } finally { await capacity.close(); }

  suite('P2 T48/T52: crash recovery across Keychain staging and owner commit');
  for (const point of ['import:prepared', 'import:evidence', 'import:runtime', 'import:secrets', 'import:inactive', 'start:reserved', 'start:effect', 'start:recorded']) {
    let enabled = true;
    const s = await selected(path.join(base, point), { count: 1, fault: (name) => { if (enabled && point === name) throw Object.assign(new Error('crash'), { code: 'CRASH' }); } });
    try {
      if (point.startsWith('import:')) {
        checkEqual(point + ' crash exercised', await errorCode(() => s.importer.import(s.envelope)), 'CRASH'); enabled = false;
        const reopened = createGenerationImporter({ ...s.options, fault: undefined });
        check(point + ' recovery never activates before commit', ['reimport-required', 'remain-inactive'].includes(reopened.recover().action) && s.starts === 0);
        const receipt = reopened.import(s.envelope); await s.f.owner.imported(s.t.token, receipt); await reopened.commit(s.t.token); await reopened.start(s.t.token);
        checkEqual(point + ' resumes exactly one committed target', s.starts, 1); reopened.dispose();
      } else {
        await commit(s);
        checkEqual(point + ' crash exercised', await errorCode(() => s.importer.start(s.t.token)), 'CRASH'); enabled = false;
        const reopened = createGenerationImporter({ ...s.options, fault: undefined });
        if (point !== 'start:recorded') {
          checkEqual(point + ' requires reconciliation without replay', [reopened.recover().action, await errorCode(() => reopened.start(s.t.token)), s.starts], ['reconcile-required', 'TARGET_START_UNKNOWN', point === 'start:effect' ? 1 : 0]);
        } else { await reopened.start(s.t.token); checkEqual(point + ' persisted activation is idempotent', s.starts, 1); }
        reopened.dispose();
      }
    } finally { await s.close(); }
  }

  suite('P2 T52: precommit discard is recoverable and never resurrects staged work');
  for (const point of ['discard:prepared', 'discard:runtime', 'discard:secrets']) {
    let enabled = false;
    const s = await selected(path.join(base, point), { count: 1, fault: (name) => { if (enabled && name === point) throw Object.assign(new Error('crash'), { code: 'CRASH' }); } });
    try {
      s.importer.import(s.envelope); enabled = true;
      checkEqual(point + ' crash exercised', await errorCode(() => s.importer.discard(s.t.token)), 'CRASH'); enabled = false;
      checkEqual(point + ' recovery removes exactly the staged accounts', [s.importer.recover().action, s.adapter.values.size], ['discarded', 0]);
      checkEqual(point + ' discarded import ID cannot recreate secrets', await errorCode(() => s.importer.import(s.envelope)), 'IMPORT_DISCARDED');
      await s.f.owner.abort(s.t.token, { targetInactive: true, importDiscarded: true, allSourcesReachable: true });
      checkEqual(point + ' proven abort retains old generation', s.f.owner.status().generation, 0);
    } finally { await s.close(); }
  }
  suite('P2 T52: crash at the atomic owner write recovers only the committed target');
  let crashOwner=true;
  const atomic=await selected(path.join(base,'owner-commit'),{count:1,ownerFault:(point)=>{if(crashOwner&&point==='owner:committed')throw Object.assign(new Error('crash'),{code:'CRASH'});}});
  try {
    const receipt=atomic.importer.import(atomic.envelope);await atomic.f.owner.imported(atomic.t.token,receipt);
    checkEqual('crash after owner rename is exercised',await errorCode(()=>atomic.importer.commit(atomic.t.token)),'CRASH');crashOwner=false;
    const owner=createSyntheticOwner({...atomic.f.options,fault:undefined}),recovery=await owner.recover();
    checkEqual('atomic owner commit repairs the journal and keeps admission closed',[recovery.owner.generation,recovery.action,owner.status().admission],[1,'recover-target','closed']);
    const importer=createGenerationImporter({...atomic.options,owner});await importer.start(atomic.t.token);await importer.start(atomic.t.token);
    checkEqual('committed owner recovery starts the target once',atomic.starts,1);importer.dispose();
  } finally { await atomic.close(); }

  suite('P2 T53/T54: fresh Keychain handback preserves post-cutover work and fences stale sources');
  const authorityRoot=path.join(base,'handback-authority');mkdir(authorityRoot);
  const authority=await require('../../../src/jsonlAuthority').openAuthority({file:path.join(authorityRoot,'authority.jsonl')});
  const {receipt,intent}=require('../../helpers/engine-disk');
  await authority.commit(state=>{state.entries.push(receipt(state,301));state.outbox.push(intent(state,301));});
  const h = await selected(path.join(base, 'handback'), {count:1,authority,completeAuthority:true});
  try {
    await commit(h); await h.importer.start(h.t.token); await release(h);
    const image = Buffer.from('new-image').toString('base64');
    h.importer.mutate((state) => {
      const queue = [{id:'new-queued',text:'post-cutover full input',sent:'expanded post-cutover',snippets:['new'],attachments:[{mediaType:'image/png',data:image}],state:'unknown'}];
      state.instances.push({id:'service-created',cwd:h.f.sources[0].home,provider:'claude',queue,totalCost:9,turns:2});
      state.queues.push({instance:'service-created',items:queue,hash:hash(queue)});
      state.ledger.instances['service-created']={cost:9,tokens:88,turns:2};
      state.authority.outbox.push(intent(state.authority,302,{text:'post-cutover accepted-unknown'},{state:'unknown'}),intent(state.authority,303,{text:'post-cutover effected'},{state:'completed'}));
    });
    h.runtime.store.update('nikui.slack.userToken','new-current-private');
    const member=h.importer.member();
    await h.f.owner.disconnect(member.lease);
    checkEqual('unreachable current owner blocks rollback rather than using backup',await errorCode(()=>h.f.owner.begin({generation:1,to:'window',target:'return-window',inventory:{complete:true,scope:h.f.owner.scope,ids:[member.id],otherScopes:[]}})),'CUTOVER_BLOCKED');
    const reachable=await h.f.owner.admit({id:member.id,build:'selected-generation-v1',metaVersion:1,requested:'service'});
    // A reconnected owner has a fresh lease; an earlier in-memory store stays fenced.
    checkEqual('disconnected owner cannot keep writing secrets',await errorCode(()=>h.runtime.store.update('other','late')),'STALE_GENERATION');
    h.importer.reconcileOwner(reachable);
    const t=await h.f.owner.begin({generation:1,to:'window',target:'return-window',inventory:{complete:true,scope:h.f.owner.scope,ids:[reachable.id],otherScopes:[]}});
    const gate=createParticipantGate({owner:h.f.owner,member:reachable});
    const source=await gate.quiesce(t.token,{closeAdmission(){},cancel(){},drain(){},flush(){},detach(){},releaseResources:()=>({released:true,owned:[]}),
      exportState:()=>h.importer.exportCurrent({transition:t.token,provenance:{profile:'test-profile',workspace:h.f.targetRoot,rawScope:'service'},keeper:{metaVersion:1,runs:[]}})});
    const envelope=buildSelectedTransfer(t,[source],{selectedSource:reachable.id});await h.f.owner.exported(t.token,envelope.hash);
    const returnRoot=path.join(path.dirname(h.f.targetRoot),'r');mkdir(returnRoot);let returned;
    const back=createGenerationImporter({root:returnRoot,target:'return-window',owner:h.f.owner,secretAdapter:h.adapter,testOnly:true,activate(state,_generation,_member,store){returned={state,store};}});
    const receipt=back.import(envelope);await h.f.owner.imported(t.token,receipt);await back.commit(t.token);await back.start(t.token);
    checkEqual('handback advances generation and keeps current IDs/full queues/accounting', [h.f.owner.status().generation,returned.state.instances.some(i=>i.id==='service-created'),returned.state.queues.find(q=>q.instance==='service-created').items[0].attachments[0].data===image,returned.state.ledger.instances['service-created'].cost],[2,true,true,9]);
    const invalidAuthority=structuredClone(envelope);invalidAuthority.value.sources[0].state.authority.values['engine.current.v1']={broken:true};invalidAuthority.value.sources[0].ack.hash=hash(invalidAuthority.value.sources[0].state);invalidAuthority.hash=hash(invalidAuthority.value);
    checkEqual('malformed engine-domain authority cannot pass generic JSONL validation',await errorCode(()=>validateSelectedTransfer(invalidAuthority)),'EXPORT_AUTHORITY_INVALID');
    checkEqual('handback retains exact current receipt scope, IDs and unknown/effected states',[returned.state.authority.scope,returned.state.authority.outbox.map(q=>[q.mid,q.state])],[authority.snapshot().scope,[[require('../../helpers/engine-disk').mid(301),'queued'],[require('../../helpers/engine-disk').mid(302),'unknown'],[require('../../helpers/engine-disk').mid(303),'completed']]]);
    check('handback uses current credentials rather than the pre-cutover backup',returned.store.get('nikui.slack.userToken')==='new-current-private');
    checkEqual('handback retains selected host and VAPID pins',returned.store.get('nikd.selection'),h.selection);
    checkEqual('old generation cannot mutate after handback',await errorCode(()=>h.importer.mutate(()=>{})),'WRITER_FENCED');
    await h.f.owner.started(t.token,{generation:2,target:'return-window',hash:envelope.hash,oldResourcesReleased:true});await h.f.owner.release(t.token);
    const backMember=back.member(),again=await h.f.owner.begin({generation:2,to:'service',target:'test-service',inventory:{complete:true,scope:h.f.owner.scope,ids:[backMember.id],otherScopes:[]}});
    const backGate=createParticipantGate({owner:h.f.owner,member:backMember});
    const fresh=await backGate.quiesce(again.token,{closeAdmission(){},cancel(){},drain(){},flush(){},detach(){},releaseResources:()=>({released:true,owned:[]}),
      exportState:()=>back.exportCurrent({transition:again.token,provenance:{profile:'test-profile',workspace:returnRoot,rawScope:'workspace'},keeper:{metaVersion:1,runs:[]}})});
    const next=buildSelectedTransfer(again,[fresh],{selectedSource:backMember.id});await h.f.owner.exported(again.token,next.hash);
    const nextReceipt=h.importer.import(next);await h.f.owner.imported(again.token,nextReceipt);await h.importer.commit(again.token);await h.importer.start(again.token);
    checkEqual('a retired target root accepts a new fenced generation without losing old receipts',[h.f.owner.status().generation,h.importer.snapshot().records.length,h.importer.import(h.envelope).id],[3,2,h.t.token]);
    check('repeated cutover retains post-cutover session IDs and full queues',h.runtime.state.instances.some(i=>i.id==='service-created')&&h.runtime.state.queues.some(q=>q.items.some(i=>i.text==='post-cutover full input')));
    back.dispose();
  } finally { await h.close(); await authority.close(); }

};
