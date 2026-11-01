/* MemoAI · v0.3 UI/UX 改进版
 * 浏览器前端：真实导入 → 本地特征 → 模型分析(分类/场景/评分) → 约束成组 →
 * 颜色迁移 → (可选)拼图 → 模型文案 → 导出成片。
 * 发布方式：单图直出（默认，选几张发几张）/ 拼图模式（想发的图超过单次发布张数时用）。
 * 需配合 server.js 运行：node server.js 后访问 http://localhost:8787 */

const API_BASE = location.protocol === 'file:' ? 'http://localhost:8787' : '';

/* ---------- 工具 ---------- */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHTML(value) { return String(value == null ? '' : value).replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch])); }
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });
}
function imgToDataURL(img, maxDim, quality) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const sc = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * sc)), h = Math.max(1, Math.round(ih * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality || 0.85);
}

/* ---------- 全局状态 ---------- */
const state = {
  step: 1,
  platform: '朋友圈',
  totalCount: 9,
  collageMode: false,      // 单图直出(false) / 拼图模式(true)
  perCollage: 2,           // 每张拼几张
  collageLayoutIdx: 0,     // 0=网格 1=首图放大
  quotas: { 美食: 0, 人像: 0, 风景: 0, 其他: 0 },
  photos: [],               // {id,name,thumb,work,sharpness,brightness,hue,sat,category,scene,caption,quality}
  importing: false, importDone: 0, importTotal: 0, importFailed: 0,
  analyzing: false, analyzed: false, analyzeDone: 0, analyzeTotal: 0, analysisMode: 'pending',
  intentText: '', intentBusy: false, intentRound: 0, intentQuestion: null, intentQuestionOptions: [],
  intentAnalysis: null, intentConfirmed: false, intentMode: 'none', intentAnswers: [],
  replacingId: null, processingProgress: { toneDone: 0, toneTotal: 0, toneStatus: 'pending', copyStatus: 'pending' }, processingError: null, copyMode: 'model',
  advancedOpen: false,
  apiOk: false, apiInfo: null,
  groups: [], groupsSig: null,
  selectedGroup: null, groupPhotos: [], baseId: null,
  processingDone: false, procStarted: false, processingMsg: '',
  processed: {},            // photoId -> 校色后 dataURL
  copyIdx: 0, toneOn: true,
  copies: [], exporting: false
};

let nextId = 1;
const fileInput = document.createElement('input');
fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true;
fileInput.onchange = () => { const chosen = fileInput.files; handleFiles(chosen); fileInput.value = ''; };

/* ---------- 预置文案（后端不可用时的兜底） ---------- */
const FALLBACK_COPIES = {
  朋友圈: [
    { title: '', body: '苏州两日，慢下来的时光 ☕️', tags: [] },
    { title: '', body: '和喜欢的人，去了喜欢的地方。', tags: [] },
    { title: '', body: '周末放空：走走停停，吃吃喝喝。', tags: [] }
  ],
  小红书: [
    { title: '苏州两日游｜人均200的松弛感路线', body: '上周去了趟苏州，没赶景点，就是慢慢逛。平江路的小店、园林里的光影、一碗热乎乎的糖粥，都刚刚好。', tags: ['#苏州旅行', '#周末去哪儿', '#松弛感'] },
    { title: '藏在平江路的宝藏小店，被我找到了', body: '跟着导航走错三次，才撞进这家店。甜口的赤豆小圆子、软糯的桂花糕，坐一下午也不赶人。', tags: ['#平江路', '#宝藏店铺', '#苏州美食'] },
    { title: '把一次出行，认真整理成九张图', body: '相册里躺了一百多张，最后能打的就这九张。选图交给 AI，我只负责确认。', tags: ['#图文成片', '#苏州', '#修图'] }
  ]
};

/* ---------- 拼图版式（每张拼 k 张时的版面） ---------- */
function collageLayout(variantIdx, k) {
  if (variantIdx === 1) {
    // 首图放大：首图占满上部，其余在下方网格
    const cols = 2, rows = 1 + Math.ceil((k - 1) / 2);
    const cells = [{ x: 0, y: 0, w: 2, h: 1 }];
    let idx = 1;
    for (let r = 1; r < rows; r++) for (let cc = 0; cc < cols; cc++) { if (idx >= k) break; cells.push({ x: cc, y: r, w: 1, h: 1 }); idx++; }
    return { name: '首图放大', cols, rows, cells, title: state.platform === '小红书' };
  }
  // 网格
  const cols = Math.ceil(Math.sqrt(k)), rows = Math.ceil(k / cols);
  const cells = [];
  for (let i = 0; i < k; i++) cells.push({ x: i % cols, y: Math.floor(i / cols), w: 1, h: 1 });
  return { name: '网格 ' + cols + '×' + rows, cols, rows, cells, title: state.platform === '小红书' };
}

/* ---------- 线性图标（仿参考图 · Feather 风格 1.5px 描边） ---------- */
const ICONS = {
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  coffee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M2 8h16v8a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"/><line x1="6" y1="2" x2="6" y2="5"/><line x1="10" y1="2" x2="10" y2="5"/><line x1="14" y1="2" x2="14" y2="5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  mountain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19h18L15 7l-3 5-3-4z"/><circle cx="17" cy="5" r="1.5"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.2 9a2.8 2.8 0 0 1 5.6.6c0 1.8-2.8 2.6-2.8 3.6"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  palette: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="9" r="1"/><circle cx="7" cy="14" r="1"/><circle cx="16" cy="14" r="1"/><path d="M12 21a3 3 0 0 1-3-3c0-1.2 1.4-1.6 1.4-3"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="2" x2="9" y2="4"/><line x1="15" y1="2" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="22"/><line x1="15" y1="20" x2="15" y2="22"/><line x1="20" y1="9" x2="22" y2="9"/><line x1="20" y1="15" x2="22" y2="15"/><line x1="2" y1="9" x2="4" y2="9"/><line x1="2" y1="15" x2="4" y2="15"/></svg>',
  export: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 21h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
};

function icon(name, size) {
  return '<span class="ico" style="width:' + (size || 20) + 'px;height:' + (size || 20) + 'px;">' + (ICONS[name] || '') + '</span>';
}

function sectionHead(num, title, note) {
  return '<div class="section-head"><div class="sec-title">' + title + '</div>' + (note ? '<div class="sec-note">' + note + '</div>' : '') + '</div>';
}

/* ---------- 本地图像特征 ---------- */
function computeFeatures(img) {
  const s = 64;
  const c = document.createElement('canvas'); c.width = s; c.height = s;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, s, s);
  const d = ctx.getImageData(0, 0, s, s).data;
  const n = s * s;
  const gray = new Float32Array(n);
  let rSum = 0, gSum = 0, bSum = 0, satSum = 0, lumSum = 0;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = l; lumSum += l; rSum += r; gSum += g; bSum += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += (mx + mn) > 0 ? (mx - mn) / Math.max(1, mx + mn) : 0;
  }
  let lap = 0;
  for (let y = 1; y < s - 1; y++) for (let x = 1; x < s - 1; x++) {
    const i = y * s + x;
    const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - s] - gray[i + s];
    lap += v * v;
  }
  const sharpness = lap / ((s - 2) * (s - 2));
  const avgR = rSum / n, avgG = gSum / n, avgB = bSum / n;
  const mx = Math.max(avgR, avgG, avgB), mn = Math.min(avgR, avgG, avgB), dd = mx - mn;
  let hue = 0;
  if (dd > 1) {
    if (mx === avgR) hue = ((avgG - avgB) / dd) % 6;
    else if (mx === avgG) hue = (avgB - avgR) / dd + 2;
    else hue = (avgR - avgG) / dd + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const ph = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let acc = 0;
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) acc += gray[(y * 8 + yy) * s + (x * 8 + xx)];
    ph.push(acc / 64);
  }
  const pm = ph.reduce((a, b) => a + b, 0) / ph.length;
  const phash = ph.map(v => v >= pm ? '1' : '0').join('');
  return { sharpness, brightness: lumSum / n, hue, sat: satSum / n, phash };
}

/* ---------- 导入 ---------- */
function triggerImport() { fileInput.click(); }

async function handleFiles(files) {
  const incoming = Array.from(files || []).filter(f => f.type && f.type.startsWith('image/'));
  const available = Math.max(0, 100 - state.photos.length);
  const list = incoming.slice(0, available);
  if (!list.length) {
    toast(available <= 0 ? '当前项目最多支持 100 张照片，请先移除部分素材或重新开始。' : '没有识别到可导入的图片');
    return;
  }
  state.importing = true;
  state.importDone = 0;
  state.importTotal = list.length;
  state.importFailed = 0;
  render();
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    let url = null;
    try {
      url = URL.createObjectURL(f);
      const img = await loadImage(url);
      const thumb = imgToDataURL(img, 180, 0.82);
      const work = imgToDataURL(img, 1024, 0.86);
      const feats = computeFeatures(img);
      state.photos.push(Object.assign({ id: nextId++, name: f.name, thumb, work, category: null, scene: '', caption: '', quality: null }, feats));
    } catch (e) {
      state.importFailed++;
    } finally {
      if (url) URL.revokeObjectURL(url);
      state.importDone = i + 1;
      if ((i + 1) % 4 === 0 || i === list.length - 1) render();
    }
  }
  assignLocalQuality();
  state.quotas = state.analyzed ? suggestedQuotas() : equalQuotas(materialCount());
  state.analyzed = false;
  state.importing = false;
  render();
  toast('本次成功导入 ' + (list.length - state.importFailed) + ' 张' + (state.importFailed ? '，' + state.importFailed + ' 张读取失败' : ''));
  if (incoming.length > list.length) toast('单个项目最多保留 100 张，超出部分未导入');
  if (state.apiOk && state.apiInfo && state.apiInfo.ok) {
    startAnalyze();
  } else {
    state.photos.forEach(ph => { if (!ph.category) { ph.category = guessCategory(ph); ph.scene = ''; ph.caption = ''; } });
    state.analyzed = true;
    state.analysisMode = 'local';
    state.quotas = suggestedQuotas();
    render();
  }
}

