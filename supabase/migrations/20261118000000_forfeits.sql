-- =====================================================================
-- Forfeits 💀
--
-- * A dare you were given ran out of time (24 h, not done) → the friend who dared you picks a forfeit
--   for you from a fixed, safe list. You get a push.
-- * You "pay" it by posting a photo/video of the forfeit (posts.forfeit_id). It gets a 💀 tag.
-- * Only the list below is possible – nobody can type their own forfeit.
-- =====================================================================

create table public.forfeit_options (
  key text primary key,
  text text not null,
  position integer not null
);
alter table public.forfeit_options enable row level security;
create policy "Everyone can read the forfeit list"
  on public.forfeit_options for select to authenticated using (true);

insert into public.forfeit_options (key, text, position) values
  ('mustache',      'Post a selfie with a mustache drawn on in marker', 1),
  ('sock_hands',    'Wear socks on your hands in your next photo', 2),
  ('worst_selfie',  'Post your worst selfie – no retakes', 3),
  ('pushups',       'Do 20 push-ups on video', 4),
  ('bad_song',      'Sing the chorus of a song you hate, on video', 5),
  ('inside_out',    'Wear your clothes inside out for the rest of the day – photo proof', 6),
  ('mustard',       'Eat a spoonful of mustard on video', 7),
  ('chicken_sign',  'Hold up a sign that says "I chickened out of a dare"', 8),
  ('chicken_dance', 'Do the chicken dance on video', 9),
  ('messy_drawer',  'Post a photo of your messiest drawer', 10),
  ('teapot',        'Do "I''m a little teapot" with the moves, on video', 11),
  ('towel_cape',    'Wear a towel as a cape to the nearest shop – photo', 12),
  ('death_scene',   'Act out a dramatic death scene on video', 13),
  ('lemon',         'Eat a lemon slice on video without pulling a face', 14),
  ('all_hats',      'Put on every hat you own at once – photo', 15),
  ('plank_stack',   'Hold a plank with something balanced on your back – photo', 16),
  ('accent',        'Talk in a terrible accent for a 10-second video', 17),
  ('worm',          'Do the worm on video', 18),
  ('bowl_hat',      'Wear a bowl as a hat – photo', 19),
  ('wild_hair',     'Post a selfie with your hair as wild as it goes', 20),
  ('jumping_jacks', 'Do 30 jumping jacks on video', 21),
  ('tree_hug',      'Post a photo of you hugging a tree', 22),
  ('face_art',      'Let a friend draw on your face (washable!) – photo', 23),
  ('celebrity',     'Wear sunglasses indoors and act like a celebrity on video', 24),
  ('fort',          'Post a photo of you inside a blanket fort', 25),
  ('onion',         'Eat a raw onion slice on video', 26),
  ('cartwheel',     'Do a cartwheel (or your best try) on video', 27),
  ('veg_speech',    'Give a 10-second motivational speech to a vegetable, on video', 28),
  ('crab_walk',     'Crab-walk across a room on video', 29),
  ('pillow_hat',    'Post a selfie with a pillow as a hat', 30),
  ('morning_dance', 'Do an interpretive dance of your morning, on video', 31),
  ('pants_hat',     'Post a photo with a pair of trousers on your head', 32),
  ('birthday',      'Sing happy birthday to someone whose birthday it isn''t, on video', 33),
  ('oven_gloves',   'Do something normal wearing oven gloves – photo', 34),
  ('hop',           'Hop on one foot for 30 seconds on video', 35),
  ('fridge',        'Post a selfie with the ugliest thing in your fridge', 36),
  ('impression',    'Do your best impression of the friend who dared you, on video', 37),
  ('you_win',       'Say "You win" in slow motion on video', 38),
  ('robot',         'Walk like a robot through a shop – video', 39),
  ('opera',         'Order something or say hello in opera voice, on video', 40);

