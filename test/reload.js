// Simulate a real window reload: activate, persist, tear down, activate again
// from the same storage — including storage written by the PREVIOUS version.
const Module = require('module');
const path = require('path');
const EE = require('events');

const registered = {};
let serializer = null;
const stub = {
  EventEmitter: class { constructor(){ this._e=new EE(); this.event=(fn)=>{this._e.on('x',fn);return{dispose(){}}}; } fire(v){this._e.emit('x',v);} dispose(){} },
  TreeItem: class { constructor(l,s){ this.label=l; this.collapsibleState=s; } },
  ThemeIcon: Object.assign(class { constructor(i,c){ this.id=i; this.color=c; } }, { Folder:{id:'folder'} }),
  ThemeColor: class { constructor(i){ this.id=i; } },
  MarkdownString: class { constructor(v){ this.value=v; } },
  DataTransferItem: class { constructor(v){ this.value=v; } },
  TreeItemCollapsibleState: { None:0, Collapsed:1, Expanded:2 },
  ViewColumn: { Active:-1, Beside:-2 },
  Range: class { constructor(){} },
  Uri: { file:(p)=>({fsPath:p}), joinPath:(b,...p)=>({fsPath:path.join(b.fsPath,...p)}) },
  window: {
    createTreeView: () => ({ badge: undefined, dispose(){}, onDidChangeVisibility: () => ({dispose(){}}) }),
    createWebviewPanel: () => mkPanel(),
    showQuickPick: async()=>undefined, showOpenDialog: async()=>undefined,
    showInputBox: async()=>undefined, showWarningMessage: async()=>undefined,
    setStatusBarMessage: ()=>{}, showTextDocument: async()=>{},
    registerWebviewPanelSerializer: (t, s) => { serializer = s; return {dispose(){}}; }
  },
  commands: { registerCommand:(id,fn)=>{registered[id]=fn; return {dispose(){}};}, executeCommand: async()=>{} },
  workspace: {
    workspaceFolders: [{ name:'Peuka', uri:{fsPath:'/Users/nikoloz/Codes/Peuka'} }],
    getConfiguration: () => ({ get:(k,d)=>d }),
    openTextDocument: async()=>({})
  }
};
function mkPanel(){ return { webview:{ html:'', cspSource:'x', asWebviewUri:u=>u, onDidReceiveMessage:()=>({dispose(){}}), postMessage(){}, options:{} }, onDidDispose:()=>({dispose(){}}), reveal(){}, dispose(){}, title:'', iconPath:null }; }
const orig = Module._load;
Module._load = function(r){ if(r==='vscode') return stub; return orig.apply(this,arguments); };

// ---- storage as it would look after the PREVIOUS version ran -------------
const ws = {
  'nikui.sessions.v1': [
    // old-format entry: no totalCost, no usage, no autoLabel
    { id:'old1', cwd:'/Users/nikoloz/Codes/Peuka', customTitle:null, ticket:'1338', claudeSessionId:'afbd8c56-4db7-4fde-b654-f5f074c4667e' },
    // new-format entry
    { id:'new1', cwd:'/Users/nikoloz/Codes/NikUI', customTitle:'My tab', autoLabel:null, ticket:null,
      claudeSessionId:'deadbeef-0000-0000-0000-000000000000', totalCost:0.0175, usage:{input:44,output:723,cacheRead:106783,cacheCreate:0} }
  ],
  'nikui.folders.v1': { folders:[{id:'f1',name:'Review queue'}], assign:{ old1:'f1' } }
};
const gs = {};
const context = {
  subscriptions: [], extensionUri: { fsPath: process.env.HOME + '/Codes/NikUI' },
  workspaceState: { get:(k,d)=> (k in ws ? ws[k] : d), update:(k,v)=>{ws[k]=v;} },
  globalState: { get:(k,d)=> (k in gs ? gs[k] : d), update:(k,v)=>{gs[k]=v;} }
};

const ext = require(process.env.HOME + '/Codes/NikUI/src/extension.js');

(async () => {
  ext.activate(context);
  console.log('activate() after a reload: ok');

  const { SessionTree } = require(process.env.HOME + '/Codes/NikUI/src/tree.js');
  // Find the manager via the tree the extension built is awkward; rebuild the
  // same view of the world from storage to assert on it.
  const { SessionManager } = require(process.env.HOME + '/Codes/NikUI/src/manager.js');
  const { FolderStore } = require(process.env.HOME + '/Codes/NikUI/src/folders.js');
  const mgr = new SessionManager(context);
  mgr.restoreOpen();
  const folders = new FolderStore(context);
  const tree = new SessionTree(mgr, folders);

  const restored = mgr.list;
  const oldOne = restored.find(s => s.id === 'old1');
  const newOne = restored.find(s => s.id === 'new1');

  console.log('\nrestored instances:');
  for (const s of restored) {
    console.log('  ' + s.id.padEnd(6) + ' label=' + String(s.label).padEnd(10) +
      ' cost=$' + s.totalCost.toFixed(4) + ' tokens=' + (s.usage.input + s.usage.output) +
      ' running=' + s.isRunning + ' status=' + s.status);
  }

  const roots = tree.getChildren();
  console.log('\ntree roots:', roots.map(r => r.__folder ? 'FOLDER:'+r.label : r.__group ? 'group:'+r.label : r.label).join(', '));

  // The serializer must hand a restored tab back to its instance.
  let adopted = false;
  if (serializer) {
    const panel = mkPanel();
    await serializer.deserializeWebviewPanel(panel, { sessionId: 'new1' });
    adopted = true;
  }

  const checks = [
    ['both instances restored', restored.length === 2],
    ['old-format entry survives with no cost field', !!oldOne && oldOne.totalCost === 0],
    ['old-format entry keeps its ticket name', oldOne && oldOne.label === '1338'],
    ['new-format cost restored', newOne && Math.abs(newOne.totalCost - 0.0175) < 1e-9],
    ['new-format baseline anchored to it', newOne && Math.abs(newOne._costBaseline - 0.0175) < 1e-9],
    ['new-format tokens restored', newOne && newOne.usage.output === 723],
    ['custom title survives', newOne && newOne.label === 'My tab'],
    ['no process spawned on reload', restored.every(s => !s.isRunning)],
    ['folder restored with its member', roots.some(r => r.__folder && r.label === 'Review queue' && r.sessions.length === 1)],
    ['unfiled instance still listed', roots.some(r => (r.__group && r.sessions.length) || (!r.__folder && !r.__group))],
    ['serializer accepted a restored tab', adopted],
    ['every declared command is registered',
      require(process.env.HOME + '/Codes/NikUI/package.json').contributes.commands
        .every(c => typeof registered[c.command] === 'function')]
  ];
  let bad = 0;
  console.log('\n=== RELOAD CHECKS ===');
  for (const [n, ok] of checks) { console.log((ok ? 'PASS  ' : 'FAIL  ') + n); if (!ok) bad++; }
  console.log(bad ? '\n' + bad + ' FAILED' : '\nALL RELOAD CHECKS PASS');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e); process.exit(1); });