function assignLocalQuality() {
  const sorted = state.photos.map(p => p.sharpness).sort((a, b) => a - b);
  state.photos.forEach(p => {
    let lo = 0; for (const s of sorted) if (s < p.sharpness) lo++;
    p.quality = sorted.length > 1 ? Math.round((lo / (sorted.length - 1)) * 100) / 10 : 5;
  });
}
function equalQuotas(total) {
  const cats = ['美食', '人像', '风景', '其他'];
  const o = {}; cats.forEach(c => o[c] = 0);
  let left = total, k = 0;
  while (left > 0) { o[cats[k % cats.length]]++; left--; k++; }
  return o;
}

/* ---------- 素材数 / 成片槽位 ---------- */
function materialCount() { return state.collageMode ? state.totalCount * state.perCollage : state.totalCount; }
function slots() {
  if (!state.collageMode) return state.groupPhotos.map(p => [p]);
  const out = []; const k = state.perCollage;
  for (let i = 0; i < state.groupPhotos.length; i += k) out.push(state.groupPhotos.slice(i, i + k));
  return out;
}

/* ---------- 模型分析（分类 / 场景 / 评分） ---------- */
function normalizeCategory(c) { return (c === '美食' || c === '人像' || c === '风景' || c === '其他') ? c : '其他'; }
function guessCategory(p) {
  const h = p.hue;
  if (h >= 60 && h < 270) return '风景';
  if (p.sat < 0.12) return '其他';
  return '美食';
}

async function analyzeBatch(batch) {
  const images = [];
  for (const ph of batch) {
    let src = ph.work;
    try { const im = await loadImage(ph.work); src = imgToDataURL(im, 512, 0.8); } catch (e) { /* use work */ }
    images.push({ dataUrl: src });
  }
  const response = await fetch(API_BASE + '/api/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images })
  });
  const res = await response.json();
  if (!response.ok) throw new Error(res.error || '图片分析请求失败');
  const results = res.results || [];
  if (!results.length) return null;
  results.forEach((r, idx) => {
    const ph = batch[parseInt(r.id) - 1] || batch[idx];
    if (!ph) return;
    ph.category = normalizeCategory(r.category);
    ph.scene = r.scene || '';
    ph.caption = r.caption || '';
    const q = parseFloat(r.quality);
    if (!isNaN(q)) ph.quality = clamp(q, 0, 10);
  });
  return true;
}
async function analyzeOne(ph) {
  try {
    const response = await fetch(API_BASE + '/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: [{ dataUrl: ph.work }] })
    });
    const res = await response.json();
    if (!response.ok) throw new Error(res.error || '单图分析失败');
    const r = (res.results || [])[0];
    if (r) {
      ph.category = normalizeCategory(r.category);
      ph.scene = r.scene || '';
      ph.caption = r.caption || '';
      const q = parseFloat(r.quality);
      if (!isNaN(q)) ph.quality = clamp(q, 0, 10);
    }
  } catch (e) { /* ignore */ }
}

async function startAnalyze() {
  if (state.analyzing || state.analyzed) return;
  state.analyzing = true;
  state.analysisMode = 'model';
  state.analyzeDone = 0;
  state.analyzeTotal = state.photos.length;
  render();
  const batchSize = 6;
  let usedFallback = false;
  for (let i = 0; i < state.photos.length; i += batchSize) {
    const batch = state.photos.slice(i, i + batchSize);
    let ok = false;
    try { ok = !!(await analyzeBatch(batch)); } catch (e) { ok = false; }
    if (!ok) {
      usedFallback = true;
      for (const ph of batch) await analyzeOne(ph);
    }
    state.analyzeDone = Math.min(state.photos.length, i + batchSize);
    render();
  }
  state.photos.forEach(ph => {
    if (!ph.category) { ph.category = guessCategory(ph); ph.scene = ''; ph.caption = ''; usedFallback = true; }
  });
  state.analyzed = true;
  state.analyzing = false;
  state.analysisMode = usedFallback ? 'mixed' : 'model';
  state.quotas = suggestedQuotas();
  render();
  if (usedFallback) toast('部分照片未能完成模型分析，已使用本地特征补全');
}

function suggestedQuotas() {
  const cats = ['美食', '人像', '风景', '其他'];
  const counts = {}; cats.forEach(c => counts[c] = 0);
  state.photos.forEach(p => { if (counts[p.category] != null) counts[p.category]++; });
  const sum = Math.max(1, state.photos.length);
  const total = materialCount();
  const o = {};
  cats.forEach(c => o[c] = Math.floor(counts[c] / sum * total));
  return o;
}
function poolCount(cat) { return state.photos.filter(p => p.category === cat).length; }

/* ---------- 成组（约束 + 策略） ---------- */
function quotaSum() { return ['美食', '人像', '风景', '其他'].reduce((a, c) => a + (state.quotas[c] || 0), 0); }
function quotaError() { return quotaSum() > materialCount() ? '配额之和超过素材数，请调减。' : null; }

function resolvedCounts() {
  const cats = ['美食', '人像', '风景', '其他'];
  const base = {}; cats.forEach(c => base[c] = state.quotas[c] || 0);
  let left = materialCount() - cats.reduce((a, c) => a + base[c], 0);
  if (left > 0) {
    const order = cats.slice().sort((a, b) => poolCount(b) - poolCount(a));
    let k = 0;
    while (left > 0) { base[order[k % order.length]]++; left--; k++; }
  }
  return base;
}

/* 将确认后的创作意图转换为成组策略（参考 PRD：derived_policy）
   主体层级决定软优先级，创作优先级决定叙事/视觉侧重，修图倾向决定模糊容忍度。 */
function subjectCategoryOf(term) {
  const t = String(term || '');
  if (/人物|人像|自己|朋友|合照|自拍|人脸/.test(t)) return '人像';
  if (/风景|建筑|环境|街景|城市|山|海|天空|自然/.test(t)) return '风景';
  if (/美食|食物|餐厅|探店|咖啡|甜品|小吃|聚餐|餐/.test(t)) return '美食';
  if (/细节|细碎|瞬间|特写|物件|生活|桌面|餐具/.test(t)) return '其他';
  return null;
}

function deriveGroupingPolicy() {
  const a = state.intentAnalysis;
  if (!state.intentConfirmed || !a) return null;
  const h = a.subject_hierarchy || {};
  const pri = a.creative_priority || {};
  const nar = a.narrative || {};
  const proc = a.processing_preference || {};
  const mode = pri.mode || 'adaptive';

  const subjectPriority = { 美食: 'normal', 人像: 'normal', 风景: 'normal', 其他: 'normal' };
  (h.primary || []).forEach(t => { const c = subjectCategoryOf(t); if (c) subjectPriority[c] = 'high'; });
  (h.secondary || []).forEach(t => { const c = subjectCategoryOf(t); if (c && subjectPriority[c] === 'normal') subjectPriority[c] = 'supporting'; });
  (h.accent || []).forEach(t => { const c = subjectCategoryOf(t); if (c && subjectPriority[c] === 'normal') subjectPriority[c] = 'accent'; });

  const mood = a.mood || [];
  const text = String(a.summary || '') + String(state.intentText || '');
  const wantsConsistentColor = mood.some(m => /清冷|安静|克制|电影|高级|复古|胶片/.test(m)) || ((a.visual_language && a.visual_language.color_tone) || []).length > 0;
  const blurTolerant = proc.allow_intentional_blur === true || /松弛|自然|随手拍|抓拍|生活|真实|烟/.test(text);
  const storyFirst = mode === 'story_first' || (nar.mode === 'experience_story');
  const visualFirst = mode === 'visual_first' || wantsConsistentColor;
  const objective = storyFirst ? 'story_first' : (visualFirst ? 'visual_first' : 'balanced');

  return {
    objective,
    subjectPriority,
    colorConsistency: objective === 'visual_first' ? 'high' : (objective === 'balanced' ? 'medium' : 'low'),
    blurTolerant,
    narrativeMode: nar.mode || 'freeform'
  };
}

