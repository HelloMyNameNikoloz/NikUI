'use strict';
// Run explicitly to refresh fixtures from the repository's real protocol/rendering modules.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../../../../..');
const secure = require(path.join(root, 'src/secure.js'));
const identity = require(path.join(root, 'src/identity.js'));
const { highlight } = require(path.join(root, 'media/highlight.js'));
const { renderMarkdown } = require(path.join(root, 'media/markdown.js'));
const snippets = require(path.join(root, 'media/snippets.js'));
const suggest = require(path.join(root, 'media/suggest.js'));
function key(n) {
  const raw = Buffer.alloc(32); raw[31] = n;
  const ec = crypto.createECDH('prime256v1'); ec.setPrivateKey(raw);
  const point = ec.getPublicKey(null, 'uncompressed');
  const privateKey = crypto.createPrivateKey({key: {kty:'EC',crv:'P-256',d:raw.toString('base64url'),x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url')},format:'jwk'});
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const saved = {publicKey:spki,privateKey:privateKey.export({type:'pkcs8',format:'der'}).toString('base64url')};
  return {privateKey,spki,raw:raw.toString('hex'),identity:identity.loadIdentity({get:()=>saved})};
}
const host = key(1), device = key(2), server = key(3), client = key(4), candidate = key(5);
const ns = Buffer.alloc(32,17).toString('base64url'), nc = Buffer.alloc(24,34).toString('base64url');
const binding = secure.binding(server.spki, client.spki);
const shared = crypto.diffieHellman({privateKey:server.privateKey,publicKey:crypto.createPublicKey({key:Buffer.from(client.spki,'base64url'),format:'der',type:'spki'})});
const keys = secure.derive(shared,ns,nc);
const serverBox = secure.serverBox(server,client.spki,ns,nc);
const phoneBox = new secure.Box(keys.toServer,keys.toClient);
const messages = ['{"type":"ready","hidden":false}', '{"type":"send","text":"Hello 👋 — ქართული\\nsecond line"}'];
const welcome = {type:'@welcome',device:{id:'device1',name:'iPhone',kind:'device',control:true},signature:host.identity.sign(`nikui-host:${nc}:${ns}:${binding}`),version:'0.2.0'};
const vector = {
  source:'src/identity.js + src/secure.js; P-256 scalars 1/2/3/4/5', hostRaw:host.raw,deviceRaw:device.raw,serverEphemeralRaw:server.raw,clientEphemeralRaw:client.raw,candidateRaw:candidate.raw,
  hostSPKI:host.spki,deviceSPKI:device.spki,serverEphemeralSPKI:server.spki,clientEphemeralSPKI:client.spki,fingerprint:host.identity.fingerprint,
  serverNonce:ns,clientNonce:nc,binding,shared:shared.toString('hex'),
  toClientKey:keys.toClient.key.toString('hex'),toClientNonce:keys.toClient.base.toString('hex'),toServerKey:keys.toServer.key.toString('hex'),toServerNonce:keys.toServer.base.toString('hex'),
  signatureMessage:'nikui-pair:23ABCDEF — ქართული 👋\nno trailing newline',
  challenge:{type:'@challenge',nonce:ns,epk:server.spki,serverKey:host.spki,fingerprint:host.identity.fingerprint},
  welcome,boxedWelcome:serverBox.seal(JSON.stringify(welcome)),messages,
  phonePackets:messages.map(m=>phoneBox.seal(m)),serverPackets:messages.map(m=>serverBox.seal(m)),
  nonces:[0,1,255,256,65535,Math.pow(2,40)+1,secure.CEILING-1].map(n=>({n,hex:secure.nonceFor(keys.toServer.base,n).toString('hex')}))
};
vector.signature=host.identity.sign(vector.signatureMessage);
vector.signatureDER=crypto.sign('sha256',Buffer.from(vector.signatureMessage),{key:host.privateKey,dsaEncoding:'der'}).toString('base64url');
vector.pbkdf2=[{password:'password',salt:'salt',rounds:1},{password:'password',salt:'salt',rounds:2},{password:'123456',salt:'0123456789abcdef',rounds:210000}].map(v=>({...v,hex:crypto.pbkdf2Sync(v.password,v.salt,v.rounds,32,'sha256').toString('hex')}));
fs.writeFileSync(path.join(__dirname,'interop.json'),JSON.stringify(vector,null,2)+'\n');
function unescape(s) { return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&'); }
const classMap={comment:'comment',str:'string',kw:'keyword',ctl:'keyword',const:'keyword',num:'number',type:'type',fn:'function',var:'property',rx:'string',punct:'punctuation',tag:'type',attr:'property',sel:'type',val:'string',head:'heading',meta:'heading',ins:'inserted',del:'deleted'};
const codes=[
 ['javascript','// A comment\nconst answer = "hello 👋";\nfunction run(value) { return value + 42; }'],
 ['typescript','interface User { name: string }\nconst user: User = { name: "Nik" };'],
 ['python','@decorator\ndef greet(name):\n    # hi\n    return f"Hello {name}"'],
 ['swift','struct Client {\n let id: String\n func connect() { return true }\n}'],
 ['json','{"name":"Nik","ok":true,"count":42,"items":[1,2]}'],
 ['sql','SELECT name FROM users WHERE id = 42; -- comment'],
 ['shell','$ git status --short\necho "$HOME"\nexport VALUE=42\n# done'],
 ['yaml','name: Nik\ncount: 42\nready: true # yes\nitems:\n  - value'],
 ['diff','diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new'],
 ['html','<div class="row"><strong>Hello</strong><!-- yes --></div>'],
 ['css','.row {\n color: #ff00ff;\n width: 12px;\n}'],
 ['vue','<template><div>{{ answer }}</div></template>\n<script lang="ts">const answer: number = 42;</script>']
];
const tokens=codes.map(([language,source])=>{
 const result=highlight(source,language); const re=/<span class="tk-([a-z]+)">([\s\S]*?)<\/span>/g; let cursor=0,offset=0,m,items=[];
 while((m=re.exec(result.html))) { offset+=unescape(result.html.slice(cursor,m.index)).length; const value=unescape(m[2]);items.push({start:offset,end:offset+value.length,kind:classMap[m[1]]});offset+=value.length;cursor=re.lastIndex; }
 return {language,source,detected:require(path.join(root,'media/highlight.js')).detect(source),tokens:items};
});
const markdown=['# Hello\n\nA **bold** and _italic_ word.','| Left | Code |\n| --- | ---: |\n| a | `x|y` |\n| b | c | overflow |','- first\n  - nested\n- second','> a quote\n>\n> ```js\n> const x = 42;\n> ```','Literal <script>alert(1)</script> & HTML.','[PR](https://example.com/a_(b)) ![pixel](data:image/png;base64,AAAA)'];
const snippetInputs=['/one fix   the bug /two /ONE','\n unchanged  whitespace \n','/two /one','x /one middle y','/empty hello'];
const snippetTable={one:'First instruction.',two:'Second instruction.',empty:'  '};
const replies=["Tell me once it's pushed.","Would you prefer the signed release, the automatic workflow, or just the debug APK?","Should I run the tests?","Say the word and I will deploy.","The job completed successfully."];
fs.writeFileSync(path.join(__dirname,'rendering.json'),JSON.stringify({tokens,markdown:markdown.map(source=>({source,html:renderMarkdown(source)})),snippets:snippetInputs.map(source=>({source,table:snippetTable,expected:snippets.expand(source,snippetTable)})),replies:replies.map(source=>({source,expected:suggest.replies(source)}))},null,2)+'\n');
console.log('Generated interop.json and rendering.json from repository modules.');
