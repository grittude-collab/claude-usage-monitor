#!/usr/bin/env node
/**
 * AI Insights Generator
 * docs/data.json 을 읽어 Claude API 로 분석 → docs/insights.json 저장
 *
 * 환경변수: ANTHROPIC_API_KEY (필수)
 * 사용법:   node scripts/generate-insights.js
 */
const fs   = require('fs');
const path = require('path');
const https = require('https');

const DATA_FILE     = path.join(__dirname, '..', 'docs', 'data.json');
const INSIGHTS_FILE = path.join(__dirname, '..', 'docs', 'insights.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY 환경변수를 설정하세요');
  process.exit(1);
}
if (!fs.existsSync(DATA_FILE)) {
  console.error('❌ docs/data.json 없음 → 먼저 parse-usage.js 를 실행하세요');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));

// ── 분석용 요약 데이터 생성 (대화 내용 없음, 비용/토큰 수치만) ──
function buildSummaryForClaude(data) {
  const { meta, summary, daily, by_model, by_project, recent_sessions, current_session } = data;

  const dayAvg = daily.filter(d => d.cost_usd > 0);
  const avgDaily = dayAvg.length
    ? (dayAvg.reduce((a, d) => a + d.cost_usd, 0) / dayAvg.length).toFixed(4)
    : '0';
  const peakDay = daily.reduce((a, b) => b.cost_usd > a.cost_usd ? b : a, daily[0] || {});
  const zeroDays = daily.filter(d => d.cost_usd === 0).length;

  return {
    plan:           meta.plan,
    monthly_budget: meta.monthly_budget,
    generated_at:   meta.generated_at,
    summary: {
      today:      { cost: summary.today.cost_usd,      sessions: summary.today.sessions,      messages: summary.today.messages },
      this_week:  { cost: summary.this_week.cost_usd,  sessions: summary.this_week.sessions,  messages: summary.this_week.messages },
      this_month: { cost: summary.this_month.cost_usd, sessions: summary.this_month.sessions, messages: summary.this_month.messages },
      all_time:   { cost: summary.all_time.cost_usd,   sessions: summary.all_time.sessions,   messages: summary.all_time.messages },
    },
    patterns: {
      avg_daily_cost_usd: parseFloat(avgDaily),
      peak_day:  peakDay.date ? { date: peakDay.date, cost: peakDay.cost_usd } : null,
      zero_use_days_last30: zeroDays,
      active_days_last30:   30 - zeroDays,
      budget_used_pct: parseFloat(((summary.this_month.cost_usd / meta.monthly_budget) * 100).toFixed(1)),
      days_remaining_budget: parseFloat((Math.max(0, meta.monthly_budget - summary.this_month.cost_usd) /
        Math.max(0.001, parseFloat(avgDaily))).toFixed(0)),
    },
    by_model: by_model.map(m => ({
      model:         m.model,
      cost_usd:      m.cost_usd,
      sessions:      m.sessions,
      input_tokens:  m.input_tokens,
      output_tokens: m.output_tokens,
      share_pct:     summary.all_time.cost_usd > 0
        ? parseFloat(((m.cost_usd / summary.all_time.cost_usd) * 100).toFixed(1)) : 0,
    })),
    top_projects: by_project.slice(0, 8).map(p => ({
      project:  p.project,
      cost_usd: p.cost_usd,
      sessions: p.sessions,
      messages: p.messages,
    })),
    recent_sessions: recent_sessions.slice(0, 10).map(s => ({
      project:       s.project,
      model:         s.model,
      messages:      s.messages,
      cost_usd:      s.cost_usd,
      duration_mins: s.start && s.end
        ? Math.round((new Date(s.end) - new Date(s.start)) / 60000) : null,
    })),
    current_session: current_session ? {
      project:  current_session.project,
      model:    current_session.model,
      messages: current_session.messages,
      cost_usd: current_session.cost_usd,
    } : null,
  };
}

function callClaudeAPI(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `당신은 Claude Code 사용량 분석 전문가입니다.
사용자의 Claude API 사용 데이터를 분석하여 한국어로 구체적이고 실용적인 인사이트를 제공합니다.
응답은 반드시 아래 JSON 스키마만 출력하세요 (마크다운 코드블록 없이 순수 JSON):
{
  "headline": "한 줄 요약 (20자 이내)",
  "budget_status": "good|caution|warning",
  "insights": [
    { "type": "finding|tip|warning", "icon": "이모지", "title": "제목", "body": "본문 (2-3문장)" }
  ],
  "recommendations": [
    { "priority": "high|medium|low", "title": "제목", "detail": "구체적 실행 방법" }
  ],
  "efficiency_score": 0~100,
  "efficiency_reason": "점수 이유 (1문장)"
}`,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('🤖 Claude 로 사용량 분석 중…');

  const summary = buildSummaryForClaude(data);
  const prompt  = `다음은 내 Claude Code 사용 데이터입니다. 분석하여 JSON 인사이트를 생성해주세요:

${JSON.stringify(summary, null, 2)}

분석 시 중점적으로 확인할 사항:
1. 월 예산 대비 소비 속도 (이대로면 월말에 얼마나 쓸지)
2. 가장 비용이 많이 드는 모델/프로젝트
3. Haiku → Sonnet → Opus 모델 선택이 적절한지
4. 세션 당 평균 비용 이상치
5. 사용 패턴 (집중 사용일 vs 분산 사용)`;

  let rawText;
  try {
    rawText = await callClaudeAPI(prompt);
  } catch (e) {
    console.error('❌ Claude API 호출 실패:', e.message);
    process.exit(1);
  }

  let insights;
  try {
    insights = JSON.parse(rawText.trim());
  } catch {
    // Try extracting JSON from text
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) { console.error('❌ 응답 파싱 실패:\n', rawText); process.exit(1); }
    insights = JSON.parse(match[0]);
  }

  const output = { generated_at: new Date().toISOString(), ...insights };
  fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(output, null, 2));

  console.log(`✅ AI 인사이트 생성 완료 → docs/insights.json`);
  console.log(`   헤드라인: ${insights.headline}`);
  console.log(`   효율 점수: ${insights.efficiency_score}/100`);
}

main();
