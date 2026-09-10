'use strict';
/*
 * Faithful offline reproduction + tests for the Homeland Helpdesk
 * "disappearing in-progress tickets" bug.
 *
 * Part A: models the EXACT current storage semantics (whole-blob overwrite,
 *         no version guard) and drives the documented 2-client race to show
 *         an in-progress ticket vanish.
 * Part B: the proposed fix (optimistic compare-and-swap + union merge) run
 *         against the identical race, proving nothing is lost.
 * Part C: unit tests for mergeState covering the loss-critical cases.
 *
 * No network. Nothing here touches the live Supabase project.
 */

let PASS = 0, FAIL = 0;
function assert(cond, msg){
  if(cond){ PASS++; console.log('  ✓ ' + msg); }
  else { FAIL++; console.log('  ✗ FAIL: ' + msg); }
}
function section(t){ console.log('\n' + t); }

// ---------------------------------------------------------------------------
// A monotonic clock producing REAL ISO timestamps (exactly the shape the app
// uses: new Date().toISOString()), strictly increasing so ordering is stable.
// ---------------------------------------------------------------------------
const BASE_ISO = '2026-01-01T00:00:00.000Z';   // every seed ticket starts here
let _clock = Date.parse(BASE_ISO);
function nowTs(){ _clock += 1000; return new Date(_clock).toISOString(); }

// ---------------------------------------------------------------------------
// Mock of the single-row hg_state table.
//   - currentUpdate(): models CURRENT code  -> update(data).eq('id',1)
//                      = unconditional overwrite (THE BUG).
//   - casUpdate():     models THE FIX        -> ...eq('updated', guard).select()
//                      = write only if row unchanged since we read it.
// A realtime bus notifies subscribers on every committed write.
// ---------------------------------------------------------------------------
function makeTable(initialData){
  const row = { data: JSON.parse(JSON.stringify(initialData)), updated: nowTs() };
  const subs = [];
  return {
    read(){ return { data: JSON.parse(JSON.stringify(row.data)), updated: row.updated }; },
    subscribe(fn){ subs.push(fn); },
    _emit(){ const snap = this.read(); subs.forEach(fn => fn({ new: { data: snap.data, updated: snap.updated } })); },
    // CURRENT behavior: overwrite unconditionally.
    currentUpdate(data){
      row.data = JSON.parse(JSON.stringify(data));
      row.updated = nowTs();
      this._emit();
      return { matched: 1, updated: row.updated };
    },
    // FIX behavior: compare-and-swap on `updated`.
    casUpdate(data, guard){
      if(guard != null && guard !== row.updated){ return { matched: 0 }; }
      row.data = JSON.parse(JSON.stringify(data));
      row.updated = nowTs();
      this._emit();
      return { matched: 1, updated: row.updated };
    }
  };
}

// ===========================================================================
// MERGE HELPERS  (exactly as they will be inserted into index.html)
// ===========================================================================
var _tombstones = { tickets:{}, users:{}, passwordRequests:{}, departments:{} };
function _resetTombstones(){ _tombstones = { tickets:{}, users:{}, passwordRequests:{}, departments:{} }; }