function buildGroups() {
  const policy = deriveGroupingPolicy();
  const counts = resolvedCounts();
  const sceneFreq = {};
  state.photos.forEach(p => { if (p.scene) sceneFreq[p.scene] = (sceneFreq[p.scene] || 0) + 1; });
  const hues = state.photos.map(p => p.hue).filter(h => h != null);
  const targetHue = hues.length ? hues.slice().sort((a, b) => a - b)[Math.floor(hues.length / 2)] : 30;
  const hueDist = (h, t) => Math.min(Math.abs(h - t), 360 - Math.abs(h - t));

  // 主体层级软优先（不等于照片数量占比）：核心主体抬分，辅助次之，细节再次之
  const subjBoost = { high: 2.2, supporting: 1.2, accent: 0.6, normal: 0 };
  const boostOf = ph => policy ? (subjBoost[policy.subjectPriority[ph.category] || 'normal'] || 0) : 0;
  const colorScore = ph => ph.hue == null ? 0 : Math.max(0, 1 - hueDist(ph.hue, targetHue) / 60);
  // 质量：区分技术缺陷与艺术表达——生活化/抓拍意图下不把普通模糊一刀切淘汰
  const qualityOf = ph => {
    let q = ph.quality != null ? ph.quality : 5;
    if (policy && policy.blurTolerant && ph.sharpness != null) q = Math.max(q, 5.5);
    return q;
  };

  // 类别填充顺序：意图中的高优先级主体优先被填满
  const fillOrder = ['美食', '人像', '风景', '其他'].slice().sort((a, b) =>
    (subjBoost[policy && policy.subjectPriority[a] || 'normal'] || 0) - (subjBoost[policy && policy.subjectPriority[b] || 'normal'] || 0)
  ).reverse();

  const rankSubject = pool => pool.slice().sort((a, b) => ((qualityOf(b) + boostOf(b)) - (qualityOf(a) + boostOf(a))));
  const rankVisual = pool => pool.slice().sort((a, b) => ((colorScore(b) + boostOf(b) * 0.5) - (colorScore(a) + boostOf(a) * 0.5)) || (qualityOf(b) - qualityOf(a)));
  const rankRich = pool => pool.slice().sort((a, b) => ((sceneFreq[a.scene] || 99) - (sceneFreq[b.scene] || 99)) || (qualityOf(b) - qualityOf(a)));

  function pick(rankFn) {
    const photos = [];
    fillOrder.forEach(cat => {
      const pool = state.photos.filter(p => p.category === cat);
      photos.push(...rankFn(pool).slice(0, counts[cat] || 0));
    });
    return photos;
  }

  // 叙事排序：按叙事模式整理顺序（无时间戳，用场景/色相构造节奏）
  function arrange(photos) {
    const mode = policy ? policy.narrativeMode : 'freeform';
    const arcRank = { 风景: 0, 美食: 1, 人像: 1, 其他: 2 };
    if (mode === 'experience_story' || (policy && policy.objective === 'story_first')) {
      return photos.slice().sort((a, b) => (arcRank[a.category] - arcRank[b.category]) || String(a.scene || '').localeCompare(String(b.scene || '')));
    }
    if (mode === 'mood_based') {
      return photos.slice().sort((a, b) => (a.hue - b.hue));
    }
    return photos;
  }

  const strategies = [
    { title: '主题优先', subtitle: '贴合创作意图，突出核心主体', rank: rankSubject },
    { title: '视觉统一', subtitle: '优先选择色调接近本批素材中位值的照片', rank: rankVisual },
    { title: '内容丰富', subtitle: '优先覆盖不同场景，让内容更有层次', rank: rankRich }
  ];

  return strategies.map(st => {
    const photos = arrange(pick(st.rank));
    const base = photos.slice().sort((a, b) => qualityOf(b) - qualityOf(a))[0];
    const scenes = new Set(photos.map(p => p.scene).filter(Boolean)).size;
    const avgQ = photos.length ? Math.round(photos.reduce((a, p) => a + (p.quality || 0), 0) / photos.length * 10) / 10 : 0;
    let reason;
    if (st.title === '主题优先') reason = '按创作意图中的主体层级优先选择（核心主体 > 辅助 > 细节），并兼顾单图质量与场景变化。';
    else if (st.title === '视觉统一') reason = '优先选择色相接近本批素材中位值的照片，便于后续统一色调；色彩一致性优先级 ' + (policy ? policy.colorConsistency : 'medium') + '。';
    else reason = '优先覆盖不同场景，共覆盖 ' + scenes + ' 类场景。此策略按场景覆盖度生成，尚未实现完整的两两兼容与叙事优化。';
    return { title: st.title, subtitle: st.subtitle, reason, photos, baseId: base ? base.id : null, scenes, avgQ };
  });
}

function groupsSig() {
  const intentKey = state.intentConfirmed && state.intentAnalysis ? JSON.stringify({ goal: state.intentAnalysis.expression_goal, hierarchy: state.intentAnalysis.subject_hierarchy, mood: state.intentAnalysis.mood, priority: state.intentAnalysis.creative_priority, narrative: state.intentAnalysis.narrative, proc: state.intentAnalysis.processing_preference }) : 'none';
  return state.platform + '|' + state.totalCount + '|' + state.collageMode + '|' + state.perCollage + '|' + ['美食', '人像', '风景', '其他'].map(c => state.quotas[c]).join(',') + '|' + (state.analyzed ? '1' : '0') + '|' + intentKey;
}
function ensureGroups() {
  const s = groupsSig();
  if (state.groupsSig !== s) {
    state.groupsSig = s;
    state.groups = buildGroups();
    state.selectedGroup = null;
    state.groupPhotos = [];
    state.baseId = null;
    state.processed = {};
    state.processingDone = false; state.procStarted = false;
  }
}

/* ---------- 颜色迁移（RGB 统计对齐，简化 Reinhard） ---------- */
async function colorTransfer(srcUrl, baseUrl, maxDim) {
  const [srcImg, baseImg] = await Promise.all([loadImage(srcUrl), loadImage(baseUrl)]);
  const toData = (img, max) => {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const sc = Math.min(1, max / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * sc)), h = Math.max(1, Math.round(ih * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  };
  const sd = toData(srcImg, maxDim), bd = toData(baseImg, maxDim);
  const stats = (d) => {
    const n = d.width * d.height; let mr = 0, mg = 0, mb = 0;
    for (let i = 0; i < n; i++) { mr += d.data[i * 4]; mg += d.data[i * 4 + 1]; mb += d.data[i * 4 + 2]; }
    mr /= n; mg /= n; mb /= n;
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < n; i++) { const r = d.data[i * 4] - mr, g = d.data[i * 4 + 1] - mg, b = d.data[i * 4 + 2] - mb; sr += r * r; sg += g * g; sb += b * b; }
    return { mr, mg, mb, sr: Math.sqrt(sr / n), sg: Math.sqrt(sg / n), sb: Math.sqrt(sb / n) };
  };
  const bs = stats(bd), ss = stats(sd);
  const out = document.createElement('canvas'); out.width = sd.width; out.height = sd.height;
  const octx = out.getContext('2d');
  const od = octx.createImageData(sd.width, sd.height);
  const n = sd.width * sd.height;
  const kr = bs.sr / Math.max(1e-6, ss.sr), kg = bs.sg / Math.max(1e-6, ss.sg), kb = bs.sb / Math.max(1e-6, ss.sb);
  for (let i = 0; i < n; i++) {
    od.data[i * 4] = clamp(Math.round((sd.data[i * 4] - ss.mr) * kr + bs.mr), 0, 255);
    od.data[i * 4 + 1] = clamp(Math.round((sd.data[i * 4 + 1] - ss.mg) * kg + bs.mg), 0, 255);
    od.data[i * 4 + 2] = clamp(Math.round((sd.data[i * 4 + 2] - ss.mb) * kb + bs.mb), 0, 255);
    od.data[i * 4 + 3] = 255;
  }
  octx.putImageData(od, 0, 0);
  return out.toDataURL('image/jpeg', 0.9);
}

/* ---------- Canvas 绘制 ---------- */
function photoSrc(ph) {
  if (state.toneOn && ph.id !== state.baseId && state.processed[ph.id]) return state.processed[ph.id];
  return ph.work || ph.thumb;
}
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}
async function renderLayoutCanvas(layout, photos, width, title) {
  const isSq = state.platform === '朋友圈';
  const height = Math.round(width * (isSq ? 1 : 4 / 3));
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  if (layout.bg) { ctx.fillStyle = layout.bg; ctx.fillRect(0, 0, width, height); }
  const gap = layout.gap || 4;
  const cols = layout.cols, rows = layout.rows;
  const cellW = (width - gap * (cols + 1)) / cols;
  const cellH = (height - gap * (rows + 1)) / rows;
  const used = layout.cells.map((_, i) => photos[i % photos.length]).filter(Boolean);
  const imgs = {};
  await Promise.all([...new Set(used)].map(async ph => { try { imgs[ph.id] = await loadImage(photoSrc(ph)); } catch (e) { /* skip */ } }));
  layout.cells.forEach((cell, i) => {
    const ph = photos[i % photos.length];
    if (!ph || !imgs[ph.id]) return;
    const x = gap + cell.x * (cellW + gap);
    const y = gap + cell.y * (cellH + gap);
    const w = cell.w * cellW + (cell.w - 1) * gap;
    const h = cell.h * cellH + (cell.h - 1) * gap;
    drawCover(ctx, imgs[ph.id], x, y, w, h);
    if (layout.title && cell.x === 0 && cell.y === 0 && title) {
      const fh = Math.max(14, Math.round(cellW * 0.16));
      ctx.font = 'bold ' + fh + 'px sans-serif';
      const bgH = fh + 14;
      const gy = y + h - bgH;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, gy, w, bgH);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      let t = title;
      while (t && ctx.measureText(t).width > w - 12) t = t.slice(0, -1);
      ctx.fillText(t, x + 6, gy + bgH / 2 + 1);
    }
  });
  return c;
}

