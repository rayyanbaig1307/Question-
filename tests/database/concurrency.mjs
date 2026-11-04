import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { initializeDatabase, seedUsers, asUser, friend } from './local-db.mjs';

// Real PostgreSQL 16, listening ONLY on loopback. Everything, including the
// cluster's files, is created in this chat's work folder. Pushes remain local.
const repo=fileURLToPath(new URL('../../',import.meta.url));
const native=resolve(repo,'node_modules/@embedded-postgres/windows-x64/native/bin');
const root=resolve(repo,'..',`native-pg-${Date.now()}`);
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
  await run('initdb.exe',['-D',resolve(root,'cluster'),'-U','postgres','--auth=trust','--locale=C','--encoding=UTF8','--no-instructions']);
  let log='';
  server=spawn(resolve(native,'postgres.exe'),['-D',resolve(root,'cluster'),'-h','127.0.0.1','-p',String(port),'-c','fsync=off','-c','max_connections=100'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
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
    if(includeFixes)await check('100 simultaneous auth reservations permit exactly eight',async()=>{
      const all=await Promise.all(Array.from({length:100},()=>asUser(db,null,tx=>tx.query("select reserve_username_auth_attempt('fail','parallel-native',8,15) as ok"),'service_role')));
      const count=all.filter(r=>r.rows[0].ok).length;assert.equal(count,8);return {count};
    });
    await pool.end();pools=pools.filter(p=>p!==pool);
  }
  await admin.end();
  await writeFile(output,JSON.stringify({engine:'PostgreSQL 16, independent TCP sessions, loopback only',reports},null,2));
  console.log(`Results: ${output}`);
  if(reports.some(r=>r.environment==='qa_fixed'&&!r.passed))process.exitCode=1;
} finally {
  await Promise.all(pools.map(p=>p.end().catch(()=>{})));
  if(server){await run('pg_ctl.exe',['-D',resolve(root,'cluster'),'-m','fast','-w','stop']).catch(()=>server.kill());}
}