function _logSig(l){ return [l.type, l.at, l.user, l.msg, (l.image?'img':'')].join('|'); }
function _mergeLogs(a, b){
  a = Array.isArray(a) ? a : []; b = Array.isArray(b) ? b : [];
  var seen = {}, out = [];
  a.concat(b).forEach(function(l){
    if(!l) return;
    var k = _logSig(l);
    if(seen[k]) return;
    seen[k] = 1; out.push(l);
  });
  out.sort(function(x, y){ return new Date(x.at||0) - new Date(y.at||0); });
  return out;
}
// a is "newer or equal" to b by its own updated/at stamp
function _newer(a, b){
  var ta = new Date((a && (a.updated || a.at)) || 0).getTime();
  var tb = new Date((b && (b.updated || b.at)) || 0).getTime();
  return ta >= tb;
}
function _mergeById(remoteArr, localArr, idKey, tombstones, opts){
  remoteArr = Array.isArray(remoteArr) ? remoteArr : [];
  localArr  = Array.isArray(localArr)  ? localArr  : [];
  tombstones = tombstones || {};
  opts = opts || {};
  var byId = {}, order = [];
  function put(item){
    if(!item) return;
    var id = item[idKey];
    if(id == null) return;
    if(tombstones[id]) return;                 // explicitly deleted this session -> never resurrect
    if(!(id in byId)){ byId[id] = item; order.push(id); return; }
    var cur = byId[id];
    var winner = _newer(item, cur) ? item : cur;
    if(opts.mergeLogs){
      winner = Object.assign({}, winner);
      winner.log = _mergeLogs(cur.log, item.log);   // never drop a comment / status entry
    }
    byId[id] = winner;
  }
  remoteArr.forEach(put);   // remote first
  localArr.forEach(put);    // local second (ties -> local, the actor, wins)
  return order.map(function(id){ return byId[id]; });
}
function _mergeDepartments(r, l, tombstones){
  r = Array.isArray(r) ? r : []; l = Array.isArray(l) ? l : [];
  tombstones = tombstones || {};
  var byName = {}, order = [];
  function put(d){
    if(!d || !d.name) return;
    if(tombstones[d.name]) return;                 // department removed this session
    var subs = Array.isArray(d.subs) ? d.subs : [];
    if(!(d.name in byName)){ byName[d.name] = { name: d.name, subs: subs.slice() }; order.push(d.name); }
    else { subs.forEach(function(s){ if(byName[d.name].subs.indexOf(s) === -1) byName[d.name].subs.push(s); }); }
  }
  r.forEach(put); l.forEach(put);
  return order.map(function(n){ return byName[n]; });
}
// Pick the surviving version of two tickets that share an id AND are the same
// ticket (same created): newest wins on scalars, logs are unioned.
function _pickTicket(cur, item){
  var winner = _newer(item, cur) ? item : cur;
  winner = Object.assign({}, winner);
  winner.log = _mergeLogs(cur.log, item.log);
  return winner;
}
// Tickets get special handling: same id + DIFFERENT created = an ID collision
// from two stale clients each calling ++seq. Keep BOTH by re-id-ing the local one.
function _mergeTickets(remote, local, tombstones, seqRef){
  remote = Array.isArray(remote) ? remote : []; local = Array.isArray(local) ? local : [];
  tombstones = tombstones || {};
  var byId = {}, order = [];
  function sameTicket(a, b){ return (a.created||'') === (b.created||''); }
  remote.forEach(function(t){
    if(!t || t.id == null || tombstones[t.id]) return;
    if(!(t.id in byId)){ byId[t.id] = t; order.push(t.id); }
    else { byId[t.id] = _pickTicket(byId[t.id], t); }
  });
  local.forEach(function(t){
    if(!t || t.id == null || tombstones[t.id]) return;
    if((t.id in byId) && !sameTicket(byId[t.id], t)){
      var newId = 'TKT-' + (++seqRef.v);       // collision: distinct tickets, same id -> re-id local
      t = Object.assign({}, t, { id: newId });
      byId[newId] = t; order.push(newId);
      return;
    }
    if(!(t.id in byId)){ byId[t.id] = t; order.push(t.id); }
    else { byId[t.id] = _pickTicket(byId[t.id], t); }
  });
  return order.map(function(id){ return byId[id]; });
}
// Union-merge remote (canonical) with local (our in-memory) so nothing is dropped.
function mergeState(remote, local){
  remote = remote || {}; local = local || {};
  var out = {};
  var seqRef = { v: Math.max(Number(remote.seq)||0, Number(local.seq)||0) };   // IDs never go backwards
  out.tickets          = _mergeTickets(remote.tickets, local.tickets, _tombstones.tickets, seqRef);
  out.users            = _mergeById(remote.users,            local.users,            'id', _tombstones.users,            {});
  out.passwordRequests = _mergeById(remote.passwordRequests, local.passwordRequests, 'id', _tombstones.passwordRequests, {});
  out.departments      = _mergeDepartments(remote.departments, local.departments, _tombstones.departments);
  out.seq              = seqRef.v;   // reflects any collision re-ids handed out
  Object.keys(remote).forEach(function(k){ if(!(k in out)) out[k] = remote[k]; });
  Object.keys(local ).forEach(function(k){ if(!(k in out)) out[k] = local[k];  });
  return out;
}