/* ---------- 创作意图理解 ---------- */
function updateIntentText(value) {
  state.intentText = value;
  state.intentConfirmed = false;
  state.intentAnalysis = null;
  state.intentQuestion = null;
  state.intentQuestionOptions = [];
  state.intentRound = 0;
  state.intentAnswers = [];
  const stalePanel = document.querySelector ? document.querySelector('.intent-card, .intent-question') : null;
  if (stalePanel) stalePanel.remove();
  const nextButton = document.querySelector ? document.querySelector('.step-cta .btn-primary') : null;
  if (nextButton) nextButton.disabled = true;
  const analyzeBtn = document.getElementById('intentAnalyzeBtn');
  if (analyzeBtn) analyzeBtn.disabled = !String(value || '').trim();
}
function fillIntentExample(value) {
  state.intentText = value;
  state.intentRound = 0;
  state.intentAnswers = [];
  state.intentAnalysis = null;
  state.intentConfirmed = false;
  state.intentQuestion = null;
  render();
  const input = document.getElementById('creativeIntentInput');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
function normalizeIntentResult(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    title: v.title || '本次创作方向',
    theme: v.theme || '生活记录',
    expression_goal: v.expression_goal || '整理一组有整体感的照片',
    subject_hierarchy: v.subject_hierarchy || { primary: [], secondary: [], accent: [] },
    mood: Array.isArray(v.mood) ? v.mood : [],
    visual_language: v.visual_language || { color_tone: [], lighting: [], composition: [], texture: [], style_references: [] },
    narrative: v.narrative || { mode: 'freeform', description: '' },
    creative_priority: v.creative_priority || { mode: 'balanced' },
    processing_preference: v.processing_preference || { retouch_strength: 'light', allow_intentional_blur: true },
    constraints: v.constraints || { must_keep: [], avoid_processing: [] },
    selection_principles: Array.isArray(v.selection_principles) ? v.selection_principles : [],
    summary: v.summary || v.expression_goal || '根据你的描述，优先整理主题相关、整体协调且有表达价值的照片。'
  };
}
function localIntentFallback(text) {
  const t = String(text || '');
  const people = /人物|人像|自己|朋友|合照/.test(t);
  const scenery = /风景|建筑|环境|街景/.test(t);
  const lifestyle = /生活|日常|周末|随手拍|抓拍|有趣|松弛/.test(t);
  const story = /故事|叙事|经历|过程|从.*到/.test(t);
  const mood = ['清冷','安静','松弛','自然','温暖','浪漫','活泼','电影感','复古'].filter(k => t.includes(k));
  const primary = people ? ['人物'] : (scenery ? ['风景'] : []);
  const secondary = people && scenery ? ['风景','建筑'] : (lifestyle ? ['生活细节','人物','环境'] : ['环境','生活细节']);
  const summary = t.trim() || '先从整体质量、主题关联和内容丰富度出发，为你整理一组自然协调的照片。';
  return normalizeIntentResult({
    title: people && mood.includes('清冷') ? '人物氛围感记录' : (lifestyle ? '自然生活记录' : (story ? '有故事的旅行记录' : '本次图文创作')),
    theme: story ? '旅行或经历记录' : (lifestyle ? '日常生活记录' : '生活记录'),
    expression_goal: people ? '突出人物表现与氛围' : (lifestyle ? '呈现真实、有趣的生活状态' : '整理一组协调、有表达重点的照片'),
    subject_hierarchy: { primary, secondary, accent: ['细节瞬间'] },
    mood,
    visual_language: { color_tone: t.includes('清冷') ? ['偏冷','低饱和'] : [], lighting: ['自然光'], composition: ['保持画面变化'], texture: ['自然质感'], style_references: t.includes('电影感') ? ['电影感'] : [] },
    narrative: { mode: story ? 'experience_story' : (lifestyle ? 'freeform' : 'mood_based'), description: summary },
    creative_priority: { mode: story ? 'balanced' : ((people || mood.length) ? 'visual_first' : 'adaptive') },
    processing_preference: { retouch_strength: /不要过度|自然|真实/.test(t) ? 'light' : 'medium', allow_intentional_blur: /模糊|抓拍|随手拍|生活/.test(t) },
    constraints: { must_keep: [], avoid_processing: /不要过度修图|不要过度/.test(t) ? ['过度磨皮','过度调色'] : [] },
    selection_principles: ['优先保留与本次主题相关的照片','兼顾整体协调与内容变化','不为了追求精致而误删有表达价值的真实瞬间'],
    summary
  });
}
async function analyzeIntent(answer) {
  if (state.intentBusy) return;
  if (!state.intentText.trim()) { toast('先简单描述一下你想表达什么'); return; }
  state.intentBusy = true;
  state.intentConfirmed = false;
  state.intentQuestion = null;
  render();
  try {
    if (!state.apiOk || !state.apiInfo || !state.apiInfo.ok) throw new Error('模型服务未配置');
    const assetSummary = {
      total: state.photos.length,
      categories: state.photos.reduce((acc, ph) => { const key = ph.category || '待分析'; acc[key] = (acc[key] || 0) + 1; return acc; }, {}),
      analyzed: state.analyzed
    };
    const response = await fetch(API_BASE + '/api/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userText: state.intentText, answer: answer || '', previousIntent: state.intentAnalysis || null, answers: state.intentAnswers, assetSummary, round: state.intentRound })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '意图理解失败');
    const result = data.result || {};
    state.intentAnalysis = normalizeIntentResult(result.intent || result);
    state.intentMode = 'model';
    if (result.needs_clarification && result.clarifying_question && state.intentRound < 2) {
      state.intentQuestion = result.clarifying_question;
      state.intentQuestionOptions = Array.isArray(result.question_options) ? result.question_options.slice(0, 3) : [];
    } else {
      state.intentQuestion = null;
      state.intentQuestionOptions = [];
    }
  } catch (e) {
    state.intentAnalysis = localIntentFallback(state.intentText + (answer ? '。补充：' + answer : ''));
    state.intentMode = 'local';
    state.intentQuestion = null;
    state.intentQuestionOptions = [];
    toast('模型意图理解暂不可用，已生成本地初步建议，请检查后确认');
  } finally {
    state.intentBusy = false;
    render();
  }
}
function answerIntentOption(index) {
  answerIntent((state.intentQuestionOptions || [])[index]);
}
function answerIntent(answer) {
  const value = String(answer || '').trim();
  if (!value) return;
  state.intentAnswers.push({ question: state.intentQuestion || '', answer: value });
  state.intentRound++;
  analyzeIntent(value);
}
function submitIntentAnswer() {
  const input = document.getElementById('intentAnswerInput');
  if (input && input.value.trim()) answerIntent(input.value.trim());
  else toast('请先输入补充说明，或选择一个选项');
}
function skipIntentQuestion() {
  state.intentQuestion = null;
  state.intentQuestionOptions = [];
  state.intentAnalysis = normalizeIntentResult(state.intentAnalysis);
  state.intentMode = state.intentMode || 'local';
  render();
}
function confirmIntent() {
  if (!state.intentAnalysis) return;
  state.intentConfirmed = true;
  render();
  toast('创作方向已确认，后续推荐会参考这份意图');
}
function editIntent() {
  state.intentConfirmed = false;
  state.intentQuestion = null;
  render();
  const input = document.getElementById('creativeIntentInput');
  if (input) input.focus();
}
function setDefaultIntent() {
  state.intentAnalysis = normalizeIntentResult({
    title: '自然协调的生活记录', theme: '生活记录', expression_goal: '从本批照片中整理一组主题相关、画面自然的图文',
    subject_hierarchy: { primary: [], secondary: ['人物','风景','生活细节'], accent: [] },
    mood: ['自然','真实'], visual_language: { color_tone: [], lighting: ['自然光'], composition: ['保持画面变化'], texture: ['自然质感'], style_references: [] },
    narrative: { mode: 'adaptive', description: '不强制固定故事结构，根据素材内容决定组合方式。' },
    creative_priority: { mode: 'adaptive' }, processing_preference: { retouch_strength: 'light', allow_intentional_blur: true },
    selection_principles: ['优先保留主题相关且有内容价值的照片','兼顾图片质量、内容互补和整体协调','保留有意义的自然抓拍'] ,
    summary: '暂不指定特殊风格，先以自然、真实、协调为基础，由 MemoAI 根据素材内容推荐。'
  });
  state.intentMode = 'default';
  state.intentConfirmed = true;
  state.intentQuestion = null;
  render();
  toast('已采用默认创作方向，可以随时修改');
}

/* ---------- 文案 ---------- */
function chosenTitle() {
  const c = state.copies && state.copies[state.copyIdx];
  if (state.platform === '小红书' && c && c.title) return c.title;
  return state.platform === '小红书' ? '成片 · 图文' : '';
}
function fallbackCopies() { return (FALLBACK_COPIES[state.platform] || []).map(c => Object.assign({}, c)); }

async function generateCopy() {
  const parts = state.groupPhotos.map(p => (p.category || '') + (p.scene ? '·' + p.scene : '') + (p.caption ? '：' + p.caption : '')).filter(Boolean);
  const intentSummary = state.intentAnalysis && state.intentAnalysis.summary ? '；创作意图：' + state.intentAnalysis.summary : '';
  const context = '平台：' + state.platform + '；' + (state.collageMode ? '拼图模式，' : '单图直出，') + '共 ' + slots().length + ' 张成片' + intentSummary + '；素材：' + parts.join('；');
  try {
    const response = await fetch(API_BASE + '/api/copy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: state.platform, count: 3, context })
    });
    const res = await response.json();
    if (!response.ok) throw new Error(res.error || '文案生成失败');
    const copies = (res.copies || []).filter(c => c.body || c.title);
    state.copyMode = copies.length ? 'model' : 'fallback';
    return copies.length ? copies : fallbackCopies();
  } catch (e) { state.copyMode = 'fallback'; return fallbackCopies(); }
}

