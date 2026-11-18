// api/suggest.js 시험 · 전역 fetch를 가짜로 바꿔 실제 공공데이터와 오픈하사를 부르지 않고 확인합니다.
// 실행: 이 폴더에서  npm test   (또는  node --test)
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler, { AI_URL, MODEL, SYSTEM_PROMPT, parseSuggestions } from '../api/suggest.js';

const AI_KEY = 'sk-dev-test-0000';
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const GOOD = '1. 개천절 연휴에 서울 성곽길 걷기\n2. 한글날에 한글박물관 둘러보기\n3. 선선한 가을밤 한강 산책하기';

function call(query, init) {
  return handler.fetch(new Request(`http://localhost/api/suggest${query}`, init));
}

// 오픈하사가 돌려줄 응답(OpenAI 호환 모양)
function aiReply(content, tokens = 120) {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: tokens } }),
    { headers: { 'Content-Type': 'application/json' } });
}

// 가짜 fetch: 공공데이터 주소면 예시 공휴일, 오픈하사 주소면 정해 둔 응답을 차례로 돌려줍니다
function fakeServers({ holidays = 'rest-2026-10.json', ai = [() => aiReply(GOOD)] } = {}) {
  const queue = [...ai];
  return mock.method(globalThis, 'fetch', async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'apis.data.go.kr') {
      return new Response(await fixture(holidays), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.hostname === 'open.hasa.re.kr') {
      const next = queue.shift() ?? queue.at(-1) ?? ai.at(-1);
      return next(init);
    }
    throw new Error(`예상하지 못한 주소: ${url}`);
  });
}
const aiCalls = (fetchMock) => fetchMock.mock.calls.filter((c) => String(c.arguments[0]).startsWith('https://open.hasa.re.kr'));

let errorLog;
beforeEach(() => {
  process.env.DATA_GO_KR_KEY = 'test-data-key';
  process.env.HASA_API_KEY = AI_KEY;
  errorLog = mock.method(console, 'error', () => {});
});
afterEach(() => {
  mock.restoreAll();
  delete process.env.DATA_GO_KR_KEY;
  delete process.env.HASA_API_KEY;
});