// ===========================================================================
// A minimal "client" holding its own in-memory db + lastRowUpdated, wired to
// the mock table's realtime bus -- mirroring index.html's globals.
// ===========================================================================
function makeClient(table, mode){
  const c = {
    db: table.read().data,
    lastRowUpdated: table.read().updated,
    mode: mode // 'current' or 'fixed'
  };
  // realtime: current code REPLACES; fix also REPLACES local from canonical
  // server state (safe, because writes are merge-protected) + tracks version.
  table.subscribe(function(payload){
    if(!payload.new || !payload.new.data) return;
    if(c.mode === 'current'){
      c.db = payload.new.data;                       // wholesale replace (index.html:1425)
    } else {
      c.db = payload.new.data;                       // canonical server state is already the union
      c.lastRowUpdated = payload.new.updated;
    }
  });
  c.save = function(){
    if(c.mode === 'current'){
      table.currentUpdate(c.db);                     // index.html:1452 -- clobbers
      return;
    }
    // FIX: compare-and-swap; on conflict re-fetch, merge, retry.
    for(let attempt = 0; attempt < 10; attempt++){
      const res = table.casUpdate(c.db, c.lastRowUpdated);
      if(res.matched){ c.lastRowUpdated = res.updated; return; }
      const fresh = table.read();
      c.db = mergeState(fresh.data, c.db);           // union -> nothing dropped
      c.lastRowUpdated = fresh.updated;
    }
    throw new Error('save did not converge');
  };
  return c;
}

// A tiny seed DB with two tickets.
function seed(){
  return {
    users: [{ id:'U-ADMIN', name:'Vivek', role:'superadmin' }],
    tickets: [
      { id:'TKT-1001', title:'VPN down',      st:'open', updated:BASE_ISO, log:[{type:'created',at:BASE_ISO,user:'Vivek',msg:'created'}] },
      { id:'TKT-1002', title:'Laptop broken', st:'open', updated:BASE_ISO, log:[{type:'created',at:BASE_ISO,user:'Vivek',msg:'created'}] }
    ],
    passwordRequests: [],
    departments: [{ name:'IT', subs:['Network'] }],
    seq: 1002
  };
}
const findT = (db, id) => (db.tickets || []).find(t => t.id === id);

// ===========================================================================
// PART A -- reproduce the bug with the CURRENT semantics
// ===========================================================================
section('PART A  — Reproduce with CURRENT code (whole-blob overwrite, no guard)');
{
  _clock = Date.parse(BASE_ISO); _resetTombstones();
  const table = makeTable(seed());
  const baseVersion = table.read().updated;   // the snapshot both clients loaded

  // Manager A has the board open on the baseline snapshot, and (crucially) does
  // NOT receive B's realtime update in time (throttled/dropped/offline blip).
  const A = { db: seed(), lastRowUpdated: baseVersion, mode:'current' };
  A.save = () => { table.currentUpdate(A.db); };

  // Admin B marks TKT-1002 in-progress and saves.
  const B = makeClient(table, 'current');
  findT(B.db, 'TKT-1002').st = 'in-progress';
  findT(B.db, 'TKT-1002').updated = nowTs();
  findT(B.db, 'TKT-1002').log.push({ type:'status', at:nowTs(), user:'AdminB', msg:'open -> in-progress' });
  B.save();

  // A, still on the stale snapshot, just adds a comment to a DIFFERENT ticket
  // and saves -- an ordinary, unrelated action.
  findT(A.db, 'TKT-1001').log.push({ type:'comment', at:nowTs(), user:'ManagerA', msg:'looking into it' });
  findT(A.db, 'TKT-1001').updated = nowTs();
  A.save();   // <-- clobbers the whole row with A's stale copy

  const server = table.read().data;
  const t2 = findT(server, 'TKT-1002');
  console.log('  server TKT-1002 status after the race:', t2 ? t2.st : '(GONE)');
  assert(t2 && t2.st === 'open',
    "BUG REPRODUCED: B's in-progress change on TKT-1002 was silently reverted by A's stale save");
}

