'use strict';
/*
 * Tests the "loop the Requester into @mention notifications" rule, extracted
 * from the sibling index.html. Confirms: (a) fires only when the comment has an
 * @mention, (b) adds the requester resolved to an account, (c) no duplicate when
 * the requester was already tagged, (d) never the comment author, (e) nothing
 * for account-less requesters. No network, no DOM.
 */
const fs=require('fs'), path=require('path'), vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

// Slice the feature-helper block (uid -> sweepAutoClose) which now contains
// requesterUserId + mentionRecipients.
const s=html.indexOf('function uid(prefix)');
const e0=html.indexOf('return changed;', s);
const e=html.indexOf('\n}', e0)+2;
const block=html.slice(s,e);

const sandbox={ console, Date, Math,
  esc:x=>String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
  userById:id=>(sandbox.db&&sandbox.db.users||[]).find(u=>u.id===id)||null,
  saveDB:function(){}, db:null };
vm.createContext(sandbox);
vm.runInContext(block+'\nthis.requesterUserId=requesterUserId;this.mentionRecipients=mentionRecipients;', sandbox);

let PASS=0,FAIL=0;
const assert=(c,m)=>{ if(c){PASS++;console.log('  ✓ '+m);} else {FAIL++;console.log('  ✗ FAIL: '+m);} };

const USERS=[
  {id:'u-alex',  name:'Alex Kim',    username:'alex',  email:'alex@homelandgroup.org'},
  {id:'u-bea',   name:'Bea Ortiz',   username:'bea',   email:'bea@homelandgroup.org'},
  {id:'u-req',   name:'Ravi Patel',  username:'ravi',  email:'ravi@homelandgroup.org'},
  {id:'u-me',    name:'Vivek',       username:'SA261', email:'vivek@homelandgroup.org'}
];
sandbox.db={ users:USERS };

const T_internal   = { id:'TKT-1', req:'Ravi Patel',  reqEmail:'ravi@homelandgroup.org' }; // requester = u-req
const T_emailOnly  = { id:'TKT-2', req:'R. Patel',    reqEmail:'ravi@homelandgroup.org' }; // name differs, email matches u-req
const T_public     = { id:'TKT-3', req:'Outside Person', reqEmail:'nobody@external.com' };  // no account
const T_reqIsAlex  = { id:'TKT-4', req:'Alex Kim',    reqEmail:'alex@homelandgroup.org' }; // requester = u-alex

const kinds = recs => recs.reduce((o,r)=>(o[r.uid]=r.kind,o),{});

console.log('requesterUserId resolution');
{
  assert(sandbox.requesterUserId(T_internal)==='u-req', 'resolves requester by exact name');
  assert(sandbox.requesterUserId(T_emailOnly)==='u-req', 'resolves requester by email when name differs');
  assert(sandbox.requesterUserId(T_public)===null, 'account-less requester resolves to null');
}

console.log('\nmentionRecipients rule');
{
  // (a) no @mention -> nobody notified
  let r=sandbox.mentionRecipients(T_internal, [], 'u-me');
  assert(r.length===0, 'comment with NO @mentions notifies no one (not even the requester)');

  // (b) @mention present -> tagged user + requester looped in
  r=sandbox.mentionRecipients(T_internal, ['u-alex'], 'u-me');
  let k=kinds(r);
  assert(r.length===2 && k['u-alex']==='mention' && k['u-req']==='requester',
    'tagged user is "mention" and requester is looped in as "requester"');

  // (c) requester already explicitly tagged -> no duplicate, stays a direct mention
  r=sandbox.mentionRecipients(T_internal, ['u-req','u-alex'], 'u-me');
  k=kinds(r);
  assert(r.length===2, 'no duplicate when requester was already @mentioned');
  assert(k['u-req']==='mention', 'directly-tagged requester keeps kind "mention", not "requester"');

  // (d) author is the requester -> requester not notified about their own comment
  r=sandbox.mentionRecipients(T_internal, ['u-alex'], 'u-req');
  k=kinds(r);
  assert(r.length===1 && k['u-alex']==='mention' && !('u-req' in k),
    'requester who authored the comment is not looped in');

  // author tagged themselves + someone else -> author excluded, requester still looped
  r=sandbox.mentionRecipients(T_internal, ['u-me','u-bea'], 'u-me');
  k=kinds(r);
  assert(!('u-me' in k) && k['u-bea']==='mention' && k['u-req']==='requester',
    'author excluded even if self-tagged; requester still looped in');

  // (e) account-less requester -> only the tagged user, no phantom requester entry
  r=sandbox.mentionRecipients(T_public, ['u-alex'], 'u-me');
  assert(r.length===1 && r[0].uid==='u-alex', 'account-less requester adds nobody extra');

  // requester resolved by email path also loops in
  r=sandbox.mentionRecipients(T_emailOnly, ['u-bea'], 'u-me');
  k=kinds(r);
  assert(k['u-req']==='requester', 'requester resolved via email is looped in');

  // requester == the tagged person via a different ticket (Alex is requester AND tagged)
  r=sandbox.mentionRecipients(T_reqIsAlex, ['u-alex'], 'u-me');
  assert(r.length===1 && r[0].uid==='u-alex' && r[0].kind==='mention',
    'when the only tagged user IS the requester, single "mention" entry (no dupe)');
}

console.log('\n'+'='.repeat(56));
console.log('REQUESTER-NOTIFY RESULTS: '+PASS+' passed, '+FAIL+' failed');
console.log('='.repeat(56));
process.exit(FAIL?1:0);
