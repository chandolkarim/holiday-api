// api/guestbook.js 시험 · 전역 fetch를 가짜(모의)로 바꿔 실제 Supabase를 부르지 않고 확인합니다.
// 실행: 이 폴더에서  npm test   (또는  node --test)
// 키는 가짜 값입니다. 실제 키는 Vercel 환경 변수에만 둡니다.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import handler, { validateEntry, NAME_MAX, MESSAGE_MAX } from '../api/guestbook.js';

const URL_ = 'https://example-project.supabase.co';
const PUBLISHABLE = 'sb_publishable_test_0000';
const SECRET = 'sb_secret_test_0000';

// 브라우저가 /api/guestbook을 부른 것처럼 함수에 요청을 보냅니다
function call(init) {
  return handler.fetch(new Request('http://localhost/api/guestbook', init));
}
function post(body) {
  return call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

// Supabase(PostgREST) 흉내: 받은 요청을 기록하고, 정해 둔 응답을 돌려줍니다
function fakeSupabase(body, { status = 200 } = {}) {
  return mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}
function sent(fetchMock, i = 0) {
  const [input, init = {}] = fetchMock.mock.calls[i].arguments;
  const request = input instanceof Request ? input : null;
  return {
    url: new URL(String(request ? request.url : input)),
    method: request ? request.method : (init.method ?? 'GET'),
    headers: new Headers(request ? request.headers : init.headers),
    body: init.body,
  };
}
// 응답 본문·로그 어디에도 키가 없어야 합니다
function assertNoKey(text) {
  assert.ok(!text.includes('sb_'), text);
  assert.ok(!text.includes(PUBLISHABLE) && !text.includes(SECRET), text);
}

let errorLog;
beforeEach(() => {
  process.env.SUPABASE_URL = URL_;
  process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE;
  process.env.SUPABASE_SECRET_KEY = SECRET;
  errorLog = mock.method(console, 'error', () => {});
});
afterEach(() => {
  mock.restoreAll();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_SECRET_KEY;
});

// ── 입력 검사(validateEntry) ─────────────────────────────────────────

test('입력 검사: 경계값 (이름 1~20자, 내용 1~200자, 앞뒤 공백은 지운 뒤 셈)', () => {
  assert.equal(NAME_MAX, 20);
  assert.equal(MESSAGE_MAX, 200);
  const ok = (name, message) => validateEntry({ name, message });
  assert.deepEqual(ok('  민지 ', ' 안녕하세요 '), { ok: true, name: '민지', message: '안녕하세요' });
  assert.equal(ok('a', 'b').ok, true, '1자');
  assert.equal(ok('가'.repeat(20), '나'.repeat(200)).ok, true, '20자·200자');
  assert.equal(ok('가'.repeat(21), '안녕').code, 'BAD_NAME', '21자');
  assert.equal(ok('민지', '나'.repeat(201)).code, 'BAD_MESSAGE', '201자');
  assert.equal(ok('', '안녕').code, 'BAD_NAME', '빈 이름');
  assert.equal(ok('   ', '안녕').code, 'BAD_NAME', '공백만');
  assert.equal(ok('민지', '  ').code, 'BAD_MESSAGE', '공백만');
  assert.equal(ok('민지', `${'나'.repeat(200)}   `).ok, true, '뒤 공백은 지운 뒤 셈');
});

test('입력 검사: 이모지는 한 글자로 세고, 줄바꿈·탭·제어문자는 받지 않는다', () => {
  assert.equal(validateEntry({ name: '😀'.repeat(20), message: '안녕' }).ok, true, '이모지 20개');
  assert.equal(validateEntry({ name: '😀'.repeat(21), message: '안녕' }).code, 'BAD_NAME');
  assert.equal(validateEntry({ name: '민지', message: '첫 줄\n둘째 줄' }).code, 'BAD_MESSAGE');
  assert.equal(validateEntry({ name: '민\t지', message: '안녕' }).code, 'BAD_NAME');
  assert.equal(validateEntry({ name: '민지', message: '안녕\u0000' }).code, 'BAD_MESSAGE');
  assert.equal(validateEntry({ name: '민지', message: '안녕\u2028하세요' }).code, 'BAD_MESSAGE');
});

test('입력 검사: 모양이 틀린 본문', () => {
  assert.equal(validateEntry(null).code, 'BAD_JSON');
  assert.equal(validateEntry([]).code, 'BAD_JSON');
  assert.equal(validateEntry('안녕').code, 'BAD_JSON');
  assert.equal(validateEntry({ message: '안녕' }).code, 'BAD_NAME');
  assert.equal(validateEntry({ name: 123, message: '안녕' }).code, 'BAD_NAME');
  assert.equal(validateEntry({ name: '민지' }).code, 'BAD_MESSAGE');
  assert.equal(validateEntry({ name: '민지', message: ['안녕'] }).code, 'BAD_MESSAGE');
});

// ── POST ────────────────────────────────────────────────────────────

test('잘못된 POST는 400이고, Supabase를 부르지 않는다', async () => {
  const upstream = fakeSupabase({});
  const cases = [
    ['not json', 'BAD_JSON'],
    ['', 'BAD_JSON'],
    ['null', 'BAD_JSON'],
    [JSON.stringify({ name: 'a', message: 'x'.repeat(5000) }), 'BAD_JSON'], // 2KB 초과
    [{ name: '', message: '안녕' }, 'BAD_NAME'],
    [{ name: '가'.repeat(21), message: '안녕' }, 'BAD_NAME'],
    [{ name: '민지', message: '' }, 'BAD_MESSAGE'],
    [{ name: '민지', message: '나'.repeat(201) }, 'BAD_MESSAGE'],
    [{ name: '민지', message: '<b>첫 줄</b>\n둘째 줄' }, 'BAD_MESSAGE'],
  ];
  for (const [body, code] of cases) {
    const res = await post(body);
    assert.equal(res.status, 400, String(body).slice(0, 40));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const json = await res.json();
    assert.equal(json.code, code, String(body).slice(0, 40));
    assert.ok(json.error.length > 0);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('정상 POST: secret 키로 공백을 지운 값을 저장하고 201을 돌려준다', async () => {
  const row = { id: 7, name: '민지', message: '<script>안녕</script>', created_at: '2026-11-11T06:00:00+00:00' };
  const upstream = fakeSupabase(row, { status: 201 });
  const res = await post({ name: ' 민지 ', message: ' <script>안녕</script> ', extra: '무시' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), {
    item: { id: 7, name: '민지', message: '<script>안녕</script>', createdAt: '2026-11-11T06:00:00+00:00' },
  });
  assertNoKey(text);

  assert.equal(upstream.mock.callCount(), 1);
  const req = sent(upstream);
  assert.equal(`${req.url.origin}${req.url.pathname}`, `${URL_}/rest/v1/guestbook`);
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.get('apikey'), SECRET, '쓰기는 secret 키');
  assert.deepEqual(JSON.parse(req.body), { name: '민지', message: '<script>안녕</script>' }, '검사한 두 필드만 보낸다');
});

test('secret 키가 없으면 POST는 500 NO_KEY이고, Supabase를 부르지 않는다', async () => {
  const upstream = fakeSupabase({});
  for (const value of [undefined, '   ']) {
    if (value === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = value;
    const res = await post({ name: '민지', message: '안녕' });
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.equal(json.code, 'NO_KEY');
    assert.match(json.hint, /SUPABASE_SECRET_KEY/);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('Supabase가 거절하면(권한 42501, 제약 23514) 502', async () => {
  for (const [status, code] of [[401, '42501'], [400, '23514']]) {
    const upstream = fakeSupabase({ code, message: 'denied', details: null, hint: null }, { status });
    const res = await post({ name: '민지', message: '안녕' });
    assert.equal(res.status, 502);
    const text = await res.text();
    const json = JSON.parse(text);
    assert.equal(json.code, 'UPSTREAM_ERROR');
    assert.equal(json.upstreamCode, code);
    assertNoKey(text);
    upstream.mock.restore();
  }
  const logged = errorLog.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(logged, /42501/);
  assertNoKey(logged);
});

// ── GET ─────────────────────────────────────────────────────────────

test('GET: publishable 키로 최근 20개를 새 글부터 읽어 200을 돌려준다', async () => {
  const upstream = fakeSupabase([
    { id: 2, name: '하늘', message: '둘째', created_at: '2026-11-11T07:00:00+00:00' },
    { id: 1, name: '민지', message: '첫째', created_at: '2026-11-11T06:00:00+00:00' },
  ]);
  const res = await call();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  const json = JSON.parse(text);
  assert.equal(json.count, 2);
  assert.deepEqual(json.items.map((item) => item.id), [2, 1]);
  assert.equal(json.items[0].createdAt, '2026-11-11T07:00:00+00:00');
  assertNoKey(text);

  const req = sent(upstream);
  assert.equal(`${req.url.origin}${req.url.pathname}`, `${URL_}/rest/v1/guestbook`);
  assert.equal(req.method, 'GET');
  assert.equal(req.headers.get('apikey'), PUBLISHABLE, '읽기는 publishable 키');
  assert.equal(req.url.searchParams.get('order'), 'created_at.desc');
  assert.equal(req.url.searchParams.get('limit'), '20');
  assert.match(req.url.searchParams.get('select'), /id,name,message,created_at/);
});

test('GET: 글이 없으면 빈 목록(200)', async () => {
  fakeSupabase([]);
  const res = await call();
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { count: 0, items: [] });
});

test('GET: publishable 키나 주소가 없으면 500 NO_KEY', async () => {
  const upstream = fakeSupabase([]);
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  let json = await (await call()).json();
  assert.equal(json.code, 'NO_KEY');
  assert.match(json.hint, /SUPABASE_PUBLISHABLE_KEY/);
  process.env.SUPABASE_PUBLISHABLE_KEY = PUBLISHABLE;
  delete process.env.SUPABASE_URL;
  json = await (await call()).json();
  assert.equal(json.code, 'NO_KEY');
  assert.equal(upstream.mock.callCount(), 0);
});

test('GET: Supabase 5xx는 502, 다시 시도하지 않고 한 번만 부른다', async () => {
  const upstream = fakeSupabase({ message: 'Service Unavailable' }, { status: 503 });
  const res = await call();
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'UPSTREAM_ERROR');
  assert.equal(upstream.mock.callCount(), 1);
});

test('연결 실패는 502 UPSTREAM_NETWORK, 시간 초과는 502 UPSTREAM_TIMEOUT', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  let res = await post({ name: '민지', message: '안녕' });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'UPSTREAM_NETWORK');
  mock.restoreAll();
  mock.method(console, 'error', () => {});

  mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  res = await call();
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.code, 'UPSTREAM_TIMEOUT');
  assert.match(json.error, /8초/);
});

test('GET·POST가 아닌 요청은 405', async () => {
  const upstream = fakeSupabase({});
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await call({ method, body: method === 'DELETE' ? undefined : 'x' });
    assert.equal(res.status, 405, method);
  }
  assert.equal(upstream.mock.callCount(), 0);
});