test('정상: 공휴일을 근거로 추천 세 줄을 돌려주고, 하루 캐시한다', async () => {
  const servers = fakeServers();
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /s-maxage=86400/);
  const body = await res.json();
  assert.equal(body.year, 2026);
  assert.equal(body.month, 10);
  assert.equal(body.holidayCount, 3);
  assert.deepEqual(body.suggestions, ['개천절 연휴에 서울 성곽길 걷기', '한글날에 한글박물관 둘러보기', '선선한 가을밤 한강 산책하기']);
  assert.equal(body.model, MODEL);
  assert.equal(body.tokens, 120);
  assert.match(body.notice, /틀리거나/);

  // 오픈하사에 보낸 요청: 주소, 키 헤더, 모델, 지시문과 공휴일 목록
  const [sent] = aiCalls(servers);
  assert.equal(String(sent.arguments[0]), AI_URL);
  const init = sent.arguments[1];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${AI_KEY}`);
  assert.ok(init.signal instanceof AbortSignal, '시간 제한 신호를 함께 보낸다');
  const payload = JSON.parse(init.body);
  assert.equal(payload.model, 'gemma-4-31b');
  assert.equal(payload.max_tokens, 300);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, SYSTEM_PROMPT);
  assert.equal(payload.messages[1].role, 'user');
  assert.match(payload.messages[1].content, /2026년 10월/);
  assert.match(payload.messages[1].content, /10월 3일\(토\) 개천절 · 쉬는 날/);
  assert.match(payload.messages[1].content, /10월 9일\(금\) 한글날/);

  // 키는 응답에 들어가지 않는다
  assert.ok(!JSON.stringify(body).includes(AI_KEY));
});

test('공휴일이 없는 달도 "없음"이라고 알려 주고 추천을 받는다', async () => {
  const servers = fakeServers({ holidays: 'rest-2026-11.json' });
  const res = await call('?year=2026&month=11');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).holidayCount, 0);
  const payload = JSON.parse(aiCalls(servers)[0].arguments[1].body);
  assert.match(payload.messages[1].content, /공휴일: 없음/);
});

test('잘못된 연·월은 400이고, 공휴일도 AI도 부르지 않는다', async () => {
  const servers = fakeServers();
  for (const [query, code] of [
    ['?year=2026&month=13', 'BAD_MONTH'],
    ['?year=2026&month=abc', 'BAD_MONTH'],
    ['?year=26&month=1', 'BAD_YEAR'],
    ['?month=1', 'BAD_YEAR'],
  ]) {
    const res = await call(query);
    assert.equal(res.status, 400, query);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await res.json()).code, code, query);
  }
  assert.equal(servers.mock.callCount(), 0);
});

test('키가 없으면 500과 설정 안내를 돌려주고, 아무것도 부르지 않는다', async () => {
  const servers = fakeServers();
  for (const value of [undefined, '  ']) {
    if (value === undefined) delete process.env.HASA_API_KEY;
    else process.env.HASA_API_KEY = value;
    const res = await call('?year=2026&month=10');
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, 'NO_KEY');
    assert.match(body.hint, /HASA_API_KEY/);
  }
  assert.equal(servers.mock.callCount(), 0);
});

test('한도 초과(429)는 429와 하루 한도 안내, Retry-After를 그대로 전한다', async () => {
  fakeServers({ ai: [() => new Response('{"error":"rate limit"}', { status: 429, headers: { 'Retry-After': '30' } })] });
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.code, 'AI_LIMIT');
  assert.match(body.hint, /하루 500건/);
});

test('시간 초과는 504와 다시 시도 안내', async () => {
  fakeServers({ ai: [() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }] });
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 504);
  const body = await res.json();
  assert.equal(body.code, 'AI_TIMEOUT');
  assert.match(body.error, /20초/);
});

test('형식이 어긋난 답은 한 번 더 받고, 두 번째가 맞으면 200', async () => {
  const servers = fakeServers({ ai: [() => aiReply('좋은 질문이네요! 이번 달은 날씨가 좋아요.', 50), () => aiReply(GOOD, 100)] });
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.suggestions.length, 3);
  assert.equal(body.tokens, 150, '두 번 쓴 토큰을 합친다');
  assert.equal(aiCalls(servers).length, 2);
});

test('두 번 모두 형식이 어긋나면 502(AI_FORMAT)', async () => {
  const servers = fakeServers({ ai: [() => aiReply('추천할 게 없어요.')] });
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'AI_FORMAT');
  assert.equal(aiCalls(servers).length, 2);
});

test('키가 거절되면(401) 운영자 설정 문제로 500, 로그에 키를 남기지 않는다', async () => {
  fakeServers({ ai: [() => new Response(`{"error":"invalid key ${AI_KEY}"}`, { status: 401 })] });
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'AI_KEY');
  const logged = errorLog.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(logged, /HTTP 401/);
  assert.ok(!logged.includes(AI_KEY));
});

test('모델 이름이 틀리면(404) 502와 MODEL 확인 안내', async () => {
  fakeServers({ ai: [() => new Response('{"error":"model not found"}', { status: 404 })] });
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.code, 'AI_MODEL');
  assert.match(body.hint, /gemma-4-31b/);
});

test('공휴일 조회가 실패하면 AI를 부르지 않고 오류를 전한다', async () => {
  const servers = fakeServers({ holidays: 'error-limit.json' });
  const res = await call('?year=2026&month=10');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'HOLIDAYS_ERROR');
  assert.equal(aiCalls(servers).length, 0);
});

test('parseSuggestions: 마크다운 강조·괄호 번호도 읽고, 세 줄이 안 되면 null', () => {
  assert.deepEqual(parseSuggestions('**1. 가**\n2) 나\n- 3. 다\n4. 라'), ['가', '나', '다']);
  assert.equal(parseSuggestions('1. 가\n2. 나'), null);
  assert.equal(parseSuggestions(''), null);
  assert.equal(parseSuggestions(`1. ${'가'.repeat(81)}\n2. 나\n3. 다`), null);
});

test('GET이 아닌 요청은 405', async () => {
  const servers = fakeServers();
  const res = await call('?year=2026&month=10', { method: 'POST', body: 'x' });
  assert.equal(res.status, 405);
  assert.equal(servers.mock.callCount(), 0);
});
