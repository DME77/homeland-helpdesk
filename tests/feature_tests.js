'use strict';
/*
 * Tests the three NEW features' pure logic, extracted straight from the edited
 * index.html: @mention parsing/highlighting, attachment filename/extension
 * derivation, the 7-day auto-close sweep state machine, and notification merge.
 * No network, no DOM.
 */
const fs=require('fs'), path=require('path'), vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

function sliceBetween(startStr, endStrAfter){
  const s=html.indexOf(startStr); if(s<0) throw new Error('missing '+startStr);
  const e0=html.indexOf(endStrAfter, s); if(e0<0) throw new Error('missing '+endStrAfter);
  const e=html.indexOf('\n}', e0)+2;
  return html.slice(s, e);
}
const featureBlock = sliceBetween('function uid(prefix)', 'return changed;');
const mergeBlock   = html.slice(html.indexOf('var lastRowUpdated = null;'), html.indexOf('// Light re-render after a background merge'));

// ---- sandbox with the same esc() the app uses + minimal stubs ----
let saveCalls=0;
const sandbox={ console,
  esc:function(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');},
  userById:function(id){return (sandbox.db&&sandbox.db.users||[]).find(u=>u.id===id)||null;},
  saveDB:function(){saveCalls++;},
  Date, Math,
  db:null
};
vm.createContext(sandbox);
vm.runInContext(mergeBlock + '\n' + featureBlock +
  '\nthis.parseMentions=parseMentions;this.renderCommentText=renderCommentText;this.dataUrlExt=dataUrlExt;'+
  'this.attachmentFilename=attachmentFilename;this.sweepAutoClose=sweepAutoClose;this.mergeState=mergeState;'+
  'this.AUTO_CLOSE_DAYS=AUTO_CLOSE_DAYS;this.setT=function(v){_tombstones=v};', sandbox);

let PASS=0,FAIL=0;
function assert(c,m){ if(c){PASS++;console.log('  ✓ '+m);} else {FAIL++;console.log('  ✗ FAIL: '+m);} }
function section(t){ console.log('\n'+t); }

const USERS=[
  {id:'u-priyaS', name:'Priya Sharma', username:'priya',    dept:'IT'},
  {id:'u-priya',  name:'Priya',        username:'priyaonly',dept:'HR'},
  {id:'u-alex',   name:'Alex Kim',     username:'alex',     dept:'Finance'},
  {id:'u-me',     name:'Vivek',        username:'SA261',    dept:'Administration'}
];
function setDB(extra){ sandbox.db=Object.assign({users:USERS,tickets:[],notifications:[],passwordRequests:[],departments:[],seq:1000}, extra||{}); }

section('@mention parsing');
{
  setDB();
  let r=sandbox.parseMentions('hey @Priya Sharma please look');
  assert(r.ids.length===1 && r.ids[0]==='u-priyaS', 'full name with a space matches the right person (not "Priya")');

  r=sandbox.parseMentions('@priyaonly and @alex on it');
  assert(r.ids.indexOf('u-priya')>-1 && r.ids.indexOf('u-alex')>-1, 'usernames @priyaonly and @alex both match');

  // Deterministic tie-break: "@priya" collides (username of Priya Sharma vs name of Priya) -> name wins.
  r=sandbox.parseMentions('@priya please');
  assert(r.ids.length===1 && r.ids[0]==='u-priya', 'ambiguous "@priya" deterministically resolves to the full-name match');

  r=sandbox.parseMentions('@Priya Sharma @Priya Sharma again');
  assert(r.ids.length===1, 'duplicate mention of same person de-duplicated');

  r=sandbox.parseMentions('ping @Nobody here');
  assert(r.ids.length===0, 'unknown @Nobody matches no one');

  r=sandbox.parseMentions('mail me at alex@company.com');
  assert(r.ids.length===0, 'an email address does not trigger a mention');

  r=sandbox.parseMentions('@Priya on this');
  assert(r.ids.length===1 && r.ids[0]==='u-priya', 'shorter "@Priya" matches the user named exactly Priya');
}

section('@mention rendering (highlight + XSS-safe)');
{
  setDB();
  let out=sandbox.renderCommentText('hi @Priya Sharma!', ['u-priyaS']);
  assert(out.indexOf('<span class="mention">@Priya Sharma</span>')>-1, 'mention is wrapped in a highlight span');
  assert(out.indexOf('!')>-1, 'trailing punctuation preserved');

  out=sandbox.renderCommentText('<script>alert(1)</script> @Alex Kim', ['u-alex']);
  assert(out.indexOf('<script>')===-1, 'raw HTML in a comment is escaped (no injection)');
  assert(out.indexOf('<span class="mention">@Alex Kim</span>')>-1, 'full-name mention highlighted alongside escaped text');
}

section('attachment filename / extension');
{
  assert(sandbox.dataUrlExt('data:image/png;base64,AAA')==='png', 'png detected');
  assert(sandbox.dataUrlExt('data:image/jpeg;base64,AAA')==='jpg', 'jpeg -> jpg');
  assert(sandbox.dataUrlExt('data:application/pdf;base64,AAA')==='pdf', 'pdf detected');
  assert(sandbox.dataUrlExt('data:something/weird;base64,AAA')==='weird', 'unknown subtype used as-is');
  assert(sandbox.dataUrlExt('not-a-data-url')==='bin', 'garbage -> bin');
  assert(sandbox.attachmentFilename('TKT-1042','attachment',0,'data:image/png;base64,AAA')==='TKT-1042-attachment-1.png',
    'filename combines ticket id + kind + index + ext');
}

section('7-day auto-close sweep');
{
  const daysAgo=n=>new Date(Date.now()-n*86400000).toISOString();
  saveCalls=0;
  setDB({ tickets:[
    {id:'T-old', st:'resolved', resolvedAt:daysAgo(8), created:daysAgo(20), updated:daysAgo(8), log:[]},
    {id:'T-recent', st:'resolved', resolvedAt:daysAgo(3), created:daysAgo(4), updated:daysAgo(3), log:[]},
    {id:'T-noStamp', st:'resolved', created:daysAgo(2), updated:daysAgo(2), log:[]},
    {id:'T-open', st:'open', created:daysAgo(1), updated:daysAgo(1), log:[]}
  ]});
  const changed=sandbox.sweepAutoClose();
  const byId=id=>sandbox.db.tickets.find(t=>t.id===id);
  assert(changed===true, 'sweep reports a change');
  assert(byId('T-old').st==='closed' && byId('T-old').closedReason==='timeout', 'ticket resolved >7d ago is auto-closed (timeout)');
  assert(byId('T-old').log.some(l=>/Auto-closed/.test(l.msg)), 'a timeline note is added on auto-close');
  assert(byId('T-recent').st==='resolved', 'ticket resolved 3d ago is left alone');
  assert(!!byId('T-noStamp').resolvedAt && byId('T-noStamp').st==='resolved', 'resolved ticket with no timestamp is backfilled, not closed');
  assert(byId('T-open').st==='open', 'open ticket untouched');
  assert(saveCalls===1, 'sweep saved exactly once when something changed');

  saveCalls=0;
  const again=sandbox.sweepAutoClose();
  assert(again===false && saveCalls===0, 'idempotent: a second sweep changes nothing and does not save');
}

section('notification merge (union + read = OR)');
{
  sandbox.setT({tickets:{},users:{},passwordRequests:{},departments:{}});
  const remote={notifications:[{id:'n1',uid:'u-me',read:false},{id:'n2',uid:'u-me',read:true}]};
  const local ={notifications:[{id:'n1',uid:'u-me',read:true},{id:'n3',uid:'u-me',read:false}]};
  const m=sandbox.mergeState(remote, local);
  const get=id=>m.notifications.find(n=>n.id===id);
  assert(m.notifications.length===3, 'all three notifications kept (union)');
  assert(get('n1').read===true, 'read state is OR-merged (read on one device stays read)');
  assert(get('n3').read===false, 'unread notification preserved');
}

console.log('\n'+'='.repeat(56));
console.log('FEATURE RESULTS: '+PASS+' passed, '+FAIL+' failed');
console.log('='.repeat(56));
process.exit(FAIL?1:0);