create table public.forfeits (
  id uuid primary key default gen_random_uuid(),
  nomination_id uuid not null unique references public.dare_nominations (id) on delete cascade,
  from_user uuid not null references public.profiles (id) on delete cascade,   -- who picked it
  to_user uuid not null references public.profiles (id) on delete cascade,     -- who owes it
  forfeit_key text not null references public.forfeit_options (key),
  forfeit_text text not null,
  created_at timestamptz not null default now(),
  done_post_id uuid references public.posts (id) on delete set null,
  done_at timestamptz
);
alter table public.forfeits enable row level security;
create index forfeits_to_user_idx on public.forfeits (to_user, done_at);
create index forfeits_from_user_idx on public.forfeits (from_user, done_at);

create policy "You can see forfeits you gave or owe"
  on public.forfeits for select to authenticated
  using (from_user = (select auth.uid()) or to_user = (select auth.uid()));

-- The friend who dared you picks your forfeit – only once the 24 hours are up and the dare wasn't done.
create or replace function public.give_forfeit(nomination uuid, choice text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  n public.dare_nominations%rowtype;
  words text;
  my_name text;
  new_id uuid;
begin
  if me is null then
    raise exception 'Please log in again';
  end if;
  select * into n from public.dare_nominations where id = nomination;
  if n.id is null or n.from_user <> me then
    raise exception 'That''s not your dare to call';
  end if;
  if n.done_at is not null then
    raise exception 'They did the dare – no forfeit!';
  end if;
  if n.expires_at > now() then
    raise exception 'They still have time';
  end if;
  if exists (select 1 from public.forfeits f where f.nomination_id = n.id) then
    raise exception 'You already picked a forfeit';
  end if;
  select text into words from public.forfeit_options where key = choice;
  if words is null then
    raise exception 'Pick a forfeit from the list';
  end if;
  insert into public.forfeits (nomination_id, from_user, to_user, forfeit_key, forfeit_text)
  values (n.id, me, n.to_user, choice, words)
  returning id into new_id;
  select coalesce(display_name, username) into my_name from public.profiles where id = me;
  perform private.send_push(
    n.to_user, 'drops',
    '💀 You owe a forfeit',
    my_name || ' picked yours: ' || words,
    jsonb_build_object('type', 'dare')
  );
  return new_id;
end;
$$;
revoke execute on function public.give_forfeit(uuid, text) from public, anon;
grant execute on function public.give_forfeit(uuid, text) to authenticated;

-- A post can be you paying a forfeit. The words are copied onto the post so feeds can show the 💀 tag.
alter table public.posts
  add column forfeit_id uuid references public.forfeits (id) on delete set null,
  add column forfeit_text text;

create or replace function private.check_forfeit_post()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  f public.forfeits%rowtype;
begin
  if tg_op = 'UPDATE' then
    new.forfeit_id := old.forfeit_id;                      -- can't be changed later
    new.forfeit_text := old.forfeit_text;
    return new;
  end if;
  if new.forfeit_id is null then
    new.forfeit_text := null;
    return new;
  end if;
  select * into f from public.forfeits where id = new.forfeit_id;
  if f.id is null or f.to_user <> new.user_id then
    raise exception 'That forfeit isn''t yours';
  end if;
  if f.done_at is not null then
    raise exception 'You already paid that forfeit';
  end if;
  new.forfeit_text := f.forfeit_text;
  return new;
end;
$$;

create trigger posts_check_forfeit
  before insert or update on public.posts
  for each row execute function private.check_forfeit_post();

-- Posting it pays the forfeit (and tells the friend who picked it).
create or replace function private.pay_forfeit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  f public.forfeits%rowtype;
  payer text;
begin
  if new.forfeit_id is null then
    return new;
  end if;
  update public.forfeits set done_at = now(), done_post_id = new.id where id = new.forfeit_id returning * into f;
  select coalesce(display_name, username) into payer from public.profiles where id = new.user_id;
  perform private.send_push(
    f.from_user, 'drops',
    '💀 Forfeit paid',
    payer || ' paid their forfeit. Go and look 👀',
    jsonb_build_object('type', 'post', 'post', new.id)
  );
  return new;
end;
$$;

create trigger posts_pay_forfeit
  after insert on public.posts
  for each row execute function private.pay_forfeit();
