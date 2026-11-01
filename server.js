/* 图文成片助手 · 本地后端（Node 内置模块，零 npm 依赖）
 * 作用：静态文件托管 + 代理阿里云百炼（OpenAI 兼容）多模态/文本模型。
 * 运行：node server.js  （Node 18+，内置 fetch） */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

/* ---------- 读取 .env ---------- */
function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').replace(/^﻿/, '');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (e) { /* no .env */ }
  return out;
}
const env = loadEnv();
// 云端部署时没有 .env 文件，配置走环境变量；本地仍以 .env 优先。
function pick(...names) {
  for (const n of names) {
    if (env[n]) return env[n];
    if (process.env[n]) return process.env[n];
  }
  return '';
}
const API_KEY = pick('BAILIAN_API_KEY', 'SILICONFLOW_API_KEY');
const BASE_URL = (pick('BAILIAN_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const VISION_MODEL = pick('VISION_MODEL') || 'qwen3-vl-plus';
const TEXT_MODEL = pick('TEXT_MODEL') || 'qwen3.8-max';
const PORT = parseInt(process.env.PORT || '8787', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req, limit) {
  limit = limit || 60 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

async function callLLM(model, messages, maxTokens) {
  const resp = await fetch(BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens || 2000, temperature: 0.7 })
  });
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error('upstream ' + resp.status + ': ' + text.slice(0, 300));
    err.status = resp.status;
    throw err;
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('bad json from upstream'); }
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('no content in upstream response');
  return content;
}

