'use strict';
/*
 * Verifies the ACTUAL merge/sync logic shipped in index.html (not the scratch
 * copy). It slices the pure helpers out of index.html, evaluates them, and runs
 * the loss-critical battery + a two-client race driven through the extracted
 * mergeState. Nothing here touches the network.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Extract from `var lastRowUpdated` up to (but not including) the DOM-bound
// _afterMergeRefresh helper -- i.e. the pure, testable core.
const startMarker = 'var lastRowUpdated = null;';
const endMarker = '// Light re-render after a background merge';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker);
if(start < 0 || end < 0 || end < start){ console.error('Could not locate merge block in index.html'); process.exit(2); }
const code = html.slice(start, end);

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(code + '\nthis.mergeState = mergeState; this.getT = function(){ return _tombstones; }; this.setT = function(v){ _tombstones = v; };', sandbox);
const mergeState = sandbox.mergeState;
const resetTombstones = () => sandbox.setT({ tickets:{}, users:{}, passwordRequests:{}, departments:{} });

let PASS = 0, FAIL = 0;
function assert(cond, msg){ if(cond){ PASS++; console.log('  ✓ ' + msg); } else { FAIL++; console.log('  ✗ FAIL: ' + msg); } }

const BASE_ISO = '2026-01-01T00:00:00.000Z';
let _clock = Date.parse(BASE_ISO);
const nowTs = () => { _clock += 1000; return new Date(_clock).toISOString(); };
const findT = (db,id) => (db.tickets||[]).find(t=>t.id===id);
function seed(){
  return { users:[{id:'U-ADMIN',name:'Vivek',role:'superadmin'}],
    tickets:[
      {id:'TKT-1001',title:'VPN down',st:'open',updated:BASE_ISO,created:BASE_ISO,log:[{type:'created',at:BASE_ISO,user:'Vivek',msg:'created'}]},
      {id:'TKT-1002',title:'Laptop broken',st:'open',updated:BASE_ISO,created:BASE_ISO,log:[{type:'created',at:BASE_ISO,user:'Vivek',msg:'created'}]}],
    passwordRequests:[], departments:[{name:'IT',subs:['Network']}], seq:1002 };
}

// ---- A CAS table + fixed client driven through the EXTRACTED mergeState ----
function makeTable(initial){
  const row = { data: JSON.parse(JSON.stringify(initial)), updated: nowTs() };
  return {
    read(){ return { data: JSON.parse(JSON.stringify(row.data)), updated: row.updated }; },
    cas(data, guard){ if(guard!=null && guard!==row.updated) return {matched:0}; row.data=JSON.parse(JSON.stringify(data)); row.updated=nowTs(); return {matched:1, updated:row.updated}; }
  };
}
function fixedSave(table, client){
  for(let i=0;i<12;i++){
    const r = table.cas(client.db, client.lastRowUpdated);
    if(r.matched){ client.lastRowUpdated=r.updated; return; }
    const fresh = table.read();
    client.db = mergeState(fresh.data, client.db);
    client.lastRowUpdated = fresh.updated;
  }
  throw new Error('no converge');
}

console.log('Verifying the merge logic SHIPPED in index.html\n');

console.log('Two-client race (stale save must not erase an in-progress ticket):');
{
  _clock = Date.parse(BASE_ISO); resetTombstones();
  const table = makeTable(seed());
  const baseV = table.read().updated;
  const A = { db: seed(), lastRowUpdated: baseV };
  const B = { db: table.read().data, lastRowUpdated: table.read().updated };
  findT(B.db,'TKT-1002').st='in-progress'; findT(B.db,'TKT-1002').updated=nowTs();
  findT(B.db,'TKT-1002').log.push({type:'status',at:nowTs(),user:'B',msg:'to in-progress'});
  fixedSave(table, B);
  findT(A.db,'TKT-1001').log.push({type:'comment',at:nowTs(),user:'A',msg:'looking'}); findT(A.db,'TKT-1001').updated=nowTs();
  fixedSave(table, A);
  const s = table.read().data;
  assert(findT(s,'TKT-1002').st==='in-progress', "B's in-progress TKT-1002 survives A's stale save");
  assert(findT(s,'TKT-1001').log.some(l=>l.msg==='looking'), "A's comment survives");
}

console.log('\nNew-ticket race (a brand-new in-progress ticket must not vanish):');
{
  _clock = Date.parse(BASE_ISO); resetTombstones();
  const table = makeTable(seed());
  const baseV = table.read().updated;
  const A = { db: seed(), lastRowUpdated: baseV };
  const B = { db: table.read().data, lastRowUpdated: table.read().updated };
  B.db.tickets.push({id:'TKT-1003',title:'Payroll error',st:'in-progress',created:nowTs(),updated:nowTs(),log:[{type:'created',at:nowTs(),user:'B',msg:'c'}]}); B.db.seq=1003;
  fixedSave(table, B);
  findT(A.db,'TKT-1001').st='in-progress'; findT(A.db,'TKT-1001').updated=nowTs();
  fixedSave(table, A);
  const s = table.read().data;
  assert(!!findT(s,'TKT-1003') && findT(s,'TKT-1003').st==='in-progress', 'new in-progress TKT-1003 survives');
  assert(findT(s,'TKT-1001').st==='in-progress', "A's own edit also survives");
}

console.log('\nUnit tests on the extracted mergeState:');
{
  resetTombstones();
  let m = mergeState({tickets:[{id:'A',updated:'2026-01-01T00:00:05.000Z',created:'c1'},{id:'NEW',st:'in-progress',updated:'2026-01-01T00:00:06.000Z',created:'c2'}],seq:2},
                     {tickets:[{id:'A',updated:'2026-01-01T00:00:05.000Z',created:'c1'}],seq:1});
  assert(m.tickets.some(t=>t.id==='NEW'), 'remote-only ticket kept');
  assert(m.seq===2, 'seq takes max');

  resetTombstones();
  m = mergeState(
    {tickets:[{id:'A',st:'in-progress',created:'c',updated:'2026-01-01T00:02:00.000Z',log:[{type:'created',at:'1',user:'v',msg:'c'},{type:'status',at:'2026-01-01T00:01:00.000Z',user:'b',msg:'ip'}]}]},
    {tickets:[{id:'A',st:'open',       created:'c',updated:'2026-01-01T00:01:00.000Z',log:[{type:'created',at:'1',user:'v',msg:'c'},{type:'comment',at:'2026-01-01T00:00:30.000Z',user:'a',msg:'hi'}]}]});
  let A=m.tickets.find(t=>t.id==='A');
  assert(A.st==='in-progress','newer edit wins');
  assert(A.log.filter(l=>l.msg==='c').length===1,'duplicate log de-duped');
  assert(A.log.some(l=>l.msg==='hi')&&A.log.some(l=>l.msg==='ip'),'both distinct log entries preserved');

  sandbox.setT({tickets:{DEL:true},users:{},passwordRequests:{},departments:{}});
  m = mergeState({tickets:[{id:'A',created:'a'},{id:'DEL',created:'d'}]},{tickets:[{id:'A',created:'a'}]});
  assert(!m.tickets.some(t=>t.id==='DEL'),'tombstoned delete stays deleted');

  resetTombstones();
  m = mergeState({tickets:[{id:'TKT-1',title:'R',created:'2026-02-01T00:00:00.000Z'}],seq:1},
                 {tickets:[{id:'TKT-1',title:'L',created:'2026-02-01T00:00:05.000Z'}],seq:1});
  assert(m.tickets.length===2 && new Set(m.tickets.map(t=>t.id)).size===2,'id collision -> both kept, distinct ids');
  assert(m.seq>=2,'seq advanced past re-issued id');

  resetTombstones();
  m = mergeState({departments:[{name:'IT',subs:['Network']}]},{departments:[{name:'IT',subs:['Email']},{name:'HR',subs:[]}]});
  assert(m.departments.find(d=>d.name==='IT').subs.sort().join(',')==='Email,Network','dept subs unioned');
  assert(m.departments.some(d=>d.name==='HR'),'local-only dept kept');
}

console.log('\n' + '='.repeat(56));
console.log('SHIPPED-CODE RESULTS: ' + PASS + ' passed, ' + FAIL + ' failed');
console.log('='.repeat(56));
process.exit(FAIL ? 1 : 0);
