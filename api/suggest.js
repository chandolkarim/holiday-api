// 연·월을 받아 그달 공휴일을 조회하고, 오픈하사(Open HASA) AI 모델로 '이 달에 해 볼 만한 일' 세 가지를 추천하는 Vercel 함수입니다.
//
//   주소    /api/suggest?year=2026&month=11
//   AI      오픈하사 https://open.hasa.re.kr/v1/chat/completions (OpenAI 호환 형식), 모델 gemma-4-31b
//   인증키  Vercel 환경 변수 HASA_API_KEY (코드·저장소·로그·응답에는 적지 않습니다)
//
// 흐름: ① 입력 검사 → ② 키 확인 → ③ 공휴일 조회(api/holidays.js를 그대로 부름) → ④ AI 호출 → ⑤ 형식 검사(어긋나면 한 번 더) → ⑥ 돌려주기
//
// AI에 보내는 것: 공휴일 목록(공공데이터)과 연·월뿐입니다. 사용자가 쓴 글이나 개인정보는 보내지 않습니다.
import holidays from './holidays.js';

export const AI_URL = 'https://open.hasa.re.kr/v1/chat/completions';
export const MODEL = 'gemma-4-31b';   // 수업 기본값. 오픈하사 모델 목록(/v1/models)의 이름과 같아야 합니다
const TIMEOUT_MS = 20000;             // AI를 기다리는 최대 시간(다시 받기까지 합쳐서)
const MAX_TOKENS = 300;               // 답 길이 상한
const MAX_ATTEMPTS = 2;               // 형식이 어긋나면 한 번 더 받습니다
const LINE_MAX = 80;                  // 한 줄이 이보다 길면 형식이 어긋난 것으로 봅니다(지시는 40자)
// 같은 연·월의 추천은 CDN이 하루 보관합니다. 개발키는 하루 500건이라, 같은 달을 여러 사람이 눌러도 AI는 한 번만 부릅니다
const CACHE_OK = 'public, s-maxage=86400, stale-while-revalidate=86400';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 지시문(시스템 프롬프트): 역할 · 형식 · 근거 · 금지. 사용자 입력과 섞이지 않도록 함수 안에 고정해 둡니다
export const SYSTEM_PROMPT = [
  '너는 한국외국어대학교 학생에게 그달의 공휴일을 활용할 방법을 제안하는 도우미다.',
  '형식: 번호를 붙인 세 줄로만 답한다. 예) "1. …". 한 줄은 40자 안의 한국어 한 문장이다. 머리말, 맺음말, 빈 줄, 마크다운 강조는 쓰지 않는다.',
  '근거: 아래에 주는 연·월과 공휴일 목록, 그 달의 계절만 근거로 삼는다. 목록에 없는 공휴일이나 행사, 날짜를 지어내지 않는다.',
  '금지: 특정 업체·상품 광고, 개인정보(이름·연락처·학번) 언급, 위험하거나 불법인 활동. 모르는 것은 추천하지 않는다.',
].join('\n');

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, 'METHOD', '이 주소는 GET 요청만 받습니다.');
    }

    // ① 입력 검사: 잘못된 입력은 공휴일도 AI도 부르기 전에 400
    const params = new URL(request.url).searchParams;
    const yearText = (params.get('year') ?? '').trim();
    const monthText = (params.get('month') ?? '').trim();
    if (!/^\d{4}$/.test(yearText) || Number(yearText) < 2000 || Number(yearText) > 2099) {
      return fail(400, 'BAD_YEAR', 'year는 2000~2099 사이의 네 자리 연도로 보냅니다. 예: ?year=2026&month=11');
    }
    if (!/^\d{1,2}$/.test(monthText) || Number(monthText) < 1 || Number(monthText) > 12) {
      return fail(400, 'BAD_MONTH', 'month는 1~12 사이의 숫자로 보냅니다. 예: ?year=2026&month=11');
    }
    const year = Number(yearText);
    const month = Number(monthText);

    // ② 키 확인: 오픈하사 키는 Vercel 환경 변수에만 둡니다
    const key = String(process.env.HASA_API_KEY ?? '').trim();
    if (!key) {
      console.error('[suggest] 환경 변수 HASA_API_KEY가 없습니다.');
      return fail(500, 'NO_KEY', '서버에 AI(오픈하사) 키가 설정되지 않았습니다. 운영자 설정 문제입니다.', {
        hint: 'Vercel 프로젝트 Settings → Environment Variables에 HASA_API_KEY를 추가한 뒤 다시 배포합니다.',
      });
    }

    // ③ 공휴일 조회: 같은 서버 안에서 api/holidays.js를 그대로 부릅니다(코드를 두 번 쓰지 않음)
    const holidayRes = await holidays.fetch(new Request(`http://internal/api/holidays?year=${year}&month=${month}`));
    const holidayData = await holidayRes.json().catch(() => null);
    if (!holidayRes.ok || !holidayData) {
      return fail(holidayRes.status === 500 ? 500 : 502, 'HOLIDAYS_ERROR',
        `추천에 쓸 공휴일 정보를 불러오지 못했습니다${holidayData?.error ? `: ${holidayData.error}` : '.'}`,
        holidayData?.hint ? { hint: holidayData.hint } : {});
    }

    // ④~⑤ AI 호출과 형식 검사. 시간 제한은 다시 받기까지 합쳐 20초입니다
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: describeMonth(year, month, holidayData.items ?? []) },
    ];
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let tokens = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await askAI(key, messages, signal, year, month);
      if (result.response) return result.response; // 오류 응답
      tokens += result.tokens;
      const suggestions = parseSuggestions(result.content);
      if (suggestions) {
        // ⑥ 돌려주기
        return Response.json({
          year, month,
          holidayCount: holidayData.count ?? 0,
          suggestions,
          model: MODEL,
          tokens,
          notice: 'AI가 만든 추천이라 틀리거나 어색할 수 있습니다.',
          generatedAt: new Date().toISOString(),
        }, { headers: { 'Cache-Control': CACHE_OK } });
      }
      console.error(`[suggest] 형식이 맞지 않는 답 (${attempt}/${MAX_ATTEMPTS}번째, ${year}-${month})`);
    }
    return fail(502, 'AI_FORMAT', 'AI가 약속한 형식(번호 붙인 세 줄)으로 답하지 않았습니다. 다시 시도해 주세요.');
  },
};