/* ---------- 加工（进入第 3 步触发） ---------- */
function startProcessing() {
  if (!state.groupPhotos.length) {
    state.step = 2;
    toast('请先选择一组图片，再开始加工');
    render();
    return;
  }
  state.processingDone = false;
  state.processingError = null;
  state.processingMsg = '正在准备加工任务…';
  state.processingProgress = {
    toneDone: 0,
    toneTotal: Math.max(0, state.groupPhotos.length - 1),
    toneStatus: 'running',
    copyStatus: 'running'
  };
  render();
  (async () => {
    const base = state.groupPhotos.find(ph => ph.id === state.baseId) || state.groupPhotos[0];
    if (!base) throw new Error('未找到基准图片');
    const toneTask = (async () => {
      const others = state.groupPhotos.filter(ph => ph.id !== base.id);
      for (const ph of others) {
        try { state.processed[ph.id] = await colorTransfer(ph.work, base.work, 900); }
        catch (e) { state.processed[ph.id] = ph.work; }
        state.processingProgress.toneDone++;
        state.processingMsg = '统一色调：已处理 ' + state.processingProgress.toneDone + ' / ' + state.processingProgress.toneTotal + ' 张';
        render();
      }
      state.processingProgress.toneStatus = 'done';
    })();
    const copyTask = (async () => {
      state.processingMsg = '正在生成平台文案…';
      state.copies = await generateCopy();
      state.processingProgress.copyStatus = 'done';
      render();
    })();
    await Promise.all([toneTask, copyTask]);
    state.processingDone = true;
    state.processingMsg = '';
    render();
    mountCanvases();
  })().catch(err => {
    state.processingError = err.message || '加工过程中出现错误';
    state.processingMsg = state.processingError;
    render();
  });
}

/* ---------- 渲染辅助 ---------- */
function tile(ph, o) {
  o = o || {};
  let src = ph.thumb || ph.work;
  if (o.tone && ph.id !== state.baseId && state.processed[ph.id]) src = state.processed[ph.id];
  const badge = o.base ? '<span class="t-badge base">基准</span>' : (o.badge ? '<span class="t-badge">' + o.badge + '</span>' : '');
  const x = o.remove ? '<button class="t-x" aria-label="选择替换图片" onclick="event.stopPropagation();replacePhoto(' + ph.id + ')" title="选择替换图片">↻</button>' : '';
  const tag = o.tag ? '<span class="t-tag">' + escapeHTML(ph.category || '') + '</span>' : '';
  const cls = ['tile'];
  if (o.selectable) cls.push('selectable');
  if (o.selected) cls.push('selected');
  const onclick = o.onclick ? ' onclick="' + o.onclick + '"' : '';
  return '<div class="' + cls.join(' ') + '" style="background-image:url(' + src + ');background-size:cover;background-position:center;"' + onclick + '>' + badge + x + tag + '</div>';
}

function copyCardHTML(c, i) {
  const sel = state.copyIdx === i;
  if (state.platform === '朋友圈') {
    return '<div class="copy-card ' + (sel ? 'selected' : '') + '" onclick="setCopy(' + i + ')"><div class="c-tone">候选 ' + (i + 1) + ' · 朋友圈语感</div><div class="c-body">' + escapeHTML(c.body || c.title || '') + '</div></div>';
  }
  return '<div class="copy-card ' + (sel ? 'selected' : '') + '" onclick="setCopy(' + i + ')"><div class="c-tone">候选 ' + (i + 1) + ' · 小红书语感</div><div class="c-title">' + escapeHTML(c.title || '') + '</div><div class="c-body">' + escapeHTML(c.body || '') + '</div><div class="c-tags">' + (c.tags || []).map(t => '<span>' + escapeHTML(t) + '</span>').join('') + '</div></div>';
}

/* ---------- 四步内容 ---------- */
function platformHint() {
  return state.platform === '朋友圈'
    ? '最多 9 张 · 方图预览与导出'
    : '最多 18 张（建议 6～12 张）· 竖版图组预览与导出';
}

function renderStep1() {
  const max = state.platform === '朋友圈' ? 9 : 18;
  const n = state.photos.length;
  const mc = materialCount();
  const sum = quotaSum();
  const left = mc - sum;
  const err = quotaError();
  let importArea = '';
  if (state.importing) {
    const pct = state.importTotal ? Math.round(state.importDone / state.importTotal * 100) : 0;
    importArea = '<div class="card import-progress"><div class="progress-copy"><strong>正在整理照片</strong><span>' + state.importDone + ' / ' + state.importTotal + '</span></div><div class="progressbar"><i style="width:' + pct + '%"></i></div><p class="card-desc">正在读取图片并生成预览，不会修改原始文件。</p></div>';
  } else if (state.analyzing) {
    const pct = state.analyzeTotal ? Math.round(state.analyzeDone / state.analyzeTotal * 100) : 0;
    importArea = '<div class="card import-progress"><div class="progress-copy"><strong>MemoAI 正在理解照片</strong><span>' + state.analyzeDone + ' / ' + state.analyzeTotal + ' 张</span></div><div class="progressbar"><i style="width:' + pct + '%"></i></div><p class="card-desc">识别内容、场景和单图质量。你可以先填写创作想法，分析会在后台继续。</p></div>';
  } else if (!n) {
    importArea = '<div class="card dropzone" id="dropzone" onclick="triggerImport()"><div class="dz-icon">' + icon('image', 36) + '</div><div class="dz-title">把照片放进这里</div><div class="dz-sub">点击选择或拖拽多张图片 · 单个项目最多 100 张</div><button class="btn btn-primary" type="button" onclick="event.stopPropagation();triggerImport()">选择照片</button></div>';
  } else {
    importArea = '<div class="card"><div class="import-head"><div><div class="card-title">你的素材</div><div class="import-meta">已导入 ' + n + ' 张 · 原图不会被修改</div></div><button class="btn btn-sm btn-secondary" onclick="triggerImport()">＋ 继续添加</button></div><div class="grid-photos">' + state.photos.slice(0, 36).map(ph => tile(ph, { tag: true })).join('') + '</div>' + (n > 36 ? '<div class="import-meta">已显示前 36 张，全部 ' + n + ' 张均参与分析。</div>' : '') + (state.analysisMode === 'local' ? '<div class="notice notice-warn">当前未连接可用模型，照片分类使用本地特征估算，结果可能不准确。</div>' : state.analysisMode === 'mixed' ? '<div class="notice notice-warn">部分照片未能完成模型分析，已使用本地特征补全。</div>' : state.analyzed ? '<div class="notice notice-ok">照片分析已完成，可以开始创作。</div>' : '') + '</div>';
  }

  const quotaIcons = { 美食: 'coffee', 人像: 'user', 风景: 'mountain', 其他: 'help' };
  const quotaCards = ['美食', '人像', '风景', '其他'].map(c => {
    const pool = state.analyzed ? poolCount(c) : null;
    const dis = state.analyzed ? '' : 'disabled';
    return '<div class="quota-card"><div class="q-icon">' + icon(quotaIcons[c], 20) + '</div><div class="q-title">' + c + '</div><div class="q-pool">' + (pool == null ? '待分析' : '可用 ' + pool + ' 张') + '</div><div class="q-ctl"><button ' + dis + ' onclick="quotaDelta(\'' + c + '\',-1)" aria-label="减少' + c + '配额">−</button><span class="q-val">' + state.quotas[c] + '</span><button ' + dis + ' onclick="quotaDelta(\'' + c + '\',1)" aria-label="增加' + c + '配额">＋</button></div></div>';
  }).join('');

  let intentPanel = '';
  if (state.intentQuestion) {
    intentPanel = '<div class="intent-question"><div class="intent-eyebrow">再确认一个细节 · 第 ' + (state.intentRound + 1) + ' 轮</div><h3>' + escapeHTML(state.intentQuestion) + '</h3><div class="intent-options">' + state.intentQuestionOptions.map((opt, i) => '<button class="intent-option" onclick="answerIntentOption(' + i + ')">' + escapeHTML(opt) + '</button>').join('') + '</div><div class="intent-custom"><input id="intentAnswerInput" type="text" placeholder="也可以用自己的话补充" /><button class="btn btn-primary" onclick="submitIntentAnswer()">发送</button></div><button class="text-button" onclick="skipIntentQuestion()">先按你的理解继续</button></div>';
  } else if (state.intentAnalysis) {
    const a = state.intentAnalysis;
    const hierarchy = a.subject_hierarchy || {};
    const tags = [].concat(a.mood || [], (a.visual_language && a.visual_language.style_references) || [], (a.visual_language && a.visual_language.color_tone) || []).filter(Boolean).slice(0, 8);
    intentPanel = '<div class="intent-card ' + (state.intentConfirmed ? 'is-confirmed' : '') + '"><div class="intent-card-head"><div><div class="intent-eyebrow">' + (state.intentMode === 'default' ? '默认创作方向' : (state.intentConfirmed ? '已确认的创作意图' : 'MemoAI 对你的想法的理解')) + '</div><h3>' + escapeHTML(a.title || a.expression_goal || '本次创作方向') + '</h3></div><span class="intent-status">' + (state.intentConfirmed ? (state.intentMode === 'default' ? '已采用默认' : '✓ 已确认') : (state.intentMode === 'local' ? '本地初步整理' : '待你确认')) + '</span></div><p class="intent-summary">' + escapeHTML(a.summary || '') + '</p><div class="intent-role-row"><span><b>主体</b> ' + escapeHTML((hierarchy.primary || []).join('、') || '待定') + '</span><span><b>辅助</b> ' + escapeHTML((hierarchy.secondary || []).join('、') || '无') + '</span></div><div class="intent-tags">' + tags.map(t => '<span>' + escapeHTML(t) + '</span>').join('') + '</div>' + ((a.selection_principles || []).length ? '<ul class="intent-principles">' + a.selection_principles.slice(0, 3).map(t => '<li>' + escapeHTML(t) + '</li>').join('') + '</ul>' : '') + '<div class="intent-actions">' + (state.intentConfirmed ? '<button class="btn btn-secondary" onclick="editIntent()">修改创作方向</button>' : '<button class="btn btn-primary" onclick="confirmIntent()">确认这个方向</button><button class="btn btn-secondary" onclick="editIntent()">继续修改</button>') + '</div></div>';
  }

  const intentInput = '<div class="card intent-panel"><div class="intent-eyebrow">CREATIVE INTENT</div><h2>这次，你想表达什么？</h2><p class="card-desc">用自己的话告诉 MemoAI 你想记录怎样的故事、希望呈现什么感觉。不需要摄影或设计术语。</p><textarea id="creativeIntentInput" class="intent-textarea" rows="3" maxlength="1200" ' + (state.intentBusy ? 'disabled' : '') + ' placeholder="例如：我想以人物为主，风景作为辅助，整体清冷、安静，有一点电影感，但不要过度修图。" oninput="updateIntentText(this.value)">' + escapeHTML(state.intentText) + '</textarea><div class="intent-examples"><button onclick="fillIntentExample(\'想突出人物的氛围感，风景作为衬托，整体清冷、自然一点。\')">人物氛围感</button><button onclick="fillIntentExample(\'想记录松弛有趣的周末生活，保留自然抓拍和一些细碎瞬间。\')">生活化记录</button><button onclick="fillIntentExample(\'想把旅行经历串起来，有开头、过程和收尾，照片看起来像一个故事。\')">旅行叙事</button></div><div class="intent-submit-row"><button class="btn btn-primary" id="intentAnalyzeBtn" onclick="analyzeIntent()" ' + (state.intentBusy || !state.intentText.trim() ? 'disabled' : '') + '>' + (state.intentBusy ? '正在理解…' : '帮我理解创作意图') + '</button><button class="text-button" onclick="setDefaultIntent()">我还没想好，先按默认审美整理</button></div>' + (state.intentBusy ? '<div class="notice">正在结合你的描述和素材情况理解创作方向…</div>' : '') + intentPanel + '</div>';

  const collageHint = state.collageMode
    ? '每张成片拼入 ' + state.perCollage + ' 张照片，共使用 ' + mc + ' 张素材，导出 ' + state.totalCount + ' 张拼图。'
    : '每张入选照片单独导出，适合希望保留原图完整构图的场景。';
  const quotaNote = err ? '<div class="quota-error">' + err + '</div>' : '<div class="quota-fill">已分配 ' + sum + ' 张，剩余 ' + Math.max(0, left) + ' 张将由 AI 根据可用素材补充。</div>';

  return sectionHead('①', '整理素材与创作意图', '先导入照片，再告诉 MemoAI 你希望这组图呈现什么感觉') +
    importArea + intentInput +
    '<div class="card"><div class="card-title">发布设置</div><div class="two-col"><div><div class="field-label">发布平台</div><div class="segmented"><button class="' + (state.platform === '朋友圈' ? 'active' : '') + '" onclick="setPlatform(\'朋友圈\')">朋友圈</button><button class="' + (state.platform === '小红书' ? 'active' : '') + '" onclick="setPlatform(\'小红书\')">小红书</button></div><div class="platform-hint">' + platformHint() + '</div></div><div><div class="field-label">希望发布几张</div><div class="stepper-ctl"><button onclick="totalDelta(-1)" aria-label="减少数量">−</button><div class="val">' + state.totalCount + '</div><button onclick="totalDelta(1)" aria-label="增加数量">＋</button></div><div class="platform-hint">最多 ' + max + ' 张</div></div></div><div class="field-label" style="margin-top:18px;">成片方式</div><div class="segmented"><button class="' + (!state.collageMode ? 'active' : '') + '" onclick="setCollageMode(false)">单图直出</button><button class="' + (state.collageMode ? 'active' : '') + '" onclick="setCollageMode(true)">拼图成片</button></div>' + (state.collageMode ? '<div class="inline-control"><span>每张拼入几张照片</span><div class="stepper-ctl"><button onclick="setPerCollage(-1)">−</button><div class="val">' + state.perCollage + '</div><button onclick="setPerCollage(1)">＋</button></div></div>' : '') + '<div class="platform-hint">' + collageHint + '</div></div>' +
    '<details class="card advanced-settings" ' + (state.advancedOpen ? 'open' : '') + ' ontoggle="state.advancedOpen=this.open"><summary>高级设置 · 图片分类配额（可选）</summary><p class="card-desc">不设置也可以，默认由 MemoAI 按素材情况推荐。这里仅用于指定各类素材数量。</p><div class="quota-grid">' + quotaCards + '</div>' + quotaNote + '<div style="margin-top:10px;"><button class="linklike" ' + (state.analyzed ? '' : 'disabled') + ' onclick="resetQuota()">恢复 AI 建议</button></div></details>';
}

