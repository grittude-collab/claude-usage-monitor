#!/usr/bin/env node
/**
 * Claude Code Usage Parser
 * ~/.claude/projects/ 의 JSONL 로그를 읽어 docs/data.json 으로 출력
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const OUTPUT_FILE = path.join(__dirname, '..', 'docs', 'data.json');

const PLAN = process.env.CLAUDE_PLAN || 'max_5x';
const PLAN_BUDGETS = { pro: 20, max_5x: 100, max_20x: 200 };
const MONTHLY_BUDGET = parseFloat(process.env.MONTHLY_BUDGET || String(PLAN_BUDGETS[PLAN] || 100));

function decodeProjectName(dirName) {
  // e.g. "-Users-username-Documents-my-project" → "my-project"
  // Strip leading dashes and common OS path segments
  const cleaned = dirName.replace(/^-+/, '').replace(/^(c|d|e|Users|home|mnt)-[^-]+-/i, '');
  const parts = cleaned.split('-').filter(p => p && p.length > 1 && !/^\d+$/.test(p));
  return parts.slice(-2).join('-') || dirName;
}

// Model pricing (API equivalent, for subscription users who don't have costUSD)
const PRICING = {
  'claude-opus-4-7':           { input: 15,  output: 75,   cache_read: 1.5,   cache_write: 18.75 },
  'claude-opus-4-6':           { input: 15,  output: 75,   cache_read: 1.5,   cache_write: 18.75 },
  'claude-sonnet-4-6':         { input: 3,   output: 15,   cache_read: 0.30,  cache_write: 3.75  },
  'claude-sonnet-4-5':         { input: 3,   output: 15,   cache_read: 0.30,  cache_write: 3.75  },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4,    cache_read: 0.08,  cache_write: 1.0   },
  'claude-haiku-4-5':          { input: 0.8, output: 4,    cache_read: 0.08,  cache_write: 1.0   },
};
function estimateCost(model, inp, out, cacheRead, cacheWrite) {
  const p = PRICING[model] || { input: 3, output: 15, cache_read: 0.30, cache_write: 3.75 };
  return (inp * p.input + out * p.output + cacheRead * p.cache_read + cacheWrite * p.cache_write) / 1e6;
}

function parseJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function processSession(filePath, projectDirName) {
  const entries = parseJsonl(filePath);
  if (!entries.length) return null;

  const sessionId = path.basename(filePath, '.jsonl');
  const project = decodeProjectName(projectDirName);

  let inputTokens = 0, outputTokens = 0, cacheCreation = 0, cacheRead = 0;
  let costUSD = 0, model = null, messages = 0;
  const timestamps = [];
  let cwdProject = null;

  for (const e of entries) {
    if (e.timestamp) timestamps.push(e.timestamp);
    // Extract project name from cwd field (more reliable)
    if (!cwdProject && e.cwd) {
      cwdProject = e.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || null;
    }
    if (e.type !== 'assistant' || !e.message?.usage) continue;

    const { usage } = e.message;
    messages++;
    if (!model) model = e.message.model || null;
    inputTokens   += usage.input_tokens || 0;
    outputTokens  += usage.output_tokens || 0;
    cacheCreation += usage.cache_creation_input_tokens || 0;
    cacheRead     += usage.cache_read_input_tokens || 0;
    costUSD       += e.costUSD || 0;
  }

  if (!messages) return null;
  timestamps.sort();

  // Pro/Max subscription: costUSD is 0 — calculate API-equivalent cost from tokens
  if (costUSD === 0 && model && model !== '<synthetic>') {
    costUSD = estimateCost(model, inputTokens, outputTokens, cacheRead, cacheCreation);
  }

  const projectName = cwdProject || project;

  return {
    id: sessionId,
    project: projectName,
    model: model || 'unknown',
    start: timestamps[0] || null,
    end:   timestamps[timestamps.length - 1] || null,
    input_tokens:          inputTokens,
    output_tokens:         outputTokens,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens:     cacheRead,
    cost_usd: parseFloat(costUSD.toFixed(6)),
    messages,
  };
}

function addToSummary(s, p) {
  p.cost_usd     += s.cost_usd;
  p.input_tokens  += s.input_tokens;
  p.output_tokens += s.output_tokens;
  p.messages      += s.messages;
  p.sessions++;
}

function main() {
  if (!fs.existsSync(CLAUDE_DIR)) {
    console.error(`❌ Claude 프로젝트 폴더를 찾을 수 없음: ${CLAUDE_DIR}`);
    process.exit(1);
  }

  const sessions = [];

  for (const dirName of fs.readdirSync(CLAUDE_DIR)) {
    const dirPath = path.join(CLAUDE_DIR, dirName);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'))) {
      const s = processSession(path.join(dirPath, file), dirName);
      if (s) sessions.push(s);
    }
  }

  sessions.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  const now = new Date();
  const todayStr  = now.toISOString().slice(0, 10);
  const weekAgo   = new Date(now - 7 * 864e5);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const summary = {
    today:      { cost_usd: 0, input_tokens: 0, output_tokens: 0, messages: 0, sessions: 0 },
    this_week:  { cost_usd: 0, input_tokens: 0, output_tokens: 0, messages: 0, sessions: 0 },
    this_month: { cost_usd: 0, input_tokens: 0, output_tokens: 0, messages: 0, sessions: 0 },
    all_time:   { cost_usd: 0, input_tokens: 0, output_tokens: 0, messages: 0, sessions: 0 },
  };

  const dailyMap = {}, byModel = {}, byProject = {};

  for (const s of sessions) {
    const d       = s.start ? new Date(s.start) : null;
    const dateStr = s.start?.slice(0, 10) || null;

    addToSummary(s, summary.all_time);
    if (dateStr === todayStr)   addToSummary(s, summary.today);
    if (d && d >= weekAgo)      addToSummary(s, summary.this_week);
    if (d && d >= monthStart)   addToSummary(s, summary.this_month);

    if (dateStr) {
      const day = dailyMap[dateStr] = dailyMap[dateStr] ||
        { date: dateStr, cost_usd: 0, input_tokens: 0, output_tokens: 0, sessions: 0 };
      day.cost_usd     += s.cost_usd;
      day.input_tokens  += s.input_tokens;
      day.output_tokens += s.output_tokens;
      day.sessions++;
    }

    const m = byModel[s.model] = byModel[s.model] ||
      { model: s.model, cost_usd: 0, input_tokens: 0, output_tokens: 0, sessions: 0 };
    m.cost_usd += s.cost_usd; m.input_tokens += s.input_tokens;
    m.output_tokens += s.output_tokens; m.sessions++;

    const p = byProject[s.project] = byProject[s.project] ||
      { project: s.project, cost_usd: 0, sessions: 0, messages: 0 };
    p.cost_usd += s.cost_usd; p.sessions++; p.messages += s.messages;
  }

  // Round summary costs
  for (const p of Object.values(summary)) p.cost_usd = Math.round(p.cost_usd * 100) / 100;

  // Last 30 days
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const ds = new Date(now - i * 864e5).toISOString().slice(0, 10);
    daily.push(dailyMap[ds] || { date: ds, cost_usd: 0, input_tokens: 0, output_tokens: 0, sessions: 0 });
  }

  const output = {
    meta: {
      generated_at:   now.toISOString(),
      plan:           PLAN,
      monthly_budget: MONTHLY_BUDGET,
      total_sessions: sessions.length,
    },
    current_session: sessions.at(-1) || null,
    summary,
    daily,
    by_model:    Object.values(byModel).sort((a, b) => b.cost_usd - a.cost_usd),
    by_project:  Object.values(byProject).sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 15),
    recent_sessions: sessions.slice(-20).reverse(),
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`✅ ${sessions.length}개 세션 → docs/data.json`);
  console.log(`   이번 달: $${summary.this_month.cost_usd} / $${MONTHLY_BUDGET} (${((summary.this_month.cost_usd / MONTHLY_BUDGET) * 100).toFixed(1)}%)`);
  console.log(`   전체:    $${summary.all_time.cost_usd.toFixed(4)}`);
}

main();
