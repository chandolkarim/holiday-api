// 한 줄 방명록 Vercel 함수 · Supabase 표 public.guestbook(supabase/guestbook.sql)을 읽고 씁니다.
//
//   GET  /api/guestbook                        최근 20개 (publishable 키, RLS '누구나 읽기' 정책으로 읽음)
//   POST /api/guestbook  {"name":"…","message":"…"}  입력 검사 뒤 저장 (secret 키, 이 파일 안에서만 씀)
//
//   환경 변수  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (코드·저장소·로그·응답에는 적지 않습니다)
//
// 흐름: ① 방법 확인 → ② (POST) 본문 읽기와 입력 검사 → ③ 키 확인 → ④ Supabase 호출 → ⑤ 결과 확인 → ⑥ 정리해서 돌려주기
import { createClient } from '@supabase/supabase-js';

const TABLE = 'guestbook';
const COLUMNS = 'id, name, message, created_at';
const LIMIT = 20;            // 목록에 보여 줄 최근 글 수
const TIMEOUT_MS = 8000;     // Supabase를 기다리는 최대 시간
const MAX_BODY = 2048;       // POST 본문 최대 크기(바이트). 이름 20자 + 내용 200자면 충분합니다
export const NAME_MAX = 20;
export const MESSAGE_MAX = 200;
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/; // 줄바꿈·탭 같은 제어문자(한 줄 방명록이라 받지 않음)

export default {
  async fetch(request) {
    // ① 방법 확인
    if (request.method === 'GET' || request.method === 'HEAD') return list();
    if (request.method === 'POST') return create(request);
    return fail(405, 'METHOD', '이 주소는 GET(목록)과 POST(글쓰기)만 받습니다.');
  },
};

async function list() {
  // ③ 키 확인: 읽기는 공개용 publishable 키로 합니다(RLS가 select만 허락)
  const client = connect(process.env.SUPABASE_PUBLISHABLE_KEY);
  if (!client) return noKey('SUPABASE_PUBLISHABLE_KEY');

  // ④ 호출: 최근 글 20개
  const { data, error, status } = await run(() => client
    .from(TABLE).select(COLUMNS).order('created_at', { ascending: false }).limit(LIMIT));

  // ⑤ 결과 확인 → ⑥ 정리
  if (error) return upstreamError('GET', error, status);
  const items = (data ?? []).map(toEntry);
  return Response.json({ count: items.length, items }, { headers: { 'Cache-Control': 'no-store' } }); // 새 글이 바로 보이도록 캐시하지 않습니다
}

async function create(request) {
  // ② 본문 읽기와 입력 검사: 잘못된 입력은 Supabase를 부르기 전에 400으로 돌려보냅니다
  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY) {
      return fail(400, 'BAD_JSON', `본문이 너무 큽니다(최대 ${MAX_BODY}바이트).`);
    }
    body = JSON.parse(text);
  } catch {
    return fail(400, 'BAD_JSON', '본문은 JSON으로 보냅니다. 예: {"name":"민지","message":"안녕하세요"}');
  }
  const checked = validateEntry(body);
  if (!checked.ok) return fail(400, checked.code, checked.error);

  // ③ 키 확인: 쓰기는 서버 전용 secret 키로만 합니다(공개 역할에는 insert 권한이 없음)
  const client = connect(process.env.SUPABASE_SECRET_KEY);
  if (!client) return noKey('SUPABASE_SECRET_KEY');

  // ④ 호출: 저장하고 저장된 줄을 돌려받습니다
  const { data, error, status } = await run(() => client
    .from(TABLE).insert({ name: checked.name, message: checked.message }).select(COLUMNS).single());

  // ⑤ 결과 확인 → ⑥ 정리
  if (error) return upstreamError('POST', error, status);
  return Response.json({ item: toEntry(data) }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}