function renderStep2() {
  const groups = state.groups || [];
  const cards = groups.map((grp, i) => {
    const selected = state.selectedGroup === i;
    return '<div class="group-card ' + (selected ? 'selected' : '') + '" role="button" tabindex="0" onclick="selectGroup(' + i + ')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();selectGroup(' + i + ')}"><div class="g-head"><div><div class="g-title">' + escapeHTML(grp.title) + '</div><div class="g-subtitle">' + escapeHTML(grp.subtitle || '') + '</div><div class="g-reason">' + escapeHTML(grp.reason) + '</div></div><div class="radio" aria-hidden="true"></div></div><div class="filmstrip">' + grp.photos.map(ph => tile(ph, {})).join('') + '</div><div class="g-meta"><span>' + grp.photos.length + ' 张图片</span><span>' + (grp.scenes || 0) + ' 类场景</span><span>单图均分 ' + grp.avgQ + '</span></div></div>';
  }).join('');

  let detail = '';
  if (state.selectedGroup != null) {
    let replacementPanel = '';
    if (state.replacingId != null) {
      const old = state.groupPhotos.find(ph => ph.id === state.replacingId);
      const candidates = state.photos.filter(ph => ph.id !== state.replacingId && !state.groupPhotos.some(item => item.id === ph.id) && old && ph.category === old.category).sort((a, b) => (b.quality || 0) - (a.quality || 0));
      replacementPanel = '<div class="replacement-panel"><div class="replacement-head"><strong>选择一张替换图片</strong><button class="text-button" onclick="cancelReplace()">取消</button></div><p class="card-desc">优先展示同类别、尚未加入当前组合的素材。</p>' + (candidates.length ? '<div class="replacement-grid">' + candidates.slice(0, 18).map(ph => '<button class="replacement-item" onclick="chooseReplacement(' + state.replacingId + ',' + ph.id + ')">' + tile(ph, { tag: true }) + '<span>' + escapeHTML(ph.scene || ph.category || '候选图片') + '</span></button>').join('') + '</div>' : '<div class="notice notice-warn">没有更多同类别候选图片。可以保留原图，或调整分类配额后重新生成组合。</div>') + '</div>';
    }
    detail = '<div class="card"><h3 class="card-title">组合微调</h3><p class="card-desc">点选图片可设为色调参考图；点击图片右上角的 ↻，可以从候选素材中选择替换图。</p><div class="grid-photos">' + state.groupPhotos.map(ph => tile(ph, { base: ph.id === state.baseId, remove: true, onclick: 'setBase(' + ph.id + ')' })).join('') + '</div>' + replacementPanel + '</div>';
  }
  const intentSummary = state.intentAnalysis && state.intentAnalysis.summary ? '<div class="intent-context"><strong>本次创作方向</strong><span>' + escapeHTML(state.intentAnalysis.summary) + '</span><button class="text-button" onclick="goStep(1)">修改</button></div>' : '';
  const headNote = state.collageMode ? '拼图模式：共使用 ' + materialCount() + ' 张素材，分成 ' + state.totalCount + ' 张成片。' : '单图直出：每张入选照片单独导出。';
  return sectionHead('②', '选择图片组合', '比较三种推荐方向，选择最接近你想表达的那一组') + intentSummary + '<div class="card"><div class="card-title">为你生成了 ' + groups.length + ' 组候选</div><p class="card-desc">' + escapeHTML(headNote) + ' 候选会结合已确认的创作意图（主体层级、叙事方式、视觉偏好）与单图质量、场景覆盖、色相一致生成；仍为规则驱动，尚未实现完整的图片两两兼容评分与叙事优化。</p><div class="notice">选择一组后，还可以更换单张图片或指定色调参考图。</div></div>' + cards + detail;
}

