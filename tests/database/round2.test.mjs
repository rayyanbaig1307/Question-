import {after,before,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {asUser,createLocalDatabase,friend,seedUsers} from './local-db.mjs';
let db,users;
before(async()=>{db=await createLocalDatabase({includeFixes:process.env.QA_ORIGINAL!=='1'});});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('truncate auth.users cascade; truncate storage.objects,net.sent restart identity;');users=await seedUsers(db);});
const rpc=(i,sql,args=[])=>asUser(db,users[i],tx=>tx.query(sql,args));
const server=(sql,args=[])=>asUser(db,null,tx=>tx.query(sql,args),'service_role');
const reject=(run)=>assert.rejects(run,/security|permission|constraint|violat|gone|not|only|invalid|yours|unavailable/i);
async function group(members=[1,2]){
  for(const i of members)await friend(db,users[0],users[i]);
  return (await rpc(0,"select create_peek_group('QA new group',$1::uuid[],current_date) as id",[members.map(i=>users[i])])).rows[0].id;
}
async function msg(i=0,j=1,extra={}){
  await friend(db,users[i],users[j]);
  const fields={sender_id:users[i],recipient_id:users[j],kind:'text',body:'hello',...extra};
  const keys=Object.keys(fields);
  return (await rpc(i,`insert into messages(${keys}) values(${keys.map((_,n)=>`$${n+1}`)}) returning *`,Object.values(fields))).rows[0];
}
async function gm(grp,i=0,extra={}){
  const fields={group_id:grp,sender_id:users[i],kind:'text',body:'hello group',...extra};const keys=Object.keys(fields);
  return (await rpc(i,`insert into group_messages(${keys}) values(${keys.map((_,n)=>`$${n+1}`)}) returning *`,Object.values(fields))).rows[0];
}
async function oldStory(i=0){
  const path=`${users[i]}/stories/${randomUUID()}.jpg`;
  await rpc(i,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
  const story=(await rpc(i,'insert into stories(user_id,media_path) values($1,$2) returning id',[users[i],path])).rows[0];
  await db.query("update stories set expires_at=now()-interval '8 days' where id=$1",[story.id]);
  return {id:story.id,path};
}

test('OAuth hook trusts server app metadata and rejects user metadata spoofing',async()=>{
  const run=event=>asUser(db,null,tx=>tx.query('select hook_only_apple_or_google_sign_ups($1) as result',[event]),'supabase_auth_admin');
  for(const provider of ['apple','google'])assert.deepEqual((await run({user:{app_metadata:{provider}}})).rows[0].result,{});
  assert.equal((await run({user:{user_metadata:{provider:'google'},app_metadata:{provider:'email'}}})).rows[0].result.error.http_code,403);
});
test('App users cannot invoke the auth creation hook',async()=>{await reject(()=>rpc(0,"select hook_only_apple_or_google_sign_ups('{}'::jsonb)"));});
test('OAuth names create valid profiles and unicode-only names get a safe fallback',async()=>{
  for(const meta of [{full_name:'Alex Smith'},{name:'🙂👀'},{display_name:'x'.repeat(200)}]){
    const id=randomUUID();await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[id,meta]);
    const p=(await db.query('select username,display_name from profiles where id=$1',[id])).rows[0];
    assert.match(p.username,/^[a-z0-9_.]{3,20}$/);assert.ok(p.display_name.length<=40);
  }
});
test('Activity cannot reveal replies on posts that became private',async()=>{
  const p=(await rpc(0,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[0],`${users[0]}/posts/a.jpg`])).rows[0].id;
  const c=(await rpc(1,"insert into comments(user_id,post_id,body) values($1,$2,'old public comment') returning id",[users[1],p])).rows[0].id;
  await friend(db,users[0],users[2]);await rpc(0,'update profiles set is_private=true where id=$1',[users[0]]);
  await rpc(2,"insert into comments(user_id,post_id,parent_id,body) values($1,$2,$3,'new private secret')",[users[2],p,c]);
  assert.equal((await rpc(1,'select * from posts where id=$1',[p])).rows.length,0);
  assert.equal((await rpc(1,'select * from my_activity()')).rows.length,0);
});
test('Activity excludes self actions and blocked actors',async()=>{
  const p=(await rpc(0,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[0],`${users[0]}/posts/a.jpg`])).rows[0].id;
  for(const i of [0,1])await rpc(i,'insert into likes(user_id,post_id) values($1,$2)',[users[i],p]);
  assert.equal((await rpc(0,'select * from my_activity()')).rows.length,1);
  await rpc(0,'select block_user($1)',[users[1]]);
  assert.equal((await rpc(0,'select * from my_activity()')).rows.length,0);
});
test('Delete for me is enforced for direct database reads',async()=>{
  const m=await msg();await rpc(1,'select hide_message($1)',[m.id]);
  assert.equal((await rpc(1,'select * from messages where id=$1',[m.id])).rows.length,0);
  assert.equal((await rpc(0,'select * from messages where id=$1',[m.id])).rows.length,1);
});
test('Clear chat hides old messages only for its caller and new messages still show',async()=>{
  await msg();await msg(1,0);assert.equal((await rpc(1,'select clear_chat($1) as n',[users[0]])).rows[0].n,2);
  assert.equal((await rpc(1,'select * from messages')).rows.length,0);
  assert.equal((await rpc(0,'select * from messages')).rows.length,2);
  await msg();assert.equal((await rpc(1,'select * from messages')).rows.length,1);
});
test('Third parties cannot hide someone else\'s messages or read hide rows',async()=>{
  const m=await msg();await reject(()=>rpc(2,'select hide_message($1)',[m.id]));
  await rpc(1,'select hide_message($1)',[m.id]);assert.equal((await rpc(2,'select * from message_hides')).rows.length,0);
});
test('Hidden messages do not leak through reactions',async()=>{
  const m=await msg();await rpc(0,"insert into message_reactions(message_id,user_id,emoji) values($1,$2,'👍')",[m.id,users[0]]);
  await rpc(1,'select hide_message($1)',[m.id]);assert.equal((await rpc(1,'select * from message_reactions')).rows.length,0);
});
test('Hidden snap references still prevent sender cleanup of unread/saved media',async()=>{
  const path=`${users[0]}/snaps/shared.jpg`;const m=await msg(0,1,{kind:'snap',body:null,media_path:path});
  await rpc(0,'select hide_message($1)',[m.id]);
  assert.equal((await rpc(0,'select can_cleanup_snap($1) as ok',[path])).rows[0].ok,false);
});
test('Snap cleanup cannot target someone else and protects report evidence',async()=>{
  const path=`${users[0]}/snaps/old.jpg`;const m=await msg(0,1,{kind:'snap',body:null,media_path:path});
  await db.query("update messages set opened_at=now()-interval '2 days' where id=$1",[m.id]);
  await rpc(1,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'message',$3,'spam')",[users[1],users[0],m.id]);
  assert.equal((await rpc(0,'select can_cleanup_snap($1) as ok',[path])).rows[0].ok,false);
  assert.equal((await rpc(1,'select can_cleanup_snap($1) as ok',[path])).rows[0].ok,false);
});
test('Chat dares cannot be precompleted by sender or confirmed by recipient',async()=>{
  const m=await msg(0,1,{kind:'dare',body:'Wear a hat',dare_state:'done',dare_done_at:new Date()});assert.equal(m.dare_state,null);
  await reject(()=>rpc(1,'select confirm_chat_dare($1,true)',[m.id]));
  await rpc(1,'select claim_chat_dare($1)',[m.id]);await rpc(0,'select confirm_chat_dare($1,true)',[m.id]);
  assert.equal((await rpc(0,'select chat_dare_streak($1) as n',[users[1]])).rows[0].n,1);
});
test('Blocked users cannot use chat-dare RPCs to signal each other',async()=>{
  const m=await msg(0,1,{kind:'dare',body:'Wear a hat'});await rpc(0,'select block_user($1)',[users[1]]);
  await reject(()=>rpc(1,'select claim_chat_dare($1)',[m.id]));
});
test('Only group members can read/write and removed members lose media access',async()=>{
  const g=await group();const m=await gm(g,0,{kind:'photo',body:null,media_path:`${users[0]}/group/a.jpg`,media_type:'photo'});
  assert.equal((await rpc(3,'select * from group_messages')).rows.length,0);await reject(()=>gm(g,3));
  assert.equal((await rpc(1,'select private.can_read_media($1) as ok',[m.media_path])).rows[0].ok,true);
  await rpc(0,'delete from peek_group_members where group_id=$1 and user_id=$2',[g,users[1]]);
  assert.equal((await rpc(1,'select * from group_messages')).rows.length,0);
  assert.equal((await rpc(1,'select private.can_read_media($1) as ok',[m.media_path])).rows[0].ok,false);
});
test('Group messages and summaries hide blocked senders without removing members',async()=>{
  const g=await group();await gm(g,0);await rpc(1,'select block_user($1)',[users[0]]);
  assert.equal((await rpc(1,'select * from group_messages')).rows.length,0);
  const summary=(await rpc(1,'select * from my_group_chats()')).rows[0];assert.equal(summary.last_sender,null);assert.equal(summary.unread,0);
  assert.equal((await db.query('select count(*)::int as n from peek_group_members where group_id=$1',[g])).rows[0].n,3);
});
test('Blocked senders\' group photos are unreadable just like voice notes',async()=>{
  const g=await group();const m=await gm(g,0,{kind:'photo',body:null,media_path:`${users[0]}/group/a.jpg`,media_type:'photo'});
  await rpc(1,'select block_user($1)',[users[0]]);assert.equal((await rpc(1,'select private.can_read_media($1) as ok',[m.media_path])).rows[0].ok,false);
});
test('Group replies cannot attach another group\'s message',async()=>{
  const a=await group([1]);const b=await group([2]);const first=await gm(a);
  const reply=await gm(b,0,{reply_to:first.id});assert.equal(reply.reply_to,null);
});
test('One-to-one replies cannot attach another conversation',async()=>{
  const a=await msg();const b=await msg(0,2,{reply_to:a.id});assert.equal(b.reply_to,null);
});
test('Group proof must belong to a dare in the same group',async()=>{
  const a=await group([1]);const b=await group([2]);const dare=await gm(a,0,{kind:'dare',body:'Wear a hat'});
  await reject(()=>gm(b,0,{kind:'proof',body:null,dare_id:dare.id,media_path:`${users[0]}/group/proof.jpg`,media_type:'photo'}));
  await gm(a,1,{kind:'proof',body:null,dare_id:dare.id,media_path:`${users[1]}/group/proof.jpg`,media_type:'photo'});
});
test('Group voice messages require recording and bounded audio/waveform values',async()=>{
  const g=await group();await reject(()=>gm(g,0,{kind:'voice',body:null,audio_ms:1000}));
  for(const extra of [{audio_ms:-1},{audio_ms:120001},{waveform:[-1]},{waveform:[101]},{waveform:[null]}])await reject(()=>gm(g,0,{kind:'voice',body:null,media_path:`${users[0]}/voice/a.m4a`,audio_ms:1000,...extra}));
});
test('Group sender cannot forge future message time',async()=>{
  const g=await group();const m=await gm(g,0,{created_at:'2099-01-01'});assert.ok(Math.abs(Date.now()-new Date(m.created_at))<10000);
});
test('Group photos cannot point at another member\'s files',async()=>{
  const g=await group();await reject(()=>gm(g,0,{kind:'photo',body:null,media_path:`${users[1]}/group/a.jpg`,media_type:'photo'}));
});
test('Group reactions are member-only, one per user, and block-aware',async()=>{
  const g=await group();const m=await gm(g);await reject(()=>rpc(3,"insert into group_message_reactions(message_id,user_id,emoji) values($1,$2,'👍')",[m.id,users[3]]));
  await rpc(1,"insert into group_message_reactions(message_id,user_id,emoji) values($1,$2,'👍')",[m.id,users[1]]);
  await rpc(1,"update group_message_reactions set emoji='🔥' where message_id=$1",[m.id]);
  assert.equal((await rpc(0,'select * from group_message_reactions')).rows.length,1);
  await rpc(1,'select block_user($1)',[users[0]]);assert.equal((await rpc(1,'select * from group_message_reactions')).rows.length,0);
});
test('Group pin/photo changes require membership and pin must be same-group',async()=>{
  const a=await group([1]);const b=await group([2]);const m=await gm(a);await reject(()=>rpc(3,'select pin_group_message($1,$2)',[a,m.id]));
  await reject(()=>rpc(0,'select pin_group_message($1,$2)',[b,m.id]));
  await rpc(1,'select pin_group_message($1,$2)',[a,m.id]);assert.equal((await rpc(1,'select pinned_message_id from peek_groups where id=$1',[a])).rows[0].pinned_message_id,m.id);
  await rpc(1,'select pin_group_message($1,null)',[a]);
  await reject(()=>rpc(1,'select set_group_photo($1,$2)',[a,`${users[0]}/avatar.jpg`]));
});
test('Group read/mute settings apply only to the caller\'s membership',async()=>{
  const g=await group();await rpc(1,'select set_group_chat_muted($1,true)',[g]);await rpc(1,'select mark_group_chat_read($1)',[g]);
  assert.equal((await rpc(1,'select * from my_group_chats()')).rows[0].muted,true);
  assert.equal((await rpc(0,'select * from my_group_chats()')).rows[0].muted,false);
  assert.equal((await rpc(3,'select * from my_group_chats()')).rows.length,0);
});
test('Group typing channel authorization ends when membership ends',async()=>{
  const g=await group();assert.equal((await rpc(1,'select private.can_use_group_typing_topic($1) as ok',[`typing-group:${g}`])).rows[0].ok,true);
  await rpc(1,'delete from peek_group_members where group_id=$1 and user_id=$2',[g,users[1]]);
  assert.equal((await rpc(1,'select private.can_use_group_typing_topic($1) as ok',[`typing-group:${g}`])).rows[0].ok,false);
});
test('Group reports keep the offending message id and canonical sender',async()=>{
  const g=await group();const m=await gm(g);
  const report=(await rpc(1,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'group_message',$3,'spam') returning *",[users[1],users[2],m.id])).rows[0];
  assert.equal(report.content_id,m.id);assert.equal(report.reported_user_id,users[0]);
  await reject(()=>rpc(3,"insert into reports(reporter_id,content_type,content_id,reason) values($1,'group_message',$2,'spam')",[users[3],m.id]));
});
test('Cleanup candidates are server-only and expired unreported story is eligible',async()=>{
  const s=await oldStory();await reject(()=>rpc(0,'select * from media_cleanup_candidates(100)'));
  assert.deepEqual((await server('select name from media_cleanup_candidates(100)')).rows,[{name:s.path}]);
});
test('Cleanup retains reported media and all group-chat references',async()=>{
  const s=await oldStory();await rpc(1,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'story',$3,'spam')",[users[1],users[0],s.id]);
  assert.deepEqual((await server('select name from media_cleanup_candidates(100)')).rows,[]);
  await db.exec('delete from reports');const g=await group();
  await gm(g,0,{kind:'photo',body:null,media_path:s.path,media_type:'photo'});
  assert.deepEqual((await server('select name from media_cleanup_candidates(100)')).rows,[]);
});
test('Cleanup keeps saved/unopened peeks and never touches voice notes',async()=>{
  const paths=[];
  for(const [kind,opened,saved] of [['snap',false,false],['snap',true,true],['voice',true,false]]){
    const path=`${users[0]}/${kind==='voice'?'voice':'snaps'}/${randomUUID()}`;paths.push(path);
    await rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
    const m=await msg(0,1,{kind,body:null,media_path:path,...(kind==='voice'?{audio_ms:1000}:{})});
    if(opened)await db.query("update messages set opened_at=now()-interval '8 days',saved_at=case when $2::boolean then now() end where id=$1",[m.id,saved]);
  }
  assert.deepEqual((await server('select name from media_cleanup_candidates(100)')).rows,[]);
});
test('Cleanup claim is revalidated at Storage metadata deletion after a report',async()=>{
  const s=await oldStory();assert.deepEqual((await server('select name from claim_media_cleanup(100)')).rows,[{name:s.path}]);
  await rpc(1,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'story',$3,'spam')",[users[1],users[0],s.id]);
  await assert.rejects(()=>server("delete from storage.objects where bucket_id='media' and name=$1",[s.path]),/Cleanup cancelled/);
  assert.equal((await db.query('select name from storage.objects where name=$1',[s.path])).rows.length,1);
});
test('Cleanup claim is revalidated after a new Keep and blocks reuse after logical deletion',async()=>{
  const s=await oldStory();await server('select name from claim_media_cleanup(100)');
  await rpc(0,"insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')",[users[0],s.path]);
  await assert.rejects(()=>server("delete from storage.objects where bucket_id='media' and name=$1",[s.path]),/Cleanup cancelled/);assert.equal((await db.query('select name from storage.objects where name=$1',[s.path])).rows.length,1);
  await rpc(0,'delete from keeps where media_path=$1',[s.path]);await server("delete from storage.objects where bucket_id='media' and name=$1",[s.path]);
  await reject(()=>rpc(0,"insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')",[users[0],s.path]));
});
test('Explicit verified account deletion can remove claimed own media without affecting other accounts',async()=>{
  const s=await oldStory();await server('select * from claim_media_cleanup(100)');
  await rpc(1,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'story',$3,'spam')",[users[1],users[0],s.id]);
  await reject(()=>rpc(0,'select begin_account_media_deletion($1)',[users[0]]));
  await server('select begin_account_media_deletion($1)',[users[1]]);
  await assert.rejects(()=>server("delete from storage.objects where bucket_id='media' and name=$1",[s.path]),/Cleanup cancelled/);
  await server('select begin_account_media_deletion($1)',[users[0]]);
  await server("delete from storage.objects where bucket_id='media' and name=$1",[s.path]);
  assert.equal((await db.query('select name from storage.objects where name=$1',[s.path])).rows.length,0);
});
test('Snap companions reused by another unopened recipient prevent bundle cleanup',async()=>{
  const main=`${users[0]}/snaps/bundle-main.jpg`,poster=`${users[0]}/snaps/bundle-poster.jpg`;
  for(const path of[main,poster])await rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
  const expired=await msg(0,1,{kind:'snap',body:null,media_path:main,poster_path:poster});
  await db.query("update messages set opened_at=now()-interval '2 days' where id=$1",[expired.id]);
  await msg(0,2,{kind:'snap',body:null,media_path:poster});
  assert.equal((await rpc(0,'select can_cleanup_snap($1) as ok',[main])).rows[0].ok,true);
  assert.equal((await rpc(0,'select can_cleanup_snap($1) as ok',[poster])).rows[0].ok,false);
  assert.equal((await db.query('select count(*)::int as n from storage.objects where name=any($1)',[[main,poster]])).rows[0].n,2);
});
test('A cleanup tombstone prevents a replacement upload at the same key',async()=>{
  const s=await oldStory();await server('select * from claim_media_cleanup(100)');
  await server("delete from storage.objects where bucket_id='media' and name=$1",[s.path]);
  await assert.rejects(()=>rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[s.path]),/path has expired/);
});
test('Unclaimed companion files cannot be deleted while another live message uses them',async()=>{
  const path=`${users[0]}/snaps/unclaimed-shared.jpg`;await rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
  await msg(0,1,{kind:'snap',body:null,media_path:path});
  await assert.rejects(()=>rpc(0,"delete from storage.objects where name=$1",[path]),/Cleanup cancelled/);
});
test('Group file cleanup checks all live references after an unsend',async()=>{
  const g=await group();const path=`${users[0]}/group/reused.jpg`;
  await rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
  const a=await gm(g,0,{kind:'photo',body:null,media_type:'photo',media_path:path});await gm(g,0,{kind:'photo',body:null,media_type:'photo',media_path:path});
  await rpc(0,'delete from group_messages where id=$1',[a.id]);
  assert.equal((await rpc(0,'select can_cleanup_snap($1) as ok',[path])).rows[0].ok,false);
  await rpc(0,'delete from group_messages where media_path=$1',[path]);
  assert.equal((await rpc(0,'select can_cleanup_snap($1) as ok',[path])).rows[0].ok,true);
});
test('Group reactions do not notify a sender who already left the group',async()=>{
  const g=await group();const m=await gm(g);
  await rpc(0,"select register_push_token('ExponentPushToken[qa-left-group]','ios')");
  await rpc(0,'delete from peek_group_members where group_id=$1 and user_id=$2',[g,users[0]]);
  await rpc(1,"insert into group_message_reactions(message_id,user_id,emoji) values($1,$2,'👍')",[m.id,users[1]]);
  assert.equal((await db.query('select * from net.sent')).rows.length,0);
});
test('Scheduled drop reminder respects activity age, Drops preferences and duplicate delivery',async()=>{
  await db.transaction(async tx=>{
    const offset=(await tx.query("select o from generate_series(-720,840)o where extract(hour from((now() at time zone 'utc')+make_interval(mins=>o)))::int*60+extract(minute from((now() at time zone 'utc')+make_interval(mins=>o)))::int=private.drop_minute(((now() at time zone 'utc')+make_interval(mins=>o))::date) limit 1")).rows[0].o;
    for(const [i,days]of[[0,10],[1,1],[2,46],[3,10]])await tx.query("insert into push_tokens(token,user_id,platform,utc_offset_minutes,updated_at) values($1,$2,'ios',$3,now()-make_interval(days=>$4))",[`ExponentPushToken[qa-reminder-${i}]`,users[i],offset,days]);
    await tx.query('insert into notification_prefs(user_id,drops) values($1,false)',[users[3]]);
    await tx.query('select private.send_drop_reminders()');await tx.query('select private.send_drop_reminders()');
    const queued=(await tx.query('select body from net.sent')).rows;assert.equal(queued.length,1);assert.equal(queued[0].body[0].to,'ExponentPushToken[qa-reminder-0]');
  });
});
test('Report alerts reach only local moderators and queue failure cannot lose the report',async()=>{
  await db.query('insert into private.report_alert_people(user_id) values($1)',[users[15]]);
  await rpc(15,"select register_push_token('ExponentPushToken[qa-moderator-only]','ios')");
  await rpc(0,"insert into reports(reporter_id,reported_user_id,content_type,reason) values($1,$2,'user','spam')",[users[0],users[1]]);
  const queued=(await db.query('select body from net.sent')).rows;assert.equal(queued.length,1);assert.equal(queued[0].body[0].to,'ExponentPushToken[qa-moderator-only]');assert.equal(queued[0].body[0].data.type,'report');
  await asUser(db,users[0],async tx=>{await tx.exec("set local test.push_failure='on'");await tx.query("insert into reports(reporter_id,reported_user_id,content_type,reason) values($1,$2,'user','other')",[users[0],users[1]]);});
  assert.equal((await db.query('select count(*)::int as n from reports')).rows[0].n,2);
});
test('A deleted account\'s unexpired identity cannot upload orphan files',async()=>{
  await db.query('delete from auth.users where id=$1',[users[0]]);
  await reject(()=>rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[`${users[0]}/posts/deleted-account.jpg`]));
});
test('Group media kind and captions cannot contain inconsistent or huge payloads',async()=>{
  const g=await group();
  await reject(()=>gm(g,0,{kind:'photo',body:null,media_path:`${users[0]}/group/wrong.jpg`,media_type:'video'}));
  await reject(()=>gm(g,0,{kind:'voice',body:'x'.repeat(2001),media_path:`${users[0]}/voice/body.m4a`,audio_ms:1000}));
});
test('A block confirmation is bound to the account that opened it',async()=>{
  await assert.rejects(()=>rpc(2,'select block_user($1,$2)',[users[1],users[0]]),/login has changed/);
  assert.equal((await db.query('select * from blocks')).rows.length,0);
  await rpc(0,'select block_user($1,$2)',[users[1],users[0]]);
  assert.equal((await db.query('select blocker_id from blocks')).rows[0].blocker_id,users[0]);
});
test('A reported photo remains protected after its author deletes the content row',async()=>{
  const path=`${users[0]}/posts/reported-deleted.jpg`;
  await rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
  const p=(await rpc(0,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[0],path])).rows[0].id;
  await rpc(1,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,'spam')",[users[1],users[0],p]);
  await rpc(0,'delete from posts where id=$1',[p]);
  await assert.rejects(()=>rpc(0,"delete from storage.objects where bucket_id='media' and name=$1",[path]),/Cleanup cancelled/);
  assert.equal((await db.query('select name from storage.objects where name=$1',[path])).rows.length,1);
});
test('Report evidence survives deletion of story, peek, group, comment and anonymous content rows',async()=>{
  for(const kind of['story','message','group_message','comment','mystery']){
    const folder=kind==='story'?'stories':kind==='message'?'snaps':kind==='group_message'?'group':kind==='comment'?'posts':'mystery';
    const path=folder==='mystery'?`mystery/${randomUUID()}.jpg`:`${users[0]}/${folder}/${randomUUID()}.jpg`;
    await rpc(0,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);let id,table,parentPost;
    if(kind==='story'){table='stories';id=(await rpc(0,'insert into stories(user_id,media_path) values($1,$2) returning id',[users[0],path])).rows[0].id;}
    else if(kind==='message'){table='messages';id=(await msg(0,1,{kind:'snap',body:null,media_path:path})).id;}
    else if(kind==='group_message'){table='group_messages';id=(await gm(await group(),0,{kind:'photo',body:null,media_path:path,media_type:'photo'})).id;}
    else if(kind==='comment'){
      table='comments';parentPost=(await rpc(0,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[0],path])).rows[0].id;
      id=(await rpc(0,"insert into comments(user_id,post_id,body) values($1,$2,'reported comment') returning id",[users[0],parentPost])).rows[0].id;
    }
    else{table='mystery_posts';await friend(db,users[0],users[1]);id=(await rpc(0,'insert into mystery_posts(user_id,media_path) values($1,$2) returning id',[users[0],path])).rows[0].id;}
    if(kind==='mystery')await rpc(1,"select report_mystery($1,'spam')",[id]);
    else await rpc(1,'insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,$3,$4,\'spam\')',[users[1],users[0],kind,id]);
    await rpc(0,`delete from ${table} where id=$1`,[id]);
    if(parentPost)await rpc(0,'delete from posts where id=$1',[parentPost]);
    assert.equal((await db.query(`select id from ${table} where id=$1`,[id])).rows.length,0);
    await assert.rejects(()=>rpc(0,"delete from storage.objects where bucket_id='media' and name=$1",[path]),/Cleanup cancelled/);
  }
});
test('Rejected reports cannot leave orphan private evidence snapshots',async()=>{
  const path=`${users[0]}/posts/invalid-report.jpg`;
  const id=(await rpc(0,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[0],path])).rows[0].id;
  await reject(()=>rpc(1,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,$4)",[users[1],users[0],id,'x'.repeat(101)]));
  assert.equal((await db.query('select * from private.report_media_evidence')).rows.length,0);
});
test('Private evidence snapshots are inaccessible to ordinary app users',async()=>{
  await reject(()=>rpc(0,'select * from private.report_media_evidence'));
  await reject(()=>rpc(0,"select * from private.report_media_paths('post',$1)",[randomUUID()]));
});