// ===========================================================================
// PART B -- identical race, with the FIX
// ===========================================================================
section('PART B  — Identical race with the FIX (compare-and-swap + union merge)');
{
  _clock = Date.parse(BASE_ISO); _resetTombstones();
  const table = makeTable(seed());
  const baseVersion = table.read().updated;

  // A on the stale baseline (same blind spot as Part A), now with the FIX.
  const A = { db: seed(), lastRowUpdated: baseVersion, mode:'fixed' };
  A.save = function(){
    for(let attempt = 0; attempt < 10; attempt++){
      const res = table.casUpdate(A.db, A.lastRowUpdated);
      if(res.matched){ A.lastRowUpdated = res.updated; return; }
      const fresh = table.read();
      A.db = mergeState(fresh.data, A.db);
      A.lastRowUpdated = fresh.updated;
    }
    throw new Error('save did not converge');
  };

  const B = makeClient(table, 'fixed');
  findT(B.db, 'TKT-1002').st = 'in-progress';
  findT(B.db, 'TKT-1002').updated = nowTs();
  findT(B.db, 'TKT-1002').log.push({ type:'status', at:nowTs(), user:'AdminB', msg:'open -> in-progress' });
  B.save();

  findT(A.db, 'TKT-1001').log.push({ type:'comment', at:nowTs(), user:'ManagerA', msg:'looking into it' });
  findT(A.db, 'TKT-1001').updated = nowTs();
  A.save();   // CAS guard fails -> re-fetch -> merge -> retry

  const server = table.read().data;
  const t1 = findT(server, 'TKT-1001');
  const t2 = findT(server, 'TKT-1002');
  assert(t2 && t2.st === 'in-progress', 'TKT-1002 keeps its in-progress status');
  assert(t1 && t1.log.some(l => l.msg === 'looking into it'), "A's comment on TKT-1001 survives");
  assert(t2 && t2.log.some(l => l.msg === 'open -> in-progress'), "B's status-change log survives");
}

// ===========================================================================
// PART A2 / B2 -- a whole NEW in-progress ticket vanishing (the literal report)
// ===========================================================================
section('PART A2 — CURRENT code: a brand-new in-progress ticket DISAPPEARS');
{
  _clock = Date.parse(BASE_ISO); _resetTombstones();
  const table = makeTable(seed());
  const baseVersion = table.read().updated;

  const A = { db: seed(), lastRowUpdated: baseVersion };
  A.save = () => { table.currentUpdate(A.db); };

  // B logs a new query and immediately starts working it (in-progress).
  const B = makeClient(table, 'current');
  B.db.tickets.push({ id:'TKT-1003', title:'Payroll portal error', st:'in-progress',
                      updated:nowTs(), log:[{type:'created',at:nowTs(),user:'AdminB',msg:'created'}] });
  B.db.seq = 1003;
  B.save();

  // A, still stale, saves an unrelated edit -> clobbers TKT-1003 out of existence.
  findT(A.db, 'TKT-1001').st = 'in-progress';
  findT(A.db, 'TKT-1001').updated = nowTs();
  A.save();

  const server = table.read().data;
  console.log('  is TKT-1003 on the server?', !!findT(server, 'TKT-1003'));
  assert(!findT(server, 'TKT-1003'),
    "BUG REPRODUCED: brand-new in-progress TKT-1003 vanished from the shared board");
}