// 입력 검사: 앞뒤 공백을 지운 뒤 이름 1~20자, 내용 1~200자, 제어문자 없음. 글자 수는 화면에 보이는 글자(이모지 포함) 기준입니다
export function validateEntry(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'BAD_JSON', error: '본문은 {"name":"…","message":"…"} 모양의 JSON으로 보냅니다.' };
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (typeof body.name !== 'string' || CONTROL.test(name) || count(name) < 1 || count(name) > NAME_MAX) {
    return { ok: false, code: 'BAD_NAME', error: `이름은 1~${NAME_MAX}자로, 한 줄로 적습니다.` };
  }
  if (typeof body.message !== 'string' || CONTROL.test(message) || count(message) < 1 || count(message) > MESSAGE_MAX) {
    return { ok: false, code: 'BAD_MESSAGE', error: `내용은 1~${MESSAGE_MAX}자로, 한 줄로 적습니다.` };
  }
  return { ok: true, name, message };
}

// Postgres char_length와 같은 기준(유니코드 코드 포인트)으로 셉니다
function count(text) {
  return [...text].length;
}

// 요청마다 클라이언트를 만듭니다. 서버 함수라 로그인 세션은 저장하지 않습니다
function connect(rawKey) {
  const url = String(process.env.SUPABASE_URL ?? '').trim();
  const key = String(rawKey ?? '').trim();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// 시간 제한을 걸고, 다시 시도는 화면의 '다시 시도' 버튼에 맡깁니다
async function run(build) {
  try {
    return await build().retry(false).abortSignal(AbortSignal.timeout(TIMEOUT_MS));
  } catch (error) {
    return { data: null, status: 0, error: { name: error?.name, message: `${error?.name ?? 'Error'}: ${error?.message ?? ''}`, code: '' } };
  }
}

function toEntry(row) {
  return { id: row.id, name: row.name, message: row.message, createdAt: row.created_at };
}

// 오류 응답: 상태 코드와 한국어 안내를 JSON으로 보내고, 캐시에는 저장하지 않습니다
function fail(status, code, message, extra = {}) {
  return Response.json({ error: message, code, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function noKey(name) {
  console.error(`[guestbook] 환경 변수 SUPABASE_URL 또는 ${name}가 없습니다.`);
  return fail(500, 'NO_KEY', '서버에 Supabase 연결 정보가 설정되지 않았습니다.', {
    hint: `Vercel 프로젝트 Settings → Environment Variables에 SUPABASE_URL과 ${name}를 추가한 뒤 다시 배포합니다.`,
  });
}

// Supabase 오류는 원인(코드·상태)만 로그에 남기고, 화면에는 다시 시도 안내를 보냅니다. 키 값은 어디에도 적지 않습니다
function upstreamError(method, error, status) {
  const message = String(error?.message ?? '');
  const timedOut = /TimeoutError|AbortError/.test(message);
  console.error(`[guestbook] ${method} Supabase 오류 HTTP ${status || '-'} 코드 ${error?.code || '-'} ${timedOut ? '시간 초과' : message.slice(0, 120)}`);
  if (timedOut) {
    return fail(502, 'UPSTREAM_TIMEOUT', `Supabase가 ${TIMEOUT_MS / 1000}초 안에 답하지 않았습니다. 잠시 뒤 다시 시도해 주세요.`);
  }
  if (!status) {
    return fail(502, 'UPSTREAM_NETWORK', 'Supabase에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  }
  return fail(502, 'UPSTREAM_ERROR', `Supabase가 오류를 알렸습니다(HTTP ${status}). 잠시 뒤 다시 시도해 주세요.`, {
    upstreamCode: error?.code || null,
    hint: status === 401 || status === 403 || error?.code === '42501'
      ? '키 종류(읽기=publishable, 쓰기=secret)와 표 권한(supabase/guestbook.sql)을 확인합니다.'
      : '잠시 뒤 다시 시도하고, 계속되면 Vercel Logs와 Supabase 대시보드를 확인합니다.',
  });
}
