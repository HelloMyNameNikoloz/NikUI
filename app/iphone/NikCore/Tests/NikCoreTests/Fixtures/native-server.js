'use strict';
// Real RemoteServer/Gate/DeviceStore/PairingWindow; test-only in-memory dependencies, never launches providers.
const path = require('path'), readline = require('readline');
const root = process.argv[2];
const {RemoteServer} = require(path.join(root,'src/remote.js'));
const {LocalKey} = require(path.join(root,'src/auth.js'));
const {DeviceStore} = require(path.join(root,'src/devices.js'));
const {PairingWindow} = require(path.join(root,'src/pairing.js'));
const {loadIdentity} = require(path.join(root,'src/identity.js'));
const state = new Map();const memory={get:(k,d)=>state.has(k)?state.get(k):d,update:(k,v)=>{state.set(k,v);return Promise.resolve();}};
const devices=new DeviceStore(memory), identity=loadIdentity(memory), pairing=new PairingWindow(), localKey=new LocalKey('native-fixture-local-key');
const host={config:()=>({}),knownCommands:()=>[],home:'/tmp',fleet:()=>[],env:()=>({})};
const server=new RemoteServer({root,host,sessions:{list:()=>[],get:()=>null},devices,identity,pairing,localKey,hubs:{hubFor:()=>{throw new Error('No conversations in native fixture');}},history:async()=>[],requireSealed:()=>true});
const observed=[];
function req(host,origin,forwarded){return {url:'/',socket:{remoteAddress:'127.0.0.1'},headers:{host,...(origin?{origin}:{}),...(forwarded?{'x-forwarded-for':'100.64.0.1'}:{})}};}
(async()=>{
 await server.start(0); const host=`127.0.0.1:${server.port}`;
 server.server.on('request',(request)=>observed.push({method:request.method,path:request.url,origin:request.headers.origin||null}));
 server.server.on('upgrade',(request)=>observed.push({method:'UPGRADE',path:request.url,origin:request.headers.origin||null}));
 const invitation=pairing.start({host,scheme:'http',fingerprint:identity.fingerprint,laptop:'Fixture laptop'});
 process.stdout.write(JSON.stringify({baseURL:`http://${host}`,link:invitation.appLink,fingerprint:identity.fingerprint})+'\n');
 const input=readline.createInterface({input:process.stdin});
 input.on('line',async line=>{
   if(line==='stop'){await server.dispose();input.close();process.exit(0);}
   if(line==='observed')process.stdout.write(JSON.stringify(observed)+'\n');
   if(line==='guards'){
     server.publicHost='laptop.example';
     const native=req('laptop.example',null,true),custom=req('laptop.example','nikui://native',true);
     const bearer=req('laptop.example',null,true);bearer.headers.authorization='Bearer '+localKey.key;
     process.stdout.write(JSON.stringify({native:server.guard(native),custom:server.guard(custom),localBearer:localKey.check(bearer,{loopbackHost:false})})+'\n');
   }
 });
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exit(1);});