section('PART B2 — FIX: the same new in-progress ticket survives');
{
  _clock = Date.parse(BASE_ISO); _resetTombstones();
  const table = makeTable(seed());
  const baseVersion = table.read().updated;

  const A = { db: seed(), lastRowUpdated: baseVersion };
  A.save = function(){
    for(let attempt = 0; attempt < 10; attempt++){
      const res = table.casUpdate(A.db, A.lastRowUpdated);
      if(res.matched){ A.lastRowUpdated = res.updated; return; }
      const fresh = table.read();
      A.db = mergeState(fresh.data, A.db);
      A.lastRowUpdated = fresh.updated;
    }
    throw new Error('save did not converge');
  };

  const B = makeClient(table, 'fixed');
  B.db.tickets.push({ id:'TKT-1003', title:'Payroll portal error', st:'in-progress',
                      updated:nowTs(), log:[{type:'created',at:nowTs(),user:'AdminB',msg:'created'}] });
  B.db.seq = 1003;
  B.save();

  findT(A.db, 'TKT-1001').st = 'in-progress';
  findT(A.db, 'TKT-1001').updated = nowTs();
  A.save();

  const server = table.read().data;
  assert(!!findT(server, 'TKT-1003'), 'TKT-1003 is still on the board');
  assert(findT(server, 'TKT-1003').st === 'in-progress', 'TKT-1003 keeps its in-progress status');
  assert(findT(server, 'TKT-1001').st === 'in-progress', "A's own edit to TKT-1001 is also kept");
  assert(server.seq === 1003, 'seq reflects the merged-in ticket');
}