function renderStep3() {
  if (!state.processingDone) {
    const p = state.processingProgress || {};
    const tonePct = p.toneTotal ? Math.round((p.toneDone || 0) / p.toneTotal * 100) : (p.toneStatus === 'done' ? 100 : 0);
    const copyPct = p.copyStatus === 'done' ? 100 : 0;
    return sectionHead('③', '视觉加工', '校色与文案生成完成后，可以在这里检查和调整') +
      '<div class="card processing-summary"><div class="card-title">正在为你的作品做最后整理</div><p class="card-desc">图片校色与文案生成会并行执行；拼图预览在完成后生成。</p>' + (state.processingMsg ? '<div class="notice">' + escapeHTML(state.processingMsg) + '</div>' : '') + (state.processingError ? '<div class="notice notice-warn">' + escapeHTML(state.processingError) + '</div><button class="btn btn-secondary" onclick="retryProcessing()">重试加工</button>' : '') + '</div>' +
      '<div class="lane"><div class="lane-head"><span class="dot ' + (p.toneStatus === 'done' ? 'done' : '') + '"></span><span class="lane-title">统一视觉色调</span><span class="lane-status">' + (p.toneStatus === 'done' ? '已完成' : (p.toneDone || 0) + ' / ' + (p.toneTotal || 0)) + '</span></div><div class="progressbar"><i style="width:' + tonePct + '%"></i></div></div>' +
      '<div class="lane"><div class="lane-head"><span class="dot ' + (p.copyStatus === 'done' ? 'done' : '') + '"></span><span class="lane-title">生成发布文案</span><span class="lane-status">' + (p.copyStatus === 'done' ? (state.copyMode === 'model' ? '模型已完成' : '使用备用文案') : '生成中') + '</span></div><div class="progressbar"><i style="width:' + copyPct + '%"></i></div></div>';
  }
  const lanes = [];
  lanes.push('<div class="lane"><div class="lane-head"><span class="dot done"></span><span class="lane-title">' + icon('palette', 16) + '统一视觉色调</span><span class="lane-status">已完成</span></div><div class="tone-toggle"><button class="' + (state.toneOn ? 'active' : '') + '" onclick="setTone(true)">校色后</button><button class="' + (!state.toneOn ? 'active' : '') + '" onclick="setTone(false)">原图</button></div><div class="filmstrip" style="margin-top:10px;">' + state.groupPhotos.map(ph => tile(ph, { base: ph.id === state.baseId, tone: state.toneOn })).join('') + '</div><p class="card-desc">当前校色采用 RGB 统计对齐的简化处理，建议逐张检查肤色和高饱和区域。</p></div>');
  if (state.collageMode) {
    const variants = [collageLayout(0, state.perCollage), collageLayout(1, state.perCollage)];
    const cards = variants.map((layout, i) => '<div class="layout-card ' + (state.collageLayoutIdx === i ? 'selected' : '') + '" onclick="setCollageLayout(' + i + ')"><div class="l-name">' + escapeHTML(layout.name) + '</div><div class="l-desc">每张拼 ' + state.perCollage + ' 张</div><div class="layout-thumb' + (state.platform === '小红书' ? ' ratio-34' : '') + '" id="ct-' + i + '"></div></div>').join('');
    lanes.push('<div class="lane"><div class="lane-head"><span class="dot done"></span><span class="lane-title">' + icon('grid', 16) + '拼图排版</span><span class="lane-status">' + slots().length + ' 张成片</span></div><div class="layout-grid">' + cards + '</div></div>');
  } else {
    lanes.push('<div class="section-hint">单图直出模式：每张选中照片会单独导出，不进行拼图。</div>');
  }
  const copyCards = (state.copies.length ? state.copies : fallbackCopies()).map((copy, i) => copyCardHTML(copy, i)).join('');
  lanes.push('<div class="lane"><div class="lane-head"><span class="dot done"></span><span class="lane-title">' + icon('pen', 16) + '发布文案</span><span class="lane-status">' + (state.copyMode === 'model' ? '模型生成' : '备用文案') + '</span></div>' + (state.copyMode === 'fallback' ? '<div class="notice notice-warn">当前未能获取模型文案，以下为备用示例，请按实际内容修改。</div>' : '') + copyCards + '</div>');
  return sectionHead('③', '视觉加工', '检查色调、排版和文案；不满意的部分可以随时调整') + lanes.join('');
}

function renderStep4() {
  const copy = (state.copies.length ? state.copies[state.copyIdx] : fallbackCopies()[state.copyIdx]) || {};
  const isSq = state.platform === '朋友圈';
  const ratioCls = isSq ? 'ratio-11' : 'ratio-34';
  const slotList = slots();

  let preview;
  if (state.collageMode) {
    preview = '<div class="final-preview ' + ratioCls + '" id="finalPreview"></div>';
  } else {
    preview = '<div class="final-preview-single">' + state.groupPhotos.map(p =>
      '<div class="tile" style="background-image:url(' + photoSrc(p) + ');background-size:cover;background-position:center;aspect-ratio:' + (isSq ? '1/1' : '3/4') + ';"></div>'
    ).join('') + '</div>';
  }

  const copyBlock = state.platform === '朋友圈'
    ? '<div class="copy-card selected"><div class="c-tone">朋友圈 · 熟人语气</div><div class="c-body">' + escapeHTML(copy.body || copy.title || '') + '</div></div>'
    : '<div class="copy-card selected"><div class="c-tone">小红书 · 笔记文案</div><div class="c-title">' + escapeHTML(copy.title || '') + '</div><div class="c-body">' + escapeHTML(copy.body || '') + '</div><div class="c-tags">' + (copy.tags || []).map(t => '<span>' + escapeHTML(t) + '</span>').join('') + '</div></div>';

  const fineTune = '<button class="btn btn-sm btn-secondary" onclick="goStep(2)">↻ 换单图</button>' +
    (state.collageMode ? '<button class="btn btn-sm btn-secondary" onclick="cycleCollageLayout()">🔄 换排版</button>' : '') +
    '<button class="btn btn-sm btn-secondary" onclick="cycleCopy()">✍️ 换文案</button>' +
    '<button class="btn btn-sm btn-secondary" onclick="toggleTone()">' + (state.toneOn ? '🎨 退回校色' : '🎨 应用校色') + '</button>';

  const exportNote = state.collageMode
    ? '将导出 ' + slotList.length + ' 张拼图成片（每张 ' + state.perCollage + ' 张照片）。'
    : '将导出 ' + slotList.length + ' 张单图（统一色调后）。';

  return sectionHead('④', '确认点② · 终稿导出', '校对成片与文案，一键导出适配平台尺寸的成片') +
    '<div class="card"><div class="card-title">终稿确认</div><p class="card-desc">' + exportNote + '</p></div>' +
    '<div class="final-wrap">' +
    '  ' + preview +
    '  <div class="final-side">' +
    '    ' + copyBlock +
    '    <div class="card" style="margin-bottom:0;"><div style="font-weight:700;font-size:14px;margin-bottom:10px;">微调</div><div class="fine-tune">' + fineTune + '</div></div>' +
    '    <div class="card" style="margin-bottom:0;"><div style="font-weight:700;font-size:14px;margin-bottom:10px;">导出</div>' +
    '      <button class="btn btn-primary" style="width:100%;" onclick="exportFinal()" ' + (state.exporting ? 'disabled' : '') + '>' + (state.exporting ? '导出中…' : '导出成片（适配平台尺寸）') + '</button>' +
    '      <button class="btn btn-secondary btn-sm" style="width:100%;margin-top:8px;" onclick="restart()">↺ 重新开始</button>' +
    '      <div class="section-hint" style="margin-top:10px;margin-bottom:0;">一键发布受平台开放 API 限制，MVP 终点为「导出成片」；双平台「一鱼两吃」将在 v0.3 支持。</div>' +
    '    </div>' +
    '  </div>' +
    '</div>';
}

/* ---------- 顶栏 / 导航 ---------- */
function topbar() {
  return '<div class="topbar"><div class="brand"><div class="logo">M</div><div><div class="name">MemoAI</div><div class="sub">把零散照片，整理成想表达的故事</div></div></div><span class="badge-proto">体验版 · v0.3</span></div>';
}

function canNext() {
  if (state.step === 1) return state.photos.length > 0 && !state.importing && !state.analyzing && state.intentConfirmed && !quotaError();
  if (state.step === 2) return state.selectedGroup != null && state.groupPhotos.length > 0;
  if (state.step === 3) return state.processingDone && !state.processingError;
  return false;
}
function canAccessStep(n) {
  if (n <= state.step) return true;
  if (n === 2) return state.photos.length > 0 && !state.importing && !state.analyzing && state.intentConfirmed && !quotaError();
  if (n === 3) return state.selectedGroup != null && state.groupPhotos.length > 0;
  if (n === 4) return state.processingDone && !state.processingError;
  return false;
}
function nextLabel() {
  return { 1: '生成候选组合 →', 2: '确认组合，开始加工 →', 3: '查看终稿 →' }[state.step] || '';
}
function bottomnav() {
  const items = [
    { n: 1, icon: 'folder', label: '素材与意图' },
    { n: 2, icon: 'grid', label: '选图组合' },
    { n: 3, icon: 'chip', label: '视觉加工' },
    { n: 4, icon: 'export', label: '终稿导出' }
  ];
  return '<div class="bottomnav">' + items.map(item => {
    const active = state.step === item.n ? ' active' : '';
    const disabled = canAccessStep(item.n) ? '' : ' disabled';
    return '<button class="bn-item' + active + disabled + '" ' + (disabled ? 'disabled aria-disabled="true"' : '') + ' onclick="goStep(' + item.n + ')"><span class="bn-icon">' + icon(item.icon, 18) + '</span><span class="bn-label">' + item.label + '</span></button>';
  }).join('') + '</div>';
}
function stepCta() {
  if (state.step >= 4) return '';
  const prev = state.step > 1 ? '<button class="btn btn-secondary" onclick="prev()">← 上一步</button>' : '<span></span>';
  const nextBtn = '<button class="btn btn-primary" ' + (canNext() ? '' : 'disabled') + ' onclick="next()">' + nextLabel() + '</button>';
  return '<div class="step-cta">' + prev + nextBtn + '</div>';
}

/* ---------- 交互 ---------- */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const content = state.step === 1 ? renderStep1() : state.step === 2 ? renderStep2() : state.step === 3 ? renderStep3() : renderStep4();
  app.innerHTML = topbar() + content + stepCta() + bottomnav();
}

