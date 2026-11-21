'use strict';
const fs=require('fs'),path=require('path');
const {startDaemon}=require('../../../src/daemonRuntime');
const {createKeychainStore}=require('../../../src/keychainStore');
const {memoryKeychain,keypair,pins}=require('../../helpers/keychain');
const {errorCode}=require('../../helpers/engine-disk');
const base=fs.realpathSync(process.env.NIKUI_ENGINE_FIXTURE_ROOT);
module.exports=async()=>{
  suite('P2 T41: actual daemon selects the injected Keychain interface without file fallback');
  const adapter=memoryKeychain(),initial={'nikui.identity':keypair(),'nikui.vapid':keypair()};initial['nikd.selection']=pins(initial);
  const store=createKeychainStore({adapter,account:'daemon',create:true,initial});store.dispose();
  const root=path.join(base,'daemon');fs.mkdirSync(root,{mode:0o700});
  const daemon=await startDaemon({root,adapters:{keychain:{adapter,account:'daemon'},tools:{knownDirs:[],lookup:async()=>({path:'/fixture',tools:{}})}}});
  try{
    checkEqual('daemon uses the exact imported host and VAPID pins',[daemon.engine.delivery.identity.fingerprint,daemon.engine.delivery.vapid.applicationServerKey],Object.values(initial['nikd.selection']));
    checkEqual('selected daemon never creates the test secret file',fs.existsSync(daemon.paths.secrets),false);
    checkEqual('selected daemon does not add a replacement secret item',adapter.calls.filter(c=>c.op==='add').length,1);
    checkEqual('closing remote viewers does not own the Keychain daemon lifetime',daemon.status().state,'running');
  }finally{await daemon.stop();}
  for(const failure of ['KEYCHAIN_LOCKED','KEYCHAIN_DENIED','KEYCHAIN_CORRUPT']){
    adapter.fail(failure);
    checkEqual(failure+' startup refuses without a file fallback',await errorCode(()=>startDaemon({root,adapters:{keychain:{adapter,account:'daemon'},tools:{knownDirs:[],lookup:async()=>({path:'/fixture',tools:{}})}}})),failure);
    checkEqual(failure+' leaves the selected secret file absent',fs.existsSync(path.join(root,'secrets.test.json')),false);
  }
  adapter.fail(null);
  const missing=memoryKeychain(),empty=createKeychainStore({adapter:missing,account:'daemon',create:true,initial:{}});empty.dispose();
  checkEqual('empty selected Keychain store refuses bootstrap',await errorCode(()=>startDaemon({root,adapters:{keychain:{adapter:missing,account:'daemon'},tools:{knownDirs:[],lookup:async()=>({path:'/fixture',tools:{}})}}})),'IDENTITY_UNAVAILABLE');
  checkEqual('empty selected store still has no identity key',createKeychainStore({adapter:missing,account:'daemon'}).keys(),[]);
};