// AI에 보낼 사용자 메시지: 공공데이터에서 받은 공휴일 목록만 담습니다
export function describeMonth(year, month, items) {
  const lines = items.map((item) => {
    const [y, m, d] = item.date.split('-').map(Number);
    const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `- ${m}월 ${d}일(${weekday}) ${item.name}${item.holiday ? ' · 쉬는 날' : ''}`;
  });
  return [
    `${year}년 ${month}월에 해 볼 만한 일 세 가지를 추천해 줘.`,
    lines.length ? `이 달의 공휴일:\n${lines.join('\n')}` : '이 달의 공휴일: 없음 (주말과 계절을 활용하는 방법으로 추천해 줘)',
  ].join('\n');
}

// 오픈하사 호출 한 번. 성공하면 { content, tokens }, 실패하면 { response: 화면에 돌려줄 오류 }
async function askAI(key, messages, signal, year, month) {
  let res;
  try {
    res = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: MAX_TOKENS, temperature: 0.7 }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      console.error(`[suggest] ${TIMEOUT_MS / 1000}초 시간 초과 (${year}-${month})`);
      return { response: fail(504, 'AI_TIMEOUT', `AI가 ${TIMEOUT_MS / 1000}초 안에 답하지 않았습니다. 잠시 뒤 다시 시도해 주세요.`) };
    }
    console.error(`[suggest] 오픈하사 연결 실패 ${error?.name ?? ''} (${year}-${month})`);
    return { response: fail(502, 'AI_NETWORK', 'AI 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.') };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[suggest] 오픈하사 HTTP ${res.status} ${detail.slice(0, 200).replaceAll(key, '***')} (${year}-${month})`);
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      return {
        response: fail(429, 'AI_LIMIT', 'AI 사용 한도를 넘었습니다. 잠시 뒤 다시 시도해 주세요.', {
          hint: '개발키는 분당 10회, 하루 500건까지입니다(하루 한도는 자정에 초기화).',
        }, retryAfter ? { 'Retry-After': retryAfter } : {}),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        response: fail(500, 'AI_KEY', 'AI 키가 거절되었습니다. 운영자 설정 문제입니다.', {
          hint: 'HASA_API_KEY 값이 오픈하사에서 발급한 개발키(sk-dev-…)와 같은지 확인하고 다시 배포합니다.',
        }),
      };
    }
    if (res.status === 404 || (res.status === 400 && /model/i.test(detail))) {
      return {
        response: fail(502, 'AI_MODEL', 'AI 모델을 찾지 못했습니다.', {
          hint: `api/suggest.js의 MODEL(${MODEL})이 오픈하사 모델 목록(/v1/models)의 이름과 같은지 확인합니다.`,
        }),
      };
    }
    return { response: fail(502, 'AI_HTTP', `AI 서버가 HTTP ${res.status} 오류로 답했습니다. 잠시 뒤 다시 시도해 주세요.`) };
  }

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  return { content: typeof content === 'string' ? content : '', tokens: Number(data?.usage?.total_tokens) || 0 };
}

// "1. …\n2. …\n3. …" 에서 세 줄을 꺼냅니다. 형식이 어긋나면 null
export function parseSuggestions(content) {
  const lines = String(content ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^(?:[-*]\s*)?\**\s*(\d)\s*[.)]\s*\**\s*(.+?)\s*\**$/))
    .filter(Boolean)
    .map((match) => match[2].replace(/\*\*/g, '').trim());
  if (lines.length < 3) return null;
  const three = lines.slice(0, 3);
  if (three.some((line) => !line || line.length > LINE_MAX)) return null;
  return three;
}

// 오류 응답: 상태 코드와 한국어 안내를 JSON으로 보내고, 캐시에는 저장하지 않습니다
function fail(status, code, message, extra = {}, headers = {}) {
  return Response.json({ error: message, code, ...extra }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}