async function mountCanvases() {
  if (state.step === 3 && state.processingDone && state.collageMode) {
    const k = state.perCollage;
    const firstSlot = slots()[0] || [];
    for (let i = 0; i < 2; i++) {
      const el = document.getElementById('ct-' + i);
      if (!el || el.dataset.done) continue;
      el.dataset.done = '1';
      try {
        const c = await renderLayoutCanvas(collageLayout(i, k), firstSlot, 260, chosenTitle());
        el.innerHTML = ''; el.appendChild(c);
        c.style.width = '100%'; c.style.height = 'auto'; c.style.display = 'block';
      } catch (e) { /* ignore */ }
    }
  }
  if (state.step === 4 && state.collageMode) {
    const el = document.getElementById('finalPreview');
    if (el && !el.dataset.done) {
      el.dataset.done = '1';
      try {
        const k = state.perCollage;
        const firstSlot = slots()[0] || [];
        const w = Math.min(el.clientWidth || 380, 480);
        const c = await renderLayoutCanvas(collageLayout(state.collageLayoutIdx, k), firstSlot, w, chosenTitle());
        el.innerHTML = ''; el.appendChild(c);
        c.style.width = '100%'; c.style.height = 'auto'; c.style.display = 'block';
      } catch (e) { /* ignore */ }
    }
  }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function goStep(n) {
  if (n < 1 || n > 4) return;
  if (n > state.step && !canAccessStep(n)) {
    if (n === 2 && !state.intentConfirmed) toast('先确认本次创作意图，或选择按默认方式整理');
    else if (n === 2 && state.analyzing) toast('照片仍在分析中，请稍候');
    else if (n === 3) toast('请先选择一组候选图片');
    else if (n === 4) toast('请等待加工完成后再查看终稿');
    else toast('请先完成当前步骤');
    return;
  }
  state.step = n;
  if (n === 2) ensureGroups();
  if (n === 3 && !state.processingDone && !state.procStarted) { state.procStarted = true; startProcessing(); }
  render();
  mountCanvases();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function next() {
  if (state.step === 1) {
    if (!state.photos.length) { toast('请先导入照片'); return; }
    if (state.analyzing || state.importing) { toast('素材仍在处理中，请稍候'); return; }
    if (!state.intentConfirmed) { toast('请先确认创作意图，或选择默认整理方式'); return; }
    if (quotaError()) { toast(quotaError()); return; }
  }
  if (state.step === 2 && (state.selectedGroup == null || !state.groupPhotos.length)) { toast('请先选择一组图片'); return; }
  if (state.step === 3 && !state.processingDone) return;
  goStep(state.step + 1);
}

function prev() { goStep(state.step - 1); }

function setPlatform(p) {
  state.platform = p;
  const max = p === '朋友圈' ? 9 : 18;
  if (state.totalCount > max) state.totalCount = max;
  if (state.analyzed) state.quotas = suggestedQuotas();
  state.groupsSig = null;
  render();
}
function totalDelta(d) {
  const max = state.platform === '朋友圈' ? 9 : 18;
  state.totalCount = Math.max(1, Math.min(max, state.totalCount + d));
  state.quotas = state.analyzed ? suggestedQuotas() : equalQuotas(materialCount());
  state.groupsSig = null;
  render();
}
function setCollageMode(m) {
  state.collageMode = m;
  state.quotas = state.analyzed ? suggestedQuotas() : equalQuotas(materialCount());
  render();
}
function setPerCollage(d) {
  state.perCollage = Math.max(2, Math.min(6, state.perCollage + d));
  state.quotas = state.analyzed ? suggestedQuotas() : equalQuotas(materialCount());
  state.groupsSig = null;
  render();
}
function quotaDelta(c, d) {
  state.quotas[c] = Math.max(0, Math.min(Math.max(poolCount(c), 0) || 99, (state.quotas[c] || 0) + d));
  render();
}
function resetQuota() { if (state.analyzed) { state.quotas = suggestedQuotas(); render(); } }

function selectGroup(i) {
  state.selectedGroup = i;
  const g = state.groups[i];
  state.groupPhotos = g.photos.slice();
  state.baseId = g.baseId;
  state.processed = {};
  state.processingDone = false;
  state.procStarted = false;
  state.processingError = null;
  state.copies = [];
  state.replacingId = null;
  render();
}
function setBase(id) {
  state.baseId = id;
  state.processed = {};
  state.processingDone = false;
  state.procStarted = false;
  state.processingError = null;
  state.copies = [];
  render();
}
function replacePhoto(id) {
  state.replacingId = id;
  render();
}
function cancelReplace() {
  state.replacingId = null;
  render();
}
function chooseReplacement(oldId, newId) {
  const idx = state.groupPhotos.findIndex(ph => ph.id === oldId);
  const replacement = state.photos.find(ph => ph.id === newId);
  if (idx < 0 || !replacement) return;
  const old = state.groupPhotos[idx];
  state.groupPhotos[idx] = replacement;
  if (state.baseId === old.id) state.baseId = replacement.id;
  state.replacingId = null;
  state.processed = {};
  state.processingDone = false;
  state.procStarted = false;
  render();
  toast('已替换图片；开始加工前可以继续调整');
}

function setTone(v) { state.toneOn = v; render(); mountCanvases(); }
function setCopy(i) { state.copyIdx = i; render(); mountCanvases(); }
function setCollageLayout(i) { state.collageLayoutIdx = i; render(); mountCanvases(); }
function cycleCopy() { const n = state.copies.length || 3; state.copyIdx = (state.copyIdx + 1) % n; render(); mountCanvases(); }
function cycleCollageLayout() { state.collageLayoutIdx = (state.collageLayoutIdx + 1) % 2; render(); mountCanvases(); }
function toggleTone() { state.toneOn = !state.toneOn; render(); mountCanvases(); }

function downloadCanvas(canvas, filename) {
  canvas.toBlob(blob => {
    if (!blob) { toast('图片生成失败，请重试'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
  }, 'image/jpeg', 0.92);
}

async function exportFinal() {
  if (state.exporting) return;
  if (!state.groupPhotos.length) { toast('没有可导出的图片'); return; }
  state.exporting = true; render();
  const isSq = state.platform === '朋友圈';
  const W = 1080, H = isSq ? 1080 : 1440;
  const list = slots();
  try {
    for (let i = 0; i < list.length; i++) {
      const slot = list[i];
      let canvas;
      if (slot.length === 1) {
        canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        const img = await loadImage(photoSrc(slot[0]));
        drawCover(ctx, img, 0, 0, W, H);
      } else {
        canvas = await renderLayoutCanvas(collageLayout(state.collageLayoutIdx, slot.length), slot, W, chosenTitle());
      }
      downloadCanvas(canvas, '成片-' + (i + 1) + '.jpg');
      await sleep(320);
    }
    toast('已导出 ' + list.length + ' 张成片' + (state.collageMode ? '（拼图模式，每张 ' + state.perCollage + ' 张照片）' : '（单图直出）'));
  } catch (e) {
    toast('导出失败：' + e.message);
  }
  state.exporting = false; render();
}

function retryProcessing() {
  state.processingError = null;
  state.processed = {};
  state.copies = [];
  state.procStarted = true;
  startProcessing();
}

function restart() {
  state.photos = [];
  state.importing = false; state.importDone = 0; state.importTotal = 0; state.importFailed = 0;
  state.analyzed = false; state.analyzing = false; state.analysisMode = 'pending';
  state.analyzeDone = 0; state.analyzeTotal = 0;
  state.groups = []; state.groupsSig = null;
  state.selectedGroup = null; state.groupPhotos = []; state.baseId = null;
  state.processed = {};
  state.processingDone = false; state.procStarted = false; state.processingMsg = '';
  state.copies = []; state.copyIdx = 0; state.toneOn = true; state.exporting = false;
  state.intentText = ''; state.intentBusy = false; state.intentRound = 0; state.intentQuestion = null; state.intentQuestionOptions = []; state.intentAnalysis = null; state.intentConfirmed = false; state.intentMode = 'none'; state.intentAnswers = [];
  state.replacingId = null; state.processingError = null; state.copyMode = 'model'; state.processingProgress = { toneDone: 0, toneTotal: 0, toneStatus: 'pending', copyStatus: 'pending' };
  state.advancedOpen = false;
  state.platform = '朋友圈'; state.totalCount = 9;
  state.collageMode = false; state.perCollage = 2; state.collageLayoutIdx = 0;
  state.quotas = equalQuotas(9);
  state.step = 1;
  render();
}

/* ---------- 初始化 ---------- */
async function checkBackend() {
  try {
    const r = await fetch(API_BASE + '/api/status', { cache: 'no-store' }).then(x => x.json());
    state.apiOk = true; state.apiInfo = r;
  } catch (e) {
    state.apiOk = false; state.apiInfo = null;
  }
  render();
}

async function init() {
  state.quotas = equalQuotas(9);
  render();
  const app = document.getElementById('app');
  app.addEventListener('dragover', event => { if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) { event.preventDefault(); const zone = event.target.closest('#dropzone'); if (zone) zone.classList.add('dragover'); } });
  app.addEventListener('dragleave', event => { const zone = event.target.closest('#dropzone'); if (zone) zone.classList.remove('dragover'); });
  app.addEventListener('drop', event => { const zone = event.target.closest('#dropzone'); if (!zone) return; event.preventDefault(); zone.classList.remove('dragover'); handleFiles(event.dataTransfer.files); });
  await checkBackend();
}
init();
