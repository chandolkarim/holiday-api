-- 한 줄 방명록 표 · Supabase(guestbook-dev)의 SQL로 한 번 실행합니다.
-- 방문자(anon·authenticated)는 읽기만 합니다. 글쓰기는 api/guestbook.js가 입력을 검사한 뒤 서버의 secret 키로만 합니다.
-- drop·delete·truncate는 쓰지 않습니다. create ... if not exists라 표와 색인은 다시 실행해도 그대로입니다.

create table if not exists public.guestbook (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(btrim(name)) between 1 and 20),
  message    text not null check (char_length(btrim(message)) between 1 and 200),
  created_at timestamptz not null default now()
);
create index if not exists guestbook_created_at_idx on public.guestbook (created_at desc);

-- RLS를 켜면 정책이 허락한 일만 됩니다
alter table public.guestbook enable row level security;

-- 공개 역할은 모든 권한을 거둔 뒤 읽기(select)만 다시 줍니다
revoke all on table public.guestbook from anon, authenticated;
grant select on table public.guestbook to anon, authenticated;

-- 정책은 '누구나 읽기' 하나뿐입니다(insert·update·delete 정책 없음)
create policy "누구나 읽기" on public.guestbook
  for select to anon, authenticated using (true);

-- 서버(secret 키 = service_role)는 RLS를 건너뛰지만 표 권한은 따로 필요합니다.
-- 이 프로젝트는 새 표에 service_role 권한을 자동으로 주지 않으므로, 글쓰기에 필요한 두 가지만 줍니다(2026-11-11 확인)
grant select, insert on table public.guestbook to service_role;