// ===========================================================================
// PART C -- unit tests for mergeState (loss-critical cases)
// ===========================================================================
section('PART C  — mergeState unit tests');
{
  // 1. Other client's brand-new ticket must survive a stale local save.
  _resetTombstones();
  let remote = { tickets:[{id:'A',st:'open',updated:'5'},{id:'NEW',st:'in-progress',updated:'6'}], seq:2 };
  let local  = { tickets:[{id:'A',st:'open',updated:'5'}], seq:1 };
  let m = mergeState(remote, local);
  assert(m.tickets.some(t => t.id === 'NEW'), 'remote-only ticket NEW is kept');
  assert(m.seq === 2, 'seq takes the max (no future ID reuse)');

  // 2. Same ticket edited on both sides -> newest wins, logs unioned, no dupes.
  _resetTombstones();
  remote = { tickets:[{id:'A',st:'in-progress',updated:'10',log:[{type:'created',at:'1',user:'v',msg:'c'},{type:'status',at:'9',user:'b',msg:'to in-progress'}]}] };
  local  = { tickets:[{id:'A',st:'open',       updated:'8', log:[{type:'created',at:'1',user:'v',msg:'c'},{type:'comment',at:'7',user:'a',msg:'hi'}]}] };
  m = mergeState(remote, local);
  let A = m.tickets.find(t => t.id === 'A');
  assert(A.st === 'in-progress', 'newer side (in-progress) wins the status');
  assert(A.log.filter(l => l.msg === 'c').length === 1, 'duplicate "created" log entry is de-duped');
  assert(A.log.some(l => l.msg === 'hi') && A.log.some(l => l.msg === 'to in-progress'),
    'both sides\' distinct log entries are preserved');

  // 3. A ticket the local session explicitly DELETED is honored, not resurrected.
  _resetTombstones(); _tombstones.tickets['DEL'] = true;
  remote = { tickets:[{id:'A',st:'open',updated:'5'},{id:'DEL',st:'open',updated:'5'}] };
  local  = { tickets:[{id:'A',st:'open',updated:'5'}] };
  m = mergeState(remote, local);
  assert(!m.tickets.some(t => t.id === 'DEL'), 'tombstoned (deleted) ticket stays deleted');

  // 4. A local-only ticket that is NOT tombstoned (a fresh create) is kept.
  _resetTombstones();
  remote = { tickets:[{id:'A',st:'open',updated:'5'}] };
  local  = { tickets:[{id:'A',st:'open',updated:'5'},{id:'MINE',st:'open',updated:'6'}] };
  m = mergeState(remote, local);
  assert(m.tickets.some(t => t.id === 'MINE'), 'fresh local ticket is kept');

  // 5. Idempotence / order-independence.
  _resetTombstones();
  remote = { tickets:[{id:'A',st:'in-progress',updated:'10'},{id:'B',st:'open',updated:'4'}], seq:9 };
  local  = { tickets:[{id:'A',st:'open',updated:'8'},{id:'C',st:'open',updated:'11'}], seq:12 };
  let once = mergeState(remote, local);
  let twice = mergeState(once, once);
  assert(JSON.stringify(twice.tickets.map(t=>t.id).sort()) === JSON.stringify(['A','B','C']),
    'merge is stable/idempotent on ticket set');
  assert(twice.tickets.find(t=>t.id==='A').st === 'in-progress', 'idempotent: A stays in-progress');
  assert(twice.seq === 12, 'idempotent: seq stays at max');

  // 6. Departments union their sub-categories.
  _resetTombstones();
  remote = { departments:[{name:'IT',subs:['Network']}] };
  local  = { departments:[{name:'IT',subs:['Email']},{name:'HR',subs:[]}] };
  m = mergeState(remote, local);
  let it = m.departments.find(d=>d.name==='IT');
  assert(it.subs.includes('Network') && it.subs.includes('Email'), 'IT sub-categories from both sides are unioned');
  assert(m.departments.some(d=>d.name==='HR'), 'HR department (local-only) is kept');

  // 7. ID collision: two DIFFERENT tickets both created as TKT-1003 by stale clients.
  _resetTombstones();
  remote = { tickets:[{id:'TKT-1003',title:'Remote ticket',created:'2026-02-01T00:00:00.000Z',updated:'2026-02-01T00:00:00.000Z',log:[]}], seq:1003 };
  local  = { tickets:[{id:'TKT-1003',title:'Local ticket', created:'2026-02-01T00:00:05.000Z',updated:'2026-02-01T00:00:05.000Z',log:[]}], seq:1003 };
  m = mergeState(remote, local);
  assert(m.tickets.length === 2, 'both colliding tickets are kept (neither dropped)');
  assert(m.tickets.some(t=>t.title==='Remote ticket') && m.tickets.some(t=>t.title==='Local ticket'),
    'both distinct titles survive the id collision');
  assert(new Set(m.tickets.map(t=>t.id)).size === 2, 'the two tickets now have distinct ids');
  assert(m.seq >= 1004, 'seq advanced past the re-issued id');

  // 8. Same id + SAME created (a normal concurrent edit, not a collision) -> merged, not duplicated.
  _resetTombstones();
  remote = { tickets:[{id:'TKT-1003',title:'T',st:'in-progress',created:'2026-02-01T00:00:00.000Z',updated:'2026-02-01T00:01:00.000Z',log:[]}], seq:1003 };
  local  = { tickets:[{id:'TKT-1003',title:'T',st:'open',       created:'2026-02-01T00:00:00.000Z',updated:'2026-02-01T00:00:30.000Z',log:[]}], seq:1003 };
  m = mergeState(remote, local);
  assert(m.tickets.length === 1, 'same ticket edited concurrently is merged, not split');
  assert(m.tickets[0].st === 'in-progress', 'newer concurrent edit wins');
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(60));
console.log('RESULTS: ' + PASS + ' passed, ' + FAIL + ' failed');
console.log('='.repeat(60));
process.exit(FAIL ? 1 : 0);
