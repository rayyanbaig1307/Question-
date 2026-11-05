import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { initializeDatabase, seedUsers, asUser, friend } from './local-db.mjs';
import { postgresBin, exe, assertNotRoot } from '../support/native-tools.mjs';

// Real PostgreSQL 16, listening ONLY on loopback. Everything, including the
// cluster's files, is created in this chat's work folder. Pushes remain local.
const repo=fileURLToPath(new URL('../../',import.meta.url));
assertNotRoot();
const native=postgresBin(repo);
const root=resolve(process.env.QA_NATIVE_ROOT??resolve(repo,'.qa'),`native-pg-${Date.now()}`);
await mkdir(root,{recursive:true});
const output=resolve(process.env.QA_CONCURRENCY_OUTPUT??resolve(root,'concurrency-results.json'));
const port=await new Promise((res,rej)=>{const s=createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p));});});
const run=(exe,args)=>new Promise((res,rej)=>{
  const p=spawn(resolve(native,exe),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';
  p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);p.once('error',rej);
  p.once('close',code=>code===0?res(out):rej(new Error(`${exe} failed ${code}: ${out}`)));
});
let server;const reports=[];let pools=[];
try {
  await run(exe('initdb'),['-D',resolve(root,'cluster'),'-U','postgres','--auth=trust','--locale=C','--encoding=UTF8','--no-instructions']);
  let log='';
  server=spawn(resolve(native,exe('postgres')),['-D',resolve(root,'cluster'),'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','max_connections=100'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',x=>log+=x);server.stderr.on('data',x=>log+=x);
  const config={host:'127.0.0.1',port,user:'postgres',database:'postgres',max:64,connectionTimeoutMillis:10000,statement_timeout:15000};
  let admin;
  for(let i=0;i<100;i++){
    try {admin=new pg.Client(config);await admin.connect();break;}
    catch {await admin?.end().catch(()=>{});admin=null;await new Promise(r=>setTimeout(r,100));}
  }
  if(!admin)throw new Error(`Local PostgreSQL did not start: ${log}`);
  console.log((await admin.query('select version() as version')).rows[0].version);
  for(const includeFixes of [false,true]){
    const name=includeFixes?'qa_fixed':'qa_original';await admin.query(`create database ${name}`);
    const pool=new pg.Pool({...config,database:name});pools.push(pool);
    const db={query:(...args)=>pool.query(...args),exec:sql=>pool.query(sql),close:async()=>{},transaction:async fn=>{
      const client=await pool.connect();
      try {await client.query('begin');const value=await fn({query:(...a)=>client.query(...a),exec:q=>client.query(q)});await client.query('commit');return value;}
      catch(error){await client.query('rollback');throw error;}finally{client.release();}
    }};
    await initializeDatabase(db,{includeFixes});const users=await seedUsers(db,50);
    const check=async(label,fn)=>{try{const detail=await fn();reports.push({environment:name,test:label,passed:true,detail});console.log(`PASS ${name}: ${label} ${JSON.stringify(detail)}`);}catch(error){reports.push({environment:name,test:label,passed:false,error:error.message});console.log(`FAIL ${name}: ${label} ${error.message}`);}};
    const own=(i,sql,params=[])=>asUser(db,users[i],tx=>tx.query(sql,params));
    await db.exec(`create function private.qa_pause_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(0.1); return new; end; $$;`);
    const pause=async(table,on)=>db.exec(on?`create trigger zz_qa_pause before insert on ${table} for each row execute function private.qa_pause_insert()`:`drop trigger zz_qa_pause on ${table}`);
    // Deliberate local scheduling delays widen real check-then-write races.
    await check('32 concurrent votes retain the exact aggregate',async()=>{
      const idea=(await own(0,"insert into dare_ideas(user_id,text) values($1,'Wear a silly hat today') returning id",[users[0]])).rows[0].id;
      await pause('dare_votes',true);
      const all=await Promise.allSettled(users.slice(1,33).map((id,i)=>own(i+1,'insert into dare_votes(idea_id,user_id) values($1,$2)',[idea,id])));
      await pause('dare_votes',false);
      const rows=(await db.query('select votes,(select count(*)::int from dare_votes where idea_id=$1) as actual from dare_ideas where id=$1',[idea])).rows[0];
      assert.equal(rows.votes,rows.actual);assert.equal(rows.actual,32);assert.equal(all.filter(x=>x.status==='rejected').length,0);return rows;
    });
    await check('Parallel hit ups cannot exceed ten per day',async()=>{
      for(let i=0;i<13;i++)await own(i,"select set_birthday((current_date-interval '25 years')::date)");
      for(let i=1;i<=9;i++)await own(0,'select hit_up($1)',[users[i]]);
      await pause('hit_ups',true);
      const all=await Promise.allSettled([own(0,'select hit_up($1)',[users[10]]),own(0,'select hit_up($1)',[users[11]])]);
      await pause('hit_ups',false);
      const count=(await db.query('select count(*)::int as count from hit_ups where from_user=$1',[users[0]])).rows[0].count;
      assert.equal(count,10);assert.equal(all.filter(x=>x.status==='fulfilled').length,1);return {count};
    });
    await check('Parallel group additions cannot exceed twelve people',async()=>{
      for(let i=1;i<13;i++)await friend(db,users[13],users[i]);
      const grp=(await own(13,"select create_peek_group('QA race',$1::uuid[],current_date) as id",[users.slice(1,11)])).rows[0].id;
      await pause('peek_group_members',true);
      await Promise.allSettled([own(13,'select add_to_peek_group($1,$2::uuid[],current_date)',[grp,[users[11]]]),own(13,'select add_to_peek_group($1,$2::uuid[],current_date)',[grp,[users[12]]])]);
      await pause('peek_group_members',false);
      const count=(await db.query('select count(*)::int as count from peek_group_members where group_id=$1',[grp])).rows[0].count;
      assert.equal(count,12);return {count};
    });
    await check('Parallel nudges send only one notice per cooldown',async()=>{
      await friend(db,users[14],users[15]);
      const grp=(await own(14,"select create_peek_group('QA nudge',$1::uuid[],current_date) as id",[[users[15]]])).rows[0].id;
      await pause('nudges',true);
      await Promise.allSettled(Array.from({length:8},()=>own(14,'select nudge_group_member($1,$2,current_date)',[grp,users[15]])));
      await pause('nudges',false);
      const count=(await db.query('select count(*)::int as count from nudges where group_id=$1',[grp])).rows[0].count;
      assert.equal(count,1);return {count};
    });
    await check('Parallel hit-back responses create one introduction',async()=>{
      for(const i of [16,17])await own(i,"select set_birthday((current_date-interval '25 years')::date)");
      await own(16,"select hit_up($1,'one hello')",[users[17]]);
      const hit=(await db.query('select id from hit_ups where from_user=$1',[users[16]])).rows[0].id;
      // Hold the row from another independent session while both callers read
      // the pending status, then release them into their writes together.
      const lock=await pool.connect();await lock.query('begin');await lock.query('select id from hit_ups where id=$1 for update',[hit]);
      const work=[own(17,'select respond_hit_up($1,true)',[hit]),own(17,'select respond_hit_up($1,true)',[hit])];
      await new Promise(r=>setTimeout(r,200));await lock.query('commit');lock.release();
      await Promise.allSettled(work);
      const count=(await db.query('select count(*)::int as count from messages where sender_id=$1 and recipient_id=$2',[users[16],users[17]])).rows[0].count;
      assert.equal(count,1);return {count};
    });
    await check('Simultaneous reciprocal hit ups connect immediately',async()=>{
      for(const i of [20,21])await own(i,"select set_birthday((current_date-interval '25 years')::date)");
      await pause('hit_ups',true);
      await Promise.allSettled([own(20,"select hit_up($1,'hello A')",[users[21]]),own(21,"select hit_up($1,'hello B')",[users[20]])]);
      await pause('hit_ups',false);
      const count=(await db.query("select count(*)::int as count from friendships where status='accepted' and least(requester_id,addressee_id)=least($1::uuid,$2::uuid) and greatest(requester_id,addressee_id)=greatest($1::uuid,$2::uuid)",[users[20],users[21]])).rows[0].count;
      assert.equal(count,1);return {count};
    });
    await check('Mixed hit-back entry points cannot duplicate introductions',async()=>{
      for(const i of [28,29])await own(i,"select set_birthday((current_date-interval '25 years')::date)");
      await own(28,"select hit_up($1,'mixed hello')",[users[29]]);
      const hit=(await db.query('select id from hit_ups where from_user=$1',[users[28]])).rows[0].id;
      const lock=await pool.connect();await lock.query('begin');await lock.query('select id from hit_ups where id=$1 for update',[hit]);
      const work=[own(29,'select respond_hit_up($1,true)',[hit]),own(29,'select hit_up($1)',[users[28]])];
      await new Promise(r=>setTimeout(r,200));await lock.query('commit');lock.release();
      await Promise.allSettled(work);
      const count=(await db.query('select count(*)::int as count from messages where sender_id=$1 and recipient_id=$2',[users[28],users[29]])).rows[0].count;
      assert.equal(count,1);return {count};
    });
    await check('Parallel dare suggestions respect one per day',async()=>{
      await pause('dare_ideas',true);
      await Promise.allSettled([own(22,"insert into dare_ideas(user_id,text) values($1,'Wear a silly hat today')",[users[22]]),own(22,"insert into dare_ideas(user_id,text) values($1,'Wear another silly hat')",[users[22]])]);
      await pause('dare_ideas',false);
      const count=(await db.query('select count(*)::int as count from dare_ideas where user_id=$1',[users[22]])).rows[0].count;
      assert.equal(count,1);return {count};
    });
    await check('Parallel forfeit payments create exactly one post',async()=>{
      const n=(await db.query("insert into dare_nominations(dare_day,from_user,to_user,expires_at) values(current_date-1,$1,$2,now()-interval '1 hour') returning id",[users[24],users[25]])).rows[0].id;
      const f=(await own(24,"select give_forfeit($1,'mustache') as id",[n])).rows[0].id;
      await pause('posts',true);
      await Promise.allSettled([own(25,'insert into posts(user_id,media_path,forfeit_id) values($1,$2,$3)',[users[25],`${users[25]}/posts/race-a.jpg`,f]),own(25,'insert into posts(user_id,media_path,forfeit_id) values($1,$2,$3)',[users[25],`${users[25]}/posts/race-b.jpg`,f])]);
      await pause('posts',false);
      const count=(await db.query('select count(*)::int as count from posts where forfeit_id=$1',[f])).rows[0].count;
      assert.equal(count,1);return {count};
    });
    await check('Simultaneous OAuth users with the same name all get unique profiles',async()=>{
      await pause('profiles',true);
      const all=await Promise.allSettled(Array.from({length:16},(_,i)=>db.query("insert into auth.users(id,raw_user_meta_data,raw_app_meta_data) values(gen_random_uuid(),$1,$2)",[{full_name:'Common QA Name'},{provider:'google'}])));
      await pause('profiles',false);
      const count=all.filter(row=>row.status==='fulfilled').length;
      assert.equal(count,16);return {count};
    });
    const expiredStory=async()=>{
      const path=`${users[35]}/stories/race-${Date.now()}-${Math.random()}.jpg`;
      await own(35,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
      const id=(await own(35,'insert into stories(user_id,media_path) values($1,$2) returning id',[users[35],path])).rows[0].id;
      await db.query("update stories set expires_at=now()-interval '8 days' where id=$1",[id]);
      await asUser(db,null,tx=>tx.query(includeFixes?'select * from claim_media_cleanup(1000)':'select * from media_cleanup_candidates(1000)'),'service_role');
      return {id,path};
    };
    await check('A concurrent report wins before cleanup metadata deletion',async()=>{
      // Review DB-1: only someone who could see the story may report it, so the reporter is a friend.
      await friend(db,users[35],users[36]);
      const s=await expiredStory();
      const reporter=await pool.connect();await reporter.query('begin');await reporter.query('set local role authenticated');
      await reporter.query("select set_config('request.jwt.claim.sub',$1,true)",[users[36]]);
      await reporter.query("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'story',$3,'spam')",[users[36],users[35],s.id]);
      const deletion=asUser(db,null,tx=>tx.query("delete from storage.objects where bucket_id='media' and name=$1",[s.path]),'service_role');
      await new Promise(r=>setTimeout(r,100));await reporter.query('commit');reporter.release();await deletion.catch(()=>{});
      const count=(await db.query('select count(*)::int as n from storage.objects where name=$1',[s.path])).rows[0].n;
      assert.equal(count,1);return {count};
    });
    await check('A concurrent Keep wins before cleanup metadata deletion',async()=>{
      const s=await expiredStory();
      const writer=await pool.connect();await writer.query('begin');await writer.query('set local role authenticated');
      await writer.query("select set_config('request.jwt.claim.sub',$1,true)",[users[35]]);
      await writer.query("insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')",[users[35],s.path]);
      const deletion=asUser(db,null,tx=>tx.query("delete from storage.objects where bucket_id='media' and name=$1",[s.path]),'service_role');
      await new Promise(r=>setTimeout(r,100));await writer.query('commit');writer.release();await deletion.catch(()=>{});
      const count=(await db.query('select count(*)::int as n from storage.objects where name=$1',[s.path])).rows[0].n;
      assert.equal(count,1);return {count};
    });
    await check('A reference after logical cleanup cannot resurrect a deleted path',async()=>{
      const s=await expiredStory();const deleter=await pool.connect();await deleter.query('begin');
      await deleter.query("delete from storage.objects where bucket_id='media' and name=$1",[s.path]);
      const reference=own(35,"insert into keeps(user_id,media_path,media_type) values($1,$2,'photo')",[users[35],s.path]);
      const result=reference.then(()=>true,()=>false);
      await new Promise(r=>setTimeout(r,100));await deleter.query('commit');deleter.release();
      const inserted=await result;assert.equal(inserted,false);return {inserted};
    });
    await check('Reentrant scheduled drop reminders queue at most once',async()=>{
      const offset=(await db.query("select o from generate_series(-720,840)o where extract(hour from((now() at time zone 'utc')+make_interval(mins=>o)))::int*60+extract(minute from((now() at time zone 'utc')+make_interval(mins=>o)))::int=private.drop_minute(((now() at time zone 'utc')+make_interval(mins=>o))::date) limit 1")).rows[0].o;
      const token='ExponentPushToken[qa-native-reminder]';
      await db.query("insert into push_tokens(token,user_id,platform,utc_offset_minutes,updated_at) values($1,$2,'ios',$3,now()-interval '10 days')",[token,users[40],offset]);
      await pause('private.drop_reminders_sent',true);
      await Promise.all([db.query('select private.send_drop_reminders()'),db.query('select private.send_drop_reminders()')]);
      await pause('private.drop_reminders_sent',false);
      const count=(await db.query("select count(*)::int as n from net.sent where body->0->>'to'=$1",[token])).rows[0].n;
      assert.equal(count,1);return {count};
    });
    await check('A replacement upload cannot race an unclaimed physical cleanup path',async()=>{
      const path=`${users[38]}/snaps/replacement-race.jpg`;
      await own(38,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
      const deleter=await pool.connect();await deleter.query('begin');await deleter.query("delete from storage.objects where bucket_id='media' and name=$1",[path]);
      const replacement=own(38,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]).then(()=>true,()=>false);
      await new Promise(r=>setTimeout(r,100));await deleter.query('commit');deleter.release();
      const inserted=await replacement;assert.equal(inserted,false);return {inserted};
    });
    await check('A report preserves evidence across concurrent author content deletion',async()=>{
      const path=`${users[45]}/posts/reported-author-delete.jpg`;
      await own(45,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
      const id=(await own(45,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[45],path])).rows[0].id;
      const reporter=await pool.connect();await reporter.query('begin');await reporter.query('set local role authenticated');
      await reporter.query("select set_config('request.jwt.claim.sub',$1,true)",[users[46]]);
      await reporter.query("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,'spam')",[users[46],users[45],id]);
      const deletion=(async()=>{await own(45,'delete from posts where id=$1',[id]);await own(45,"delete from storage.objects where bucket_id='media' and name=$1",[path]);})().then(()=>true,()=>false);
      await new Promise(r=>setTimeout(r,100));await reporter.query('commit');reporter.release();await deletion;
      const count=(await db.query('select count(*)::int as n from storage.objects where name=$1',[path])).rows[0].n;
      assert.equal(count,1);return {count};
    });
    // Review DB-1: a report racing the author's own delete keeps the evidence, and the author
    // sees the same result as without a report (no error). Then a dismissal lets the daily cleanup remove it.
    const asApp=async(client,i)=>{await client.query('begin');await client.query('set local role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[users[i]]);};
    if(includeFixes)await check('A report racing the author delete keeps evidence quietly; dismissal releases it to cleanup',async()=>{
      const path=`${users[41]}/posts/race-deferred-${Date.now()}.jpg`;
      await own(41,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
      const id=(await own(41,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[41],path])).rows[0].id;
      const reporter=await pool.connect();await asApp(reporter,42);
      const report=(await reporter.query("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,'spam') returning id",[users[42],users[41],id])).rows[0].id;
      const deletion=(async()=>{await own(41,'delete from posts where id=$1',[id]);await own(41,"delete from storage.objects where bucket_id='media' and name=$1",[path]);return 'ok';})().catch(e=>e.message);
      await new Promise(r=>setTimeout(r,150));await reporter.query('commit');reporter.release();
      const author=await deletion;assert.equal(author,'ok');
      assert.equal((await db.query('select count(*)::int as n from storage.objects where name=$1',[path])).rows[0].n,1);
      assert.equal((await db.query('select count(*)::int as n from private.media_deferred_deletions where object_name=$1',[path])).rows[0].n,1);
      const service=sql=>asUser(db,null,tx=>tx.query(sql),'service_role');
      assert.ok(!(await service('select name from claim_media_cleanup(1000)')).rows.some(r=>r.name===path));
      await db.query("update reports set status='dismissed' where id=$1",[report]);
      assert.ok((await service('select name from claim_media_cleanup(1000)')).rows.some(r=>r.name===path));
      await asUser(db,null,tx=>tx.query("delete from storage.objects where bucket_id='media' and name=$1",[path]),'service_role');
      const left=(await db.query('select count(*)::int as n from storage.objects where name=$1',[path])).rows[0].n;
      assert.equal(left,0);return {author,left};
    });
    if(includeFixes)await check('A report that loses the race to the author delete saves no evidence',async()=>{
      const path=`${users[43]}/posts/race-gone-${Date.now()}.jpg`;
      await own(43,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
      const id=(await own(43,'insert into posts(user_id,media_path) values($1,$2) returning id',[users[43],path])).rows[0].id;
      const author=await pool.connect();await asApp(author,43);
      await author.query('delete from posts where id=$1',[id]);
      const report=own(44,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,'spam')",[users[44],users[43],id]).then(()=>'saved',e=>e.message);
      await new Promise(r=>setTimeout(r,150));
      await author.query("delete from storage.objects where bucket_id='media' and name=$1",[path]);await author.query('commit');author.release();
      const result=await report;
      const evidence=(await db.query('select count(*)::int as n from private.report_media_evidence where object_name=$1',[path])).rows[0].n;
      // An app user's delete always waits for the daily cleanup (reported or not), so run it.
      const service=sql=>asUser(db,null,tx=>tx.query(sql),'service_role');
      const names=(await service('select name from claim_media_cleanup(1000)')).rows.map(r=>r.name);
      assert.ok(names.includes(path),'the daily cleanup must pick the file up');
      await asUser(db,null,tx=>tx.query("delete from storage.objects where bucket_id='media' and name=$1",[path]),'service_role');
      const left=(await db.query('select count(*)::int as n from storage.objects where name=$1',[path])).rows[0].n;
      assert.equal(evidence,0);assert.equal(left,0);return {result,evidence,left};
    });
    if(includeFixes)await check('A report racing the daily cleanup of a file the sender already deleted keeps the evidence',async()=>{
      await friend(db,users[47],users[48]);
      const path=`${users[47]}/snaps/race-daily-${Date.now()}.jpg`;
      await own(47,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
      const id=(await own(47,"insert into messages(sender_id,recipient_id,kind,media_path) values($1,$2,'snap',$3) returning id",[users[47],users[48],path])).rows[0].id;
      // Opened two days ago: the sender's app tidies the file away; it waits for the daily cleanup.
      await db.query("update messages set opened_at=now()-interval '2 days' where id=$1",[id]);
      const sender=await own(47,"delete from storage.objects where bucket_id='media' and name=$1 returning name",[path]);
      assert.equal(sender.rows.length,0);
      const service=sql=>asUser(db,null,tx=>tx.query(sql),'service_role');
      assert.ok((await service('select name from claim_media_cleanup(1000)')).rows.some(r=>r.name===path));
      // The recipient reports the peek while the cleanup is deleting the file.
      const reporter=await pool.connect();await asApp(reporter,48);
      await reporter.query("insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'message',$3,'spam')",[users[48],users[47],id]);
      const deletion=asUser(db,null,tx=>tx.query("delete from storage.objects where bucket_id='media' and name=$1",[path]),'service_role').then(()=>'deleted',e=>e.message);
      await new Promise(r=>setTimeout(r,150));await reporter.query('commit');reporter.release();
      const cleanup=await deletion;
      const left=(await db.query('select count(*)::int as n from storage.objects where name=$1',[path])).rows[0].n;
      const evidence=(await db.query('select count(*)::int as n from private.report_media_evidence where object_name=$1',[path])).rows[0].n;
      assert.equal(left,1);assert.equal(evidence,1);
      // The sender still sees it as deleted.
      assert.equal((await own(47,"select count(*)::int as n from storage.objects where name=$1",[path])).rows[0].n,0);
      return {cleanup,left,evidence};
    });
    if(includeFixes)await check('100 simultaneous auth reservations permit exactly eight',async()=>{
      const all=await Promise.all(Array.from({length:100},()=>asUser(db,null,tx=>tx.query("select reserve_username_auth_attempt('fail','parallel-native',8,15) as ok"),'service_role')));
      const count=all.filter(r=>r.rows[0].ok).length;assert.equal(count,8);return {count};
    });
    // The same steps as the username-auth helper: reserve the name+address, name and address counters in
    // order (giving back what was taken if one is full), then give everything back after a correct login.
    const authTry=async(username,address,correct)=>{
      const id=crypto.randomUUID();const serve=(sql,p)=>asUser(db,null,tx=>tx.query(sql,p),'service_role');
      for(const [key,max] of [[`pair:${username}@${address}`,8],[`user:${username}`,40],[`ip:${address}`,30]]){
        const ok=(await serve('select public.reserve_username_auth_attempt($1,$2,$3,$4,$5) as ok',['fail',key,max,15,id])).rows[0].ok;
        if(!ok){await serve('select public.refund_username_auth_attempt($1)',[id]);return 'limited';}
      }
      if(correct){await serve('select public.refund_username_auth_attempt($1)',[id]);return 'ok';}
      return 'wrong';
    };
    const authRows=async key=>(await db.query('select count(*)::int as n from public.username_auth_log where key=$1',[key])).rows[0].n;
    if(includeFixes)await check('Parallel correct username logins never use up the wrong-password allowance',async()=>{
      const all=await Promise.all(Array.from({length:60},()=>authTry('para_ok','198.51.100.10',true)));
      const ok=all.filter(r=>r==='ok').length;
      // Correct logins in flight at the same moment may briefly be told to wait, but none stay counted.
      assert.ok(ok>=8,`only ${ok} correct logins got through`);
      for(const key of ['pair:para_ok@198.51.100.10','user:para_ok','ip:198.51.100.10'])assert.equal(await authRows(key),0,key);
      const wrong=[];for(let i=0;i<10;i++)wrong.push(await authTry('para_ok','198.51.100.10',false));
      assert.equal(wrong.filter(r=>r==='wrong').length,8);return {ok,limited:all.length-ok,wrongAfter:8};
    });
    if(includeFixes)await check('Parallel wrong username logins stay capped at 8 per name and address while correct ones run',async()=>{
      const all=await Promise.all([
        ...Array.from({length:100},()=>authTry('para_mix','203.0.113.20',false).then(r=>['wrong',r])),
        ...Array.from({length:40},()=>authTry('para_mix','203.0.113.20',true).then(r=>['right',r])),
      ]);
      const wrong=all.filter(([k,r])=>k==='wrong'&&r==='wrong').length;
      assert.ok(wrong<=8,`${wrong} wrong guesses were checked`);
      assert.equal(await authRows('pair:para_mix@203.0.113.20'),wrong);
      // Whatever got through, the counter never goes past 8 afterwards.
      const more=[];for(let i=0;i<10;i++)more.push(await authTry('para_mix','203.0.113.20',false));
      assert.equal(wrong+more.filter(r=>r==='wrong').length,8);
      return {wrongChecked:wrong,correctOk:all.filter(([k,r])=>k==='right'&&r==='ok').length};
    });
    if(includeFixes)await check('Parallel wrong username logins from many addresses stop at 40 per name',async()=>{
      const all=await Promise.all(Array.from({length:10},(_,a)=>Array.from({length:12},()=>authTry('para_many',`192.0.2.${a+1}`,false))).flat());
      const wrong=all.filter(r=>r==='wrong').length;
      assert.ok(wrong<=40,`${wrong} wrong guesses were checked`);
      for(let a=1;a<=10;a++)assert.ok(await authRows(`pair:para_many@192.0.2.${a}`)<=8);
      assert.equal(await authRows('user:para_many'),wrong);return {wrongChecked:wrong};
    });
    // Review DB-2: each file name has its own lock row. Big deletes must fit in PostgreSQL's
    // lock table, must not get stuck in a circle with people posting at the same time, and
    // must not make people using other files wait.
    const freshUsers=async(label,n)=>{
      const ids=Array.from({length:n},()=>crypto.randomUUID());
      for(const [i,id] of ids.entries())await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[id,{username:`${label}_${i}`.slice(0,20)}]);
      return ids;
    };
    const heavyAccount=async(label,count)=>{
      const [id,mate]=await freshUsers(label,2);await friend(db,id,mate);
      // Unopened peeks, so the daily cleanup running in the race below has no old peeks to look through.
      await db.query(`insert into messages(sender_id,recipient_id,kind,media_path,media_type)
        select $1::uuid,$2::uuid,'snap',$1::text||'/snaps/'||gen_random_uuid()||'.jpg','photo'
          from generate_series(1,$3::int)`,[id,mate,count]);
      return id;
    };
    const as=(id,sql,params=[])=>asUser(db,id,tx=>tx.query(sql,params));
    if(includeFixes)await check('Deleting an account with 25,000 peeks fits in the lock table',async()=>{
      const id=await heavyAccount('dbtwo_big',25000);const started=Date.now();
      await db.query('delete from auth.users where id=$1',[id]);
      const left=(await db.query('select count(*)::int as n from messages where sender_id=$1 or recipient_id=$1',[id])).rows[0].n;
      assert.equal(left,0);return {peeks:25000,ms:Date.now()-started};
    });
    if(includeFixes)await check('Heavy account deletions racing posts, reports and file deletes finish without deadlocks',async()=>{
      const rounds=[];
      for(let round=0;round<3;round++){
        const heavy=await heavyAccount(`dbtwo_r${round}`,8000);const second=await heavyAccount(`dbtwo_s${round}`,4000);
        const people=await freshUsers(`dbtwo_p${round}`,24);
        for(let i=1;i<people.length;i++)await friend(db,people[0],people[i]);
        // Posts to report: four files each (photo, poster, overlay, blurry preview).
        const upload=async(owner,name,folder='posts')=>{const path=`${owner}/${folder}/${name}-${crypto.randomUUID()}.jpg`;await as(owner,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);return path;};
        const fourFilePost=async owner=>{
          const files=[];for(const part of ['m','p','o'])files.push(await upload(owner,part));files.push(await upload(owner,'b','blurs'));
          return (await as(owner,'insert into posts(user_id,media_path,poster_path,overlay_path,blur_path) values($1,$2,$3,$4,$5) returning id',[owner,...files])).rows[0].id;
        };
        const targets=[];for(let i=0;i<8;i++)targets.push(await fourFilePost(people[0]));
        const spare=[];for(let i=16;i<24;i++){const files=[];for(let k=0;k<4;k++)files.push(await upload(people[i],`spare${k}`));spare.push([people[i],files]);}
        // Each step reports 'ok' or what went wrong and how long it took.
        const t0=Date.now();const timed=(label,run)=>run.then(()=>'ok',e=>`${label}: ${e.message} after ${Date.now()-t0}ms`);
        const deletions=[heavy,second].map((id,i)=>timed(`account delete ${i}`,db.query('delete from auth.users where id=$1',[id])));
        await new Promise(r=>setTimeout(r,20));
        const work=[
          // 15 people post a new four-file post at the same time.
          ...people.slice(1,16).map((owner,i)=>timed(`post ${i}`,fourFilePost(owner))),
          // 8 friends report a four-file post.
          ...targets.map((post,i)=>timed(`report ${i}`,as(people[1+i],"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'post',$3,'spam')",[people[1+i],people[0],post]))),
          // 8 people delete four of their own files at once (in a mixed order).
          ...spare.map(([owner,files],i)=>timed(`file delete ${i}`,as(owner,"delete from storage.objects where bucket_id='media' and name=any($1)",[files]))),
          // The daily cleanup runs too.
          timed('daily cleanup',asUser(db,null,tx=>tx.query('select count(*) from claim_media_cleanup(200)'),'service_role')),
        ];
        const results=[...await Promise.all(deletions),...await Promise.all(work)];
        const problems=results.filter(r=>r!=='ok');
        assert.deepEqual(problems,[],`round ${round}`);
        const evidence=(await db.query('select count(*)::int as n from private.report_media_evidence e join reports r on r.id=e.report_id where r.content_id=any($1)',[targets])).rows[0].n;
        assert.equal(evidence,32,`round ${round}: each report keeps its four files`);
        const left=(await db.query('select count(*)::int as n from messages where sender_id=any($1)',[[heavy,second]])).rows[0].n;
        assert.equal(left,0);rounds.push(results.length);
      }
      return {rounds};
    });
    // Entries this connection uses in PostgreSQL's shared lock table (tables, indexes and any advisory locks).
    const lockEntries=async client=>(await client.query('select count(*)::int as n from pg_locks where pid=pg_backend_pid()')).rows[0].n;
    if(includeFixes)await check('A keeper waits for a big delete of the same file, then sees the delete; a second delete of it does not wait',async()=>{
      const [owner]=await freshUsers('dbtwo_wait',1);
      const path=`${owner}/snaps/${crypto.randomUUID()}.jpg`;
      await as(owner,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
      // Two posts that use the same picture, deleted by two different changes at once.
      const shared=`${owner}/posts/${crypto.randomUUID()}.jpg`;
      await as(owner,"insert into storage.objects(bucket_id,name) values('media',$1)",[shared]);
      const posts=[];
      for(let i=0;i<2;i++)posts.push((await as(owner,'insert into posts(user_id,media_path) values($1,$2) returning id',[owner,shared])).rows[0].id);
      const other=await heavyAccount('dbtwo_hold',3000);
      const deleter=await pool.connect();await deleter.query('begin');
      await deleter.query('delete from auth.users where id=$1',[other]);
      await deleter.query("delete from storage.objects where bucket_id='media' and name=$1",[path]);
      await deleter.query('delete from posts where id=$1',[posts[0]]);
      const held=await lockEntries(deleter);
      const upload=as(owner,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]).then(()=>'saved',e=>e.message);
      const secondDelete=as(owner,'delete from posts where id=$1',[posts[1]]).then(()=>'deleted',e=>e.message);
      const early=await Promise.race([upload,new Promise(r=>setTimeout(()=>r('waiting'),300))]);
      const second=await Promise.race([secondDelete,new Promise(r=>setTimeout(()=>r('waiting'),300))]);
      await deleter.query('commit');deleter.release();
      const final=await upload;
      assert.ok(held<=400,`held ${held} lock table entries`);assert.equal(early,'waiting');assert.match(final,/expired/);
      assert.equal(second,'deleted','two deletes of the same file must not wait for each other');
      return {held,early,final,second};
    });
    if(includeFixes)await check('An unrelated two-file post never deadlocks with a bulk delete',async()=>{
      // The old 1024-slot design: a bulk delete held slot H, then took every slot; a stranger's post
      // held a low slot L and waited for H (a different file in the same slot). Each waited for the other.
      const slotOf=async name=>(await db.query('select (hashtextextended($1,0) & 1023)::int as s',[name])).rows[0].s;
      const [x,y]=await freshUsers('dbtwo_dl',2);
      let high,hs;for(let i=0;!high;i++){const name=`${x}/posts/h${i}.jpg`;const s=await slotOf(name);if(s>=1000){high=name;hs=s;}}
      let low;for(let i=0;!low;i++){const name=`${y}/posts/l${i}.jpg`;if(await slotOf(name)<100)low=name;}
      let same;for(let i=0;!same;i++){const name=`${y}/posts/x${i}.jpg`;if(await slotOf(name)===hs)same=name;}
      const first=(await db.query('insert into posts(user_id,media_path) values($1,$2) returning id',[x,high])).rows[0].id;
      const more=(await db.query(`insert into posts(user_id,media_path) select $1::uuid,$1::text||'/posts/e'||g||'.jpg' from generate_series(1,40) g returning id`,[x])).rows.map(r=>r.id);
      const deleter=await pool.connect();await deleter.query('begin');
      await deleter.query('delete from posts where id=$1',[first]);
      const t0=Date.now();
      const keeper=asUser(db,y,tx=>tx.query('insert into posts(user_id,media_path,poster_path) values($1,$2,$3)',[y,low,same])).then(()=>'ok',e=>`error: ${e.message} after ${Date.now()-t0}ms`);
      const early=await Promise.race([keeper,new Promise(r=>setTimeout(()=>r('waiting'),300))]);
      const bulk=await deleter.query('delete from posts where id=any($1)',[more]).then(r=>r.rowCount,e=>`error: ${e.message}`);
      await deleter.query(typeof bulk==='number'?'commit':'rollback');deleter.release();
      const late=await keeper;
      assert.equal(bulk,40);assert.equal(late,'ok');assert.equal(early,'ok','a post with other file names must not wait for the delete');
      return {slot:hs,early,bulk,late};
    });
    if(includeFixes)await check('Thirty medium deletes held open at once fit in the lock table',async()=>{
      // Each person deletes 40 of their own posts in a change that stays open. The old slot design
      // used 1,024 entries per change and ran out of room ("out of shared memory") after a few.
      const people=await freshUsers('dbtwo_mid',30);
      for(const id of people)await db.query(`insert into posts(user_id,media_path) select $1::uuid,$1::text||'/posts/m'||g||'.jpg' from generate_series(1,40) g`,[id]);
      const open=[];let failure=null;let most=0;
      try {
        for(const [i,id] of people.entries()){
          const client=await pool.connect();open.push(client);
          try {
            await client.query('begin');await client.query('set local role authenticated');
            await client.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)",[id]);
            const gone=(await client.query('delete from posts where user_id=$1',[id])).rowCount;
            if(gone!==40)throw new Error(`deleted ${gone}`);
            most=Math.max(most,await lockEntries(client));
          } catch(error){failure=`delete ${i+1}: ${error.message}`;break;}
        }
      } finally {for(const client of open){await client.query('rollback').catch(()=>{});client.release();}}
      assert.equal(failure,null);assert.ok(most<=400,`one delete used ${most} lock table entries`);
      return {open:people.length,mostEntries:most};
    });
    if(includeFixes)await check('An upload by someone else does not wait for a heavy account deletion',async()=>{
      const other=await heavyAccount('dbtwo_stall',3000);
      const [stranger]=await freshUsers('dbtwo_up',1);
      const deleter=await pool.connect();await deleter.query('begin');
      try {
        await deleter.query('delete from auth.users where id=$1',[other]);
        const t0=Date.now();
        const upload=as(stranger,"insert into storage.objects(bucket_id,name) values('media',$1)",[`${stranger}/posts/${crypto.randomUUID()}.jpg`]).then(()=>`saved after ${Date.now()-t0}ms`,e=>e.message);
        const early=await Promise.race([upload,new Promise(r=>setTimeout(()=>r('waiting'),500))]);
        await deleter.query('commit');
        const final=await upload;
        assert.match(early,/^saved/,'an unrelated upload must not wait for the deletion');
        return {early,final};
      } finally {await deleter.query('rollback').catch(()=>{});deleter.release();}
    });
    if(includeFixes)await check('The daily cleanup stays fast with 20,000 old peeks whose files are already gone',async()=>{
      // Final DB fix: the daily cleanup used to run its slow checks on every old peek, story and Guess Who
      // path ever made, even when the file was deleted long ago. Now only files that still exist are checked.
      const [sender,mate]=await freshUsers('dbfinal_clean',2);await friend(db,sender,mate);
      await db.query(`insert into messages(sender_id,recipient_id,kind,media_path,media_type)
        select $1::uuid,$2::uuid,'snap',$1::text||'/snaps/history-'||g||'.jpg','photo' from generate_series(1,20000) g`,[sender,mate]);
      const live=[];
      for(let n=0;n<3;n++){
        const path=`${sender}/snaps/live-${n}.jpg`;live.push(path);
        await as(sender,"insert into storage.objects(bucket_id,name) values('media',$1)",[path]);
        await as(sender,"insert into messages(sender_id,recipient_id,kind,media_path,media_type) values($1,$2,'snap',$3,'photo')",[sender,mate,path]);
      }
      await db.query("update messages set opened_at=now()-interval '8 days' where sender_id=$1",[sender]);
      // An old story kept for a report (never listed) and a file its owner deleted in the app (listed).
      const kept=`${sender}/stories/reported.jpg`;
      await as(sender,"insert into storage.objects(bucket_id,name) values('media',$1)",[kept]);
      const story=(await as(sender,'insert into stories(user_id,media_path) values($1,$2) returning id',[sender,kept])).rows[0].id;
      await as(mate,"insert into reports(reporter_id,reported_user_id,content_type,content_id,reason) values($1,$2,'story',$3,'spam')",[mate,sender,story]);
      await db.query("update stories set expires_at=now()-interval '9 days' where id=$1",[story]);
      const waiting=`${sender}/posts/waiting.jpg`;
      await as(sender,"insert into storage.objects(bucket_id,name) values('media',$1)",[waiting]);
      await as(sender,"delete from storage.objects where bucket_id='media' and name=$1",[waiting]);
      // Runs as the daily cleanup does (service role) and undoes any claims afterwards.
      const timed=async(sql,role='service_role')=>{
        const client=await pool.connect();
        try {
          await client.query('begin');await client.query('set local statement_timeout = 0');
          if(role)await client.query(`set local role ${role}`);
          const t0=Date.now();const rows=(await client.query(sql)).rows.map(r=>r.name);return {ms:Date.now()-t0,rows};
        } finally {await client.query('rollback');client.release();}
      };
      // First as a brand-new table without statistics (the worst case), then after "analyze"
      // (a live database keeps statistics up to date by itself).
      const fresh={listed:await timed('select name from media_cleanup_candidates(1000)'),claimed:await timed('select name from claim_media_cleanup(1000)')};
      await db.query('analyze');
      const listed=await timed('select name from media_cleanup_candidates(1000)');
      const claimed=await timed('select name from claim_media_cleanup(1000)');
      // The same list worked out the old way (20261213200000), for comparison.
      const old=await timed(`with dead as (
          select e.path from private.expired_media_paths() as e(path)
          union all select d.object_name from private.media_deferred_deletions d)
        select distinct d.path as name from dead d join storage.objects o on o.bucket_id='media' and o.name=d.path
        where d.path is not null and private.media_cleanup_eligible(d.path) order by d.path limit 1000`,null);
      assert.deepEqual(listed.rows,old.rows,'the list must be exactly the same as before');
      assert.deepEqual(fresh.listed.rows,listed.rows);
      assert.deepEqual(claimed.rows,listed.rows);assert.deepEqual(fresh.claimed.rows,listed.rows);
      for(const path of [...live,waiting])assert.ok(listed.rows.includes(path),path);
      assert.ok(!listed.rows.includes(kept),'a file kept for a report is never listed');
      assert.ok(!listed.rows.some(name=>name.includes('/snaps/history-')),'files that are already gone are never listed');
      assert.ok(fresh.listed.ms<4000&&fresh.claimed.ms<6000,`without statistics: listing ${fresh.listed.ms}ms, claiming ${fresh.claimed.ms}ms`);
      assert.ok(listed.ms<1000,`listing took ${listed.ms}ms`);assert.ok(claimed.ms<2000,`claiming took ${claimed.ms}ms`);
      return {oldPeeksWithoutFiles:20000,listed:listed.rows.length,noStats:{listMs:fresh.listed.ms,claimMs:fresh.claimed.ms},
        analyzed:{listMs:listed.ms,claimMs:claimed.ms,oldWayMs:old.ms}};
    });
    await pool.end();pools=pools.filter(p=>p!==pool);
  }
  await admin.end();
  await writeFile(output,JSON.stringify({engine:'PostgreSQL 16, independent TCP sessions, loopback only',reports},null,2));
  console.log(`Results: ${output}`);
  if(reports.some(r=>r.environment==='qa_fixed'&&!r.passed))process.exitCode=1;
} finally {
  await Promise.all(pools.map(p=>p.end().catch(()=>{})));
  if(server){await run(exe('pg_ctl'),['-D',resolve(root,'cluster'),'-m','fast','-w','stop']).catch(()=>server.kill());}
}