function extractJSON(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.search(/[\[{]/);
  const last = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

const ANALYZE_PROMPT =
  '你是一名图片分析助手。下面是一批旅行/生活照片，请逐张判断。' +
  '照片从 1 开始编号，顺序与我发给你的顺序一致。' +
  '对每张照片输出：category（只能是 美食/人像/风景/其他 之一）、' +
  'scene（4-8 字场景标签，如「下午茶」「园林」「夜市」「打卡照」）、' +
  'caption（一句话画面描述，10-20 字）、quality（0-10，综合清晰度、曝光、构图、主体突出）。' +
  '严格只输出 JSON 数组，不要任何额外文字。格式：' +
  '[{"id":1,"category":"美食","scene":"下午茶","caption":"…","quality":8}, …]';

const INTENT_PROMPT = `你是 MemoAI 的专业视觉策展师。你的任务是理解用户本次图文创作意图，而不是替用户决定固定审美。

产品原则：
1. 你有稳定的专业基础审美：整体协调、主次分明、节奏变化、表达真实、处理克制。
2. 不存在适合所有人的固定风格。根据用户本次表达动态理解视觉优先、叙事优先或平衡。
3. 区分技术缺陷与艺术表达。普通模糊、动态模糊、颗粒、自然抓拍可能有表达价值，不能一律视为废片。
4. 主体角色不等于图片数量比例。人物为主不意味着必须机械地选择大多数人物照片。
5. 只有当歧义会明显改变选图策略时才提出一个澄清问题。不要询问已明确的信息，不要为了问而问。
6. 结合素材概况判断需求是否可实现。不得虚构素材中不存在的内容。
7. 用户明确提出的保留与避免要求优先于你的推断。

请结合用户原始描述、补充回答、前一轮理解和素材概况，输出严格 JSON，不要 Markdown，不要额外解释。

JSON 格式：
{
  "needs_clarification": false,
  "clarifying_question": "",
  "question_options": [],
  "intent": {
    "title": "不超过18字的创作标题",
    "theme": "主题",
    "expression_goal": "表达目标",
    "subject_hierarchy": {"primary": [], "secondary": [], "accent": []},
    "mood": [],
    "visual_language": {"color_tone": [], "lighting": [], "composition": [], "texture": [], "style_references": []},
    "narrative": {"mode": "chronological|experience_story|mood_based|visual_editorial|freeform|adaptive|unknown", "description": "", "sequence_preference": ""},
    "creative_priority": {"mode": "visual_first|story_first|balanced|adaptive", "secondary_objective": ""},
    "processing_preference": {"retouch_strength": "none|light|medium|strong", "allow_intentional_blur": true, "allow_grain": true, "allow_strong_color_grading": false},
    "constraints": {"must_keep": [], "avoid_processing": [], "avoid_content": []},
    "selection_principles": [],
    "summary": "用1-2句话说明你理解的创作目标"
  }
}

问题生成规则：
- 如果 needs_clarification=true，必须提供一个具体、影响选图的单一问题。
- question_options 提供2-3个简短、结果导向的选项。
- 如果用户的意图足够明确，needs_clarification=false。
- 最多两轮追问；当轮数达到2时必须停止追问，输出当前最佳理解。
- 如果素材与意图明显不匹配，在 summary 或 selection_principles 中如实说明，不要假装可实现。`;

function copyPrompt(platform, count, context) {

  if (platform === '朋友圈') {
    return '你是朋友圈文案写手，语气像熟人、简短、克制、不夸张。根据下面的照片素材摘要，写 ' + count +
      ' 条候选文案（每条 1 句话为主，可带 1 个 emoji）。\n素材摘要：\n' + context +
      '\n严格只输出 JSON（不要任何额外文字）：{"copies":[{"title":"","body":"文案文本","tags":[]}, …]}';
  }
  return '你是小红书文案写手，风格种草感、有网感但不油腻。根据下面的照片素材摘要，写 ' + count +
    ' 条候选笔记，每条包含 title（抓眼球的标题，15 字内）、body（正文 60-120 字）、tags（3-5 个话题标签，以 # 开头）。\n素材摘要：\n' + context +
    '\n严格只输出 JSON（不要任何额外文字）：{"copies":[{"title":"标题","body":"正文","tags":["#a","#b"]}, …]}';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }

  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/status') {
      return send(res, 200, JSON.stringify({ ok: !!API_KEY, base: BASE_URL, vision: VISION_MODEL, text: TEXT_MODEL }));
    }

    if (req.method === 'POST' && pathname === '/api/analyze') {
      if (!API_KEY) return send(res, 400, JSON.stringify({ error: 'API key 未配置' }));
      const body = await readBody(req);
      const images = (body.images || []).slice(0, 8);
      if (!images.length) return send(res, 400, JSON.stringify({ error: 'no images' }));
      const content = [
        { type: 'text', text: ANALYZE_PROMPT },
        ...images.map(im => ({ type: 'image_url', image_url: { url: im.dataUrl } }))
      ];
      const raw = await callLLM(VISION_MODEL, [{ role: 'user', content }], 3000);
      let results = [];
      try { const p = extractJSON(raw); if (Array.isArray(p)) results = p; } catch (e) { /* fall through */ }
      return send(res, 200, JSON.stringify({ raw, results }));
    }

    if (req.method === 'POST' && pathname === '/api/intent') {
      if (!API_KEY) return send(res, 400, JSON.stringify({ error: 'API Key 未配置' }));
      const body = await readBody(req, 2 * 1024 * 1024);
      const userText = String(body.userText || '').trim();
      if (!userText) return send(res, 400, JSON.stringify({ error: '请先输入创作想法' }));
      const payload = {
        user_text: userText.slice(0, 4000),
        latest_answer: String(body.answer || '').slice(0, 1000),
        previous_intent: body.previousIntent || null,
        previous_answers: Array.isArray(body.answers) ? body.answers.slice(-2) : [],
        asset_summary: body.assetSummary || null,
        clarification_round: Math.max(0, Math.min(2, Number(body.round) || 0))
      };
      const raw = await callLLM(TEXT_MODEL, [
        { role: 'system', content: INTENT_PROMPT },
        { role: 'user', content: JSON.stringify(payload) }
      ], 2200);
      let result;
      try { result = extractJSON(raw); }
      catch (e) { return send(res, 502, JSON.stringify({ error: '模型返回格式无法解析，请重试' })); }
      if (!result || typeof result !== 'object') return send(res, 502, JSON.stringify({ error: '模型未返回有效创作意图' }));
      return send(res, 200, JSON.stringify({ result }));
    }

    if (req.method === 'POST' && pathname === '/api/copy') {
      if (!API_KEY) return send(res, 400, JSON.stringify({ error: 'API key 未配置' }));
      const body = await readBody(req);
      const prompt = copyPrompt(body.platform || '朋友圈', body.count || 3, String(body.context || ''));
      const raw = await callLLM(TEXT_MODEL, [{ role: 'user', content: prompt }], 3000);
      let copies = [];
      try { const p = extractJSON(raw); if (p && Array.isArray(p.copies)) copies = p.copies; } catch (e) { /* fall through */ }
      return send(res, 200, JSON.stringify({ raw, copies }));
    }

    if (req.method === 'GET') {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = path.resolve(ROOT, rel);
      const relative = path.relative(ROOT, file);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(file) && fs.statSync(file).isFile() && !path.basename(file).startsWith('.env')) {
        const ext = path.extname(file).toLowerCase();
        return send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
      }
      return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    }

    send(res, 404, 'not found', 'text/plain; charset=utf-8');
  } catch (e) {
    send(res, e.status || 500, JSON.stringify({ error: e.message }));
  }
});

const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log('MemoAI 本地服务已启动: http://localhost:' + PORT);
  console.log('API key:', API_KEY ? ('已配置，' + API_KEY.length + ' 位') : '未配置（请在 .env 填入）');
  console.log('Base:', BASE_URL);
  console.log('Vision:', VISION_MODEL, '| Text:', TEXT_MODEL);
});
