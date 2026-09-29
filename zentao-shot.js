// ============================================================
// 禅道文档截图工具
// 用法: node zentao-shot.js [项目名] [文档名]
// ============================================================
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { PNG } = require('pngjs');

// ============================================================
// 配置
// ============================================================
const SCRIPT_DIR = __dirname;
// 每个人自己的登录会话和配置放在自己的用户目录（不在工具文件夹里，工具文件夹可以放心拷给别人）
const USER_DIR = process.env.ZENTAO_HOME || path.join(os.homedir(), '.zentao-screenshots');
const LEGACY_STATE = path.join(SCRIPT_DIR, '.zentao-session.json');   // 旧版会话位置，首次运行时自动搬走
// 配置可选：先找用户目录的 config.json，再找工具目录的（兼容旧用法）；都没有就用默认值
const configPath = [path.join(USER_DIR, 'config.json'), path.join(SCRIPT_DIR, 'config.json')].find(p => fs.existsSync(p));
const userConfig = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
const CONFIG = {
  baseUrl: userConfig.baseUrl || 'http://192.168.10.227:90/zentao',
  username: userConfig.username || '',   // 可不填：不填时弹出浏览器窗口由本人登录，脚本不保存密码
  password: userConfig.password || '',
  stateFile: path.join(USER_DIR, 'session.json'),
  outputBase: userConfig.outputPath || SCRIPT_DIR,
  viewport: userConfig.viewport || { width: 1920, height: 3600 },
};
const LOGIN_WAIT_MS = (parseInt(process.env.ZENTAO_LOGIN_TIMEOUT, 10) || 300) * 1000;  // 等人登录，默认 5 分钟
const CHROME_PATH = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');

// ============================================================
// 等待 / 超时
// ============================================================
const W = {
  PAGE: 800, TAB: 600, NETIDLE: 15000, DOC_BUFFER: 2000,
  STABLE_POLL: 1000, STABLE_MAX: 30, STABLE_NEED: 3,
  SCROLL_INITIAL: 1000, SCROLL_STEP: 800, SCROLL_FINAL: 1000,
  OVERFLOW_SETTLE: 800, OVERFLOW_OLD: 1000, POST_EXPAND: 1500,
  VP_RESIZE: 500, VP_SETTLE: 800,
  TIMEOUT: 10000, EDITOR_TO: 15000, EDITOR_LOAD: 30000,
};
const PAD_X = 10, PAD_BOTTOM = 10, PAD_H = 40; // PAD_H: 左右白边
const MAX_VP_H = 16000; // 放大 viewport 的上限（Chromium 单次截图高度约 16384px）

// ============================================================
// 选择器
// ============================================================
const EXPAND_OLD = '.doc-editor, .doc-view, .detail-body, .detail-main, .detail-sections, #mainContent';
const CONTENT_EL_AFFINE = '.editor.doc-editor-control'; // Affine 纯正文（无工具栏）
const CONTENT_EL_OLD = '.doc-editor';                   // 旧版编辑器

// ============================================================
// 工具
// ============================================================
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, ans => { rl.close(); r(ans.trim()); }));
}
function getFrame(page) { return page.frame({ name: 'app-doc' }) || page; }

// 翻页：点击"下一页"，返回是否成功
async function clickNextPage(page) {
  const f = getFrame(page);
  // 禅道新版用 nav.pager > button.pager-link > i.icon-angle-right
  // 旧版兼容文字链接
  const selectors = [
    'nav.pager button.pager-link:not(.disabled):has(.icon-angle-right)',
    '.pager button.pager-link:not(.disabled):has(.icon-angle-right)',
    'button.pager-link:not(.disabled):has(.icon-angle-right)',
    'nav.pager button:not(.disabled):has(.icon-angle-right)',
    'a:has-text("下一页")',
    '.pager .next:not(.disabled)',
  ];
  for (const sel of selectors) {
    try {
      const btn = f.locator(sel).first();
      if (await btn.count() > 0 && await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        return true;
      }
    } catch {}
  }
  return false;
}

// 像素裁剪：从底部向上扫整行，找内容结束行
// （截图对象是编辑器 / .doc-view 元素本身，不含左侧大纲面板，必须扫全宽，否则靠左的短行会被当成空白裁掉）
function trimBottom(pngBuf, padBottom) {
  const png = PNG.sync.read(pngBuf);
  const { width, height, data } = png;
  const MIN_RANGE = 15;
  for (let y = height - 1; y >= 0; y--) {
    const off = y * width * 4;
    let minR = 255, maxR = 0;
    for (let x = 0; x < width; x += 2) {
      const i = off + x * 4;
      if (data[i + 3] === 0) continue;
      const r = data[i]; if (r < minR) minR = r; if (r > maxR) maxR = r;
    }
    if (maxR - minR > MIN_RANGE) return Math.min(y + 1 + (padBottom || 20), height);
  }
  return height;
}

// ============================================================
// 登录 & 导航
// ============================================================
function saveSession(state) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state));
}

function loadSession() {
  if (fs.existsSync(CONFIG.stateFile)) return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf-8'));
  if (fs.existsSync(LEGACY_STATE)) {             // 旧版把会话存在工具目录里：搬到用户目录
    const state = JSON.parse(fs.readFileSync(LEGACY_STATE, 'utf-8'));
    saveSession(state);
    fs.unlinkSync(LEGACY_STATE);
    console.log('（登录会话已从工具目录搬到 ' + CONFIG.stateFile + '）');
    return state;
  }
  return undefined;
}

// 弹出浏览器窗口，由本人用自己的禅道账号登录；返回登录后的会话（cookie），不经手密码
async function interactiveLogin() {
  console.log('\n需要登录禅道：已弹出浏览器窗口，请用【你自己的禅道账号】登录。');
  console.log('登录成功后窗口会自动关闭（最多等 ' + LOGIN_WAIT_MS / 1000 + ' 秒）。账号密码只在浏览器里输入，脚本不会保存密码。\n');
  const b = await chromium.launch({ headless: false, executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined });
  try {
    const c = await b.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await c.newPage();
    await p.goto(CONFIG.baseUrl + '/user-login.html', { waitUntil: 'domcontentloaded', timeout: W.TIMEOUT });
    if (CONFIG.username) await p.locator('input[name="account"]').fill(CONFIG.username).catch(() => {});  // 只预填用户名
    const closed = new Promise((_, reject) => {
      const fail = () => reject(new Error('登录窗口被关闭，未完成登录'));
      p.on('close', fail);
      b.on('disconnected', fail);
    });
    await Promise.race([
      p.waitForURL(u => !u.href.includes('user-login'), { timeout: LOGIN_WAIT_MS, waitUntil: 'commit' }),
      closed,
    ]).catch(e => {
      throw new Error(e.name === 'TimeoutError' ? '等待登录超时（' + LOGIN_WAIT_MS / 1000 + ' 秒）' : e.message);
    });
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    return await c.storageState();
  } finally {
    await b.close().catch(() => {});
  }
}

async function ensureLogin(page, forceLogin = false) {
  if (!forceLogin) {
    await page.goto(CONFIG.baseUrl + '/my.html', { waitUntil: 'domcontentloaded', timeout: W.TIMEOUT });
    if (!page.url().includes('user-login')) return;              // 会话有效
  }
  if (CONFIG.username && CONFIG.password && !forceLogin) {         // config.json 里写了自己的账号密码：自动登录
    try {
      await page.locator('input[name="account"]').fill(CONFIG.username);
      await page.locator('input[name="password"]').fill(CONFIG.password);
      await Promise.all([
        page.waitForURL(/\/my/, { timeout: W.TIMEOUT, waitUntil: 'domcontentloaded' }),  // 首页加载慢，不等 load
        page.locator('#submit, button[type="submit"], input[type="submit"], .btn-primary').first().click(),
      ]);
    } catch (e) {
      if (page.url().includes('user-login')) {
        console.log('config.json 里的账号密码没能登录（密码可能已修改）→ 改用弹窗登录。登录后记得更新 config.json。');
      }
    }
    if (!page.url().includes('user-login')) {
      saveSession(await page.context().storageState());
      return;
    }
  }
  const state = await interactiveLogin();
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies);
  saveSession(state);
  await page.goto(CONFIG.baseUrl + '/my.html', { waitUntil: 'domcontentloaded', timeout: W.TIMEOUT });
  if (page.url().includes('user-login')) throw new Error('登录后仍停在登录页，请重新运行：node zentao-shot.js --login');
  console.log('登录成功，会话已保存到 ' + CONFIG.stateFile + '（只在本机，不要发给别人）');
}
async function ensureProjectSpace(page) {
  if (!page.url().includes('doc-projectSpace')) {
    await page.goto(CONFIG.baseUrl + '/doc-projectSpace.html', { waitUntil: 'domcontentloaded', timeout: W.TIMEOUT });
    await page.waitForTimeout(W.PAGE);
  }
  const f = getFrame(page);
  const t = await f.evaluate(() => document.body?.innerText || '');
  if ((t.includes('暂无数据') || t.includes('没有文档')) && t.includes('共 0 项')) {
    await f.locator('text="项目空间"').first().click();
    await page.waitForTimeout(W.TAB);
  }
}

// ============================================================
// 项目 & 文档列表
// ============================================================
function _filterProjects() {
  const exclude = new Set([
    '文档', '仪表盘', '快捷访问', '我的空间', '团队空间', '产品空间', '项目空间',
    '浩东', '我参与的', '其他', '仅显示有文档的项目', '显示已关闭的项目',
    '', '共 1 项', '每页 5 项', '1/1',
  ]);
  const noise = ['没有文档', '暂无数据'];
  const seen = new Set(), out = [];
  for (const el of document.querySelectorAll('div')) {
    const t = el.textContent?.trim();
    if (t && t.length >= 2 && t.length <= 20 && !t.includes('\n') && !t.includes('共')
        && !exclude.has(t) && !t.match(/^\d/) && !noise.some(n => t.includes(n)) && !seen.has(t)) {
      seen.add(t); out.push(t);
    }
  }
  return out;
}
async function getProjects(page) {
  await page.goto(CONFIG.baseUrl + '/doc-projectSpace.html', { waitUntil: 'domcontentloaded', timeout: W.TIMEOUT });
  await page.waitForTimeout(W.PAGE);
  let f = getFrame(page);
  let projects = await f.evaluate(_filterProjects);
  if (projects.length === 0) {
    await f.locator('text="项目空间"').first().click();
    await page.waitForTimeout(W.TAB);
    projects = await getFrame(page).evaluate(_filterProjects);
  }
  // 翻页获取全部项目
  const all = new Set(projects);
  for (let pg = 1; pg < 20; pg++) {
    const hasNext = await getFrame(page).evaluate(() => {
      const nav = document.querySelector('nav.pager, .pager');
      if (!nav) return false;
      const nextBtn = nav.querySelector('button.pager-link:not(.disabled) .icon-angle-right, button:not(.disabled) .icon-angle-right');
      return !!(nextBtn && nextBtn.offsetParent !== null);
    });
    if (!hasNext) break;
    if (!(await clickNextPage(page))) break;
    await getFrame(page).evaluate(_filterProjects).then(more => more.forEach(p => all.add(p)));
  }
  return [...all];
}
// 文档列表当前页的行（页面 eval 用）：标题单元格的 data-row 就是文档 ID
function _collectDocRowsEval() {
  const out = [];
  for (const cell of document.querySelectorAll('.dtable-cell[data-col="title"][data-row]')) {
    const id = cell.getAttribute('data-row');
    const a = cell.querySelector('a.doc-list-item-title');
    if (!/^\d+$/.test(id) || !a) continue;
    out.push({ id, title: (a.textContent || a.title || '').trim() });
  }
  return out;
}
function _hasNextPageEval() {
  const nav = document.querySelector('nav.pager, .pager');
  if (!nav) return false;
  const nextBtn = nav.querySelector('button.pager-link:not(.disabled) .icon-angle-right, button:not(.disabled) .icon-angle-right');
  return !!(nextBtn && nextBtn.offsetParent !== null);
}

async function openProject(page, projectName) {
  await ensureProjectSpace(page);
  await getFrame(page).locator('text=' + projectName).first().click();
  await getFrame(page).locator('.dtable-cell[data-col="title"]').first().waitFor({ timeout: W.TIMEOUT }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: W.NETIDLE }).catch(() => {});
  await page.waitForTimeout(W.PAGE);
}

// 项目文档列表
// 进入项目后的默认视图就是该项目的「全部文档」（已包含项目主库和各阶段主库，不含附件库里的文件），
// 所以不再逐个点击子库。返回 [{ id, title, name, file }]：
//   name  列表显示 / 输入匹配用，同名文档按列表顺序加 " (2)"、" (3)"
//   file  截图文件名（不含扩展名），与 name 使用同样的后缀
async function getDocsForProject(page, projectName) {
  await openProject(page, projectName);
  const byId = new Map();
  for (let pg = 1; pg <= 50; pg++) {
    const rows = await getFrame(page).evaluate(_collectDocRowsEval);
    rows.forEach(r => { if (!byId.has(r.id)) byId.set(r.id, r); });
    if (!(await getFrame(page).evaluate(_hasNextPageEval))) break;
    if (!(await clickNextPage(page))) break;
    // 等下一页渲染出来（首行 ID 变化）；翻不动就停止
    let moved = false;
    for (let t = 0; t < 20 && !moved; t++) {
      const cur = await getFrame(page).evaluate(_collectDocRowsEval);
      moved = cur.length > 0 && cur[0].id !== rows[0]?.id;
      if (!moved) await page.waitForTimeout(250);
    }
    if (!moved) break;
  }

  const pagerText = await getFrame(page).evaluate(() => document.querySelector('nav.pager, .pager')?.innerText || '');
  const total = parseInt((pagerText.match(/共\s*(\d+)\s*项/) || [])[1], 10);
  if (total && total !== byId.size) console.log('  [warn] 列表显示共 ' + total + ' 项，实际只收集到 ' + byId.size + ' 篇');

  const docs = [...byId.values()];
  const count = {}, used = new Set();
  for (const d of docs) {
    const base = d.title.replace(/[\/:*?"<>|]/g, '_').slice(0, 50);
    const key = base.toLowerCase(); // Windows 文件名不区分大小写
    count[key] = (count[key] || 0) + 1;
    let suffix = count[key] === 1 ? '' : ' (' + count[key] + ')';
    if (used.has((base + suffix).toLowerCase())) suffix = ' #' + d.id; // 极端情况：与真实标题 "xxx (2)" 撞名
    used.add((base + suffix).toLowerCase());
    d.name = d.title + suffix;
    d.file = base + suffix;
  }
  return docs;
}

// 按序号或名称选文档：纯数字且在范围内 → 列表第 n 项；否则先精确匹配 name（可带 " (2)" 后缀），再匹配标题（同名取第一篇）
function pickDoc(docs, input) {
  const n = parseInt(input, 10);
  if (/^\d+$/.test(input) && n >= 1 && n <= docs.length) return docs[n - 1];
  const d = docs.find(x => x.name === input) || docs.find(x => x.title === input);
  const same = d && d.title === input ? docs.filter(x => x.title === input) : [];
  if (same.length > 1) {
    console.log('  注: 共有 ' + same.length + ' 篇同名文档，本次截第一篇；其余可输入: ' + same.slice(1).map(x => '"' + x.name + '"').join(', '));
  }
  return d || null;
}

// ============================================================
// 文档截图辅助
// ============================================================
// 按文档 ID 直接打开 doc-view 页（同名文档也能准确区分，不依赖列表翻页和标题点击）
async function openDoc(page, doc) {
  await page.goto(CONFIG.baseUrl + '/doc-view-' + doc.id + '.html', { waitUntil: 'domcontentloaded', timeout: W.TIMEOUT });
  const start = Date.now();
  while (Date.now() - start < W.EDITOR_TO) {
    const f = page.frame({ name: 'app-doc' });
    if (f && (await f.locator('.doc-view').count().catch(() => 0)) > 0) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
async function waitForDocStable(page) {
  await page.waitForLoadState('networkidle', { timeout: W.NETIDLE }).catch(() => {});
  await page.waitForTimeout(W.DOC_BUFFER);
  const f = getFrame(page);
  try { await f.locator('.editor.doc-editor-control, .doc-editor').first().waitFor({ state: 'attached', timeout: W.EDITOR_TO }); }
  catch (e) { console.log('  [warn] editor: ' + e.message.slice(0, 50)); return; }

  // 等待异步编辑器加载完成（loading 指示器消失）
  const loadStart = Date.now();
  let loadingLogged = false;
  while (Date.now() - loadStart < W.EDITOR_LOAD) {
    const stillLoading = await f.evaluate(() => {
      const loadEl = document.querySelector('.load-indicator.loading, [data-loading]');
      if (!loadEl) return false;
      const style = window.getComputedStyle(loadEl);
      return style.display !== 'none' && style.visibility !== 'hidden' && loadEl.offsetParent !== null;
    }).catch(() => true);
    if (!stillLoading) break;
    if (!loadingLogged) { console.log('  等待编辑器加载...'); loadingLogged = true; }
    await page.waitForTimeout(1000);
  }
  // 编辑器加载后给渲染一点时间
  await page.waitForTimeout(1000);

  let prev = -1, stable = 0;
  for (let i = 0; i < W.STABLE_MAX; i++) {
    await page.waitForTimeout(W.STABLE_POLL);
    const len = await f.evaluate(() => {
      const ed = document.querySelector('.editor.doc-editor-control') || document.querySelector('.doc-editor');
      return ed ? ed.innerText?.length || 0 : 0;
    });
    if (len === prev && len > 0) { if (++stable >= W.STABLE_NEED) break; }
    else { stable = 0; }
    prev = len;
  }
}
async function skipIfAttachment(page) {
  const f = getFrame(page);
  const hasAffine = (await f.locator('.editor.doc-editor-control').count()) > 0;
  const hasOld = (await f.locator('.doc-editor').count()) > 0;
  if (hasAffine) {
    const info = await f.evaluate(() => {
      const ed = document.querySelector('.editor.doc-editor-control');
      if (!ed) return { len: 0, imgCount: 0 };
      const len = ed.innerText?.length || 0;
      const imgCount = ed.querySelectorAll('img').length;
      return { len, imgCount };
    });
    // 有图片内容时不跳过，即使文字少
    if (info.imgCount > 0) { console.log('  检测到 ' + info.imgCount + ' 张图片，继续截图'); return false; }
    if (info.len <= 60) { console.log('  跳过: 仅附件(无文字无图片)'); return true; }
  }
  if (!hasAffine && hasOld) {
    const hasFiles = (await f.locator('.file, .files, [class*="file-list"], [class*="attachment"], [class*="doc-files"]').count()) > 0;
    if (hasFiles) {
      const info = await f.evaluate(() => {
        const ed = document.querySelector('.doc-editor');
        if (!ed) return { len: 0, imgCount: 0 };
        const len = ed.innerText?.trim().length || 0;
        const imgCount = ed.querySelectorAll('img').length;
        return { len, imgCount };
      });
      // 有图片内容时不跳过
      if (info.imgCount > 0) { console.log('  检测到 ' + info.imgCount + ' 张图片，继续截图'); return false; }
      if (info.len < 150) { console.log('  跳过: 仅附件(无文字无图片)'); return true; }
    }
  }
  return false;
}

// 等待编辑器内图片加载完成
async function waitImages(f) {
  await f.evaluate(async () => {
    const imgs = [...document.querySelectorAll('.editor.doc-editor-control img, .doc-editor img')];
    await Promise.all(imgs.map(img => img.complete ? null
      : new Promise(r => { img.addEventListener('load', r); img.addEventListener('error', r); setTimeout(r, 10000); })));
  }).catch(() => {});
}

// 放大 viewport 直到文档全文都在 iframe 内渲染（.doc-view-content 不再需要滚动）
// 注意：文档滚动发生在 .doc-view-content 内部，window 本身不滚动，所以不能靠 window.scrollTo 分段截图
async function fitViewportToContent(page) {
  const f = getFrame(page);
  for (let i = 0; i < 6; i++) {
    await waitImages(f);
    const overflow = await f.evaluate(() => {
      const c = document.querySelector('.doc-view-content');
      if (c) return c.scrollHeight - c.clientHeight;
      return document.documentElement.scrollHeight - window.innerHeight;
    });
    if (overflow <= 2) return;
    const cur = page.viewportSize();
    const h = Math.min(MAX_VP_H, cur.height + overflow + 200);
    if (h <= cur.height) { console.log('  [warn] 文档超长，超出最大 viewport ' + MAX_VP_H + 'px，底部可能被截断'); return; }
    await page.setViewportSize({ width: cur.width, height: h });
    await page.waitForTimeout(W.VP_SETTLE);
  }
}

// 左右加白边
function addHPadding(png) {
  const w = png.width + PAD_H * 2;
  const padded = new PNG({ width: w, height: png.height });
  padded.data.fill(255);
  for (let row = 0; row < png.height; row++) {
    png.data.copy(padded.data, (row * w + PAD_H) * 4, row * png.width * 4, (row + 1) * png.width * 4);
  }
  return padded;
}

// Affine 编辑器：viewport 放大到容纳全文 → 一次截取编辑器元素 → 裁底部空白 → 加白边
async function renderAndCaptureAffine(page, out) {
  const f = getFrame(page);
  const vp = page.viewportSize();

  await fitViewportToContent(page);
  const buf = await f.locator(CONTENT_EL_AFFINE).screenshot({ timeout: W.EDITOR_TO });
  const png = PNG.sync.read(buf);
  const finalH = trimBottom(buf, PAD_BOTTOM);
  const dst = new PNG({ width: png.width, height: Math.max(50, finalH) });
  png.data.copy(dst.data, 0, 0, dst.height * png.width * 4);
  const padded = addHPadding(dst);
  fs.writeFileSync(out, PNG.sync.write(padded));
  console.log('  截图: ' + padded.width + 'x' + padded.height + ' (viewport 高 ' + page.viewportSize().height + ')');

  // 恢复 viewport
  await page.setViewportSize(vp);
  return out;
}

// 旧版编辑器：展开 overflow
async function expandOldEditor(page) {
  const f = getFrame(page);
  const captured = await f.evaluate(sel => {
    const el = document.querySelector(sel);
    return el ? Math.max(el.scrollHeight, document.body.scrollHeight, document.documentElement.scrollHeight) : 0;
  }, EXPAND_OLD);
  await f.evaluate(sel => {
    for (const el of document.querySelectorAll(sel)) {
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', 'auto', 'important');
    }
  }, EXPAND_OLD);
  await page.waitForTimeout(W.OVERFLOW_OLD);
  return captured;
}

// 截图 + 裁切
async function captureAndCrop(page, contentHeight, out, isAffine) {
  const f = getFrame(page);

  // 直接从 iframe 内截图（避免主页面截取 iframe 时的渲染不完整问题）
  // 目标：截取 .doc-view 内容区域（含编辑器正文）
  const targetEl = isAffine ? '.doc-view' : '.doc-view';
  const elInfo = await f.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, targetEl);

  if (!elInfo || elInfo.h <= 100) {
    // 回退：全页截图
    await f.locator(targetEl).screenshot({ path: out });
    return out;
  }

  // 确保 iframe 内 overflow 展开
  await f.evaluate(() => {
    const sel = '.doc-view, .doc-view-content, .doc-main, .doc-editor, .editor.doc-editor-control, #mainContent';
    for (const el of document.querySelectorAll(sel)) {
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', 'auto', 'important');
    }
    document.documentElement.style.setProperty('overflow', 'visible', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
  });
  await page.waitForTimeout(500);

  // 从 iframe 内直接截图 .doc-view
  const rawBuf = await f.locator(targetEl).screenshot();
  const rawPng = PNG.sync.read(rawBuf);
  console.log('  iframe截图: ' + rawPng.width + 'x' + rawPng.height + ' (contentH=' + contentHeight + ')');

  // trimBottom 裁剪底部空白
  const finalH = trimBottom(rawBuf, PAD_BOTTOM);
  const dst = new PNG({ width: rawPng.width, height: Math.max(50, finalH) });
  rawPng.data.copy(dst.data, 0, 0, dst.height * rawPng.width * 4);
  fs.writeFileSync(out, PNG.sync.write(dst));
  console.log('  裁切后: ' + dst.width + 'x' + dst.height);

  return out;
}

// ============================================================
// 主流程
// ============================================================
// doc: getDocsForProject 返回的 { id, title, name, file }
async function screenshotDoc(page, projectName, doc) {
  const projectDir = path.join(CONFIG.outputBase, projectName);
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
  const out = path.join(projectDir, doc.file + '.png');

  console.log('  [1/5] 打开文档 #' + doc.id + '...');
  if (!await openDoc(page, doc)) throw new Error('无法打开文档 #' + doc.id);
  // 鼠标移出正文区域：鼠标停在图片上时会浮出「下载 / ⋮」工具栏，被一起截进去
  await page.mouse.move(0, 0);
  console.log('  [2/5] 等待加载...'); await waitForDocStable(page);
  console.log('  [3/5] 检测内容...');

  // 检测文档正文是否为空（仅元数据无正文内容）
  const f = getFrame(page);
  const bodyInfo = await f.evaluate(() => {
    const ed = document.querySelector('.editor.doc-editor-control') || document.querySelector('.doc-editor');
    if (!ed) return { len: 0, hasContent: false };
    // 找到并排除文档标题（第一个 h1，属于元数据而非正文）
    const h1s = ed.querySelectorAll('h1');
    const titleEl = h1s.length > 0 ? h1s[0] : null;
    const titleText = titleEl ? (titleEl.innerText?.trim() || '') : '';
    // 检查标题之后是否有实质性内容元素（段落、表格、图片等）
    const contentEls = ed.querySelectorAll('p, h2, h3, h4, h5, h6, table, ul, ol, pre, blockquote, img, [class*="paragraph"], [class*="content-block"], [class*="editor-block"]');
    for (const el of contentEls) {
      if (el === titleEl) continue;
      const txt = el.innerText?.trim() || '';
      if (txt.length > 5) return { len: ed.innerText?.length || 0, hasContent: true };
      if (el.tagName === 'IMG' || el.querySelector('img')) return { len: ed.innerText?.length || 0, hasContent: true };
    }
    // 无实质性正文 → 排除标题后检查剩余文本长度
    const totalLen = ed.innerText?.length || 0;
    const bodyLen = Math.max(0, totalLen - titleText.length);
    return { len: totalLen, hasContent: bodyLen > 80 };
  });
  if (!bodyInfo.hasContent) {
    console.log('  ⚠ 警告: 文档正文为空（仅有元数据），截图将只含标题信息');
  }

  if (await skipIfAttachment(page)) return null;

  const isAffine = (await f.locator('.editor.doc-editor-control').count()) > 0;
  const isOld = !isAffine && (await f.locator('.doc-editor, .doc-view').count()) > 0;

  if (isAffine) {
    console.log('  [4/5] Affine 编辑器截图...');
    return await renderAndCaptureAffine(page, out);
  }

  let contentHeight = 0;
  if (isOld) { console.log('  [4/5] 旧版编辑器展开...'); contentHeight = await expandOldEditor(page); }
  else { console.log('  [4/5] 通用截图...'); }

  console.log('  [5/5] 截图 + 裁切...');
  return await captureAndCrop(page, contentHeight, out, isAffine);
}

// ============================================================
// 入口
// ============================================================
(async () => {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const args = argv.filter(a => !a.startsWith('--'));
  if (flags.has('--logout')) {
    for (const f of [CONFIG.stateFile, LEGACY_STATE]) if (fs.existsSync(f)) fs.unlinkSync(f);
    console.log('已退出：删除了本机保存的禅道登录会话。下次运行会弹出窗口重新登录。');
    return;
  }
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--disable-extensions', '--disable-background-networking'],
  });
  const ctx = await browser.newContext({ viewport: CONFIG.viewport, storageState: loadSession() });
  const page = await ctx.newPage();

  console.log('登录...'); await ensureLogin(page, flags.has('--login'));
  if (flags.has('--login') && args.length === 0) { await browser.close(); return; }   // 只登录（首次设置 / 切换账号）

  let projectName = args[0];

  if (!projectName) {
    console.log('获取项目列表...');
    const projs = await getProjects(page);
    console.log('\n========== 可选项目 ==========');
    projs.forEach((p, i) => console.log('  [' + (i + 1) + '] ' + p));
    console.log('===============================');
    projectName = (await ask('\n选择序号或输入项目名: ')).trim();
    const n = parseInt(projectName);
    if (!isNaN(n) && n >= 1 && n <= projs.length) projectName = projs[n - 1];
  }
  console.log('→ 项目: ' + projectName);

  console.log('获取文档列表...');
  const docs = await getDocsForProject(page, projectName);
  if (docs.length === 0) { console.log('未找到文档'); await browser.close(); process.exit(1); }

  // 要截的文档：命令行直接指定（可多个），或交互选择（序号 / 名称，多选逗号分隔）
  let inputs = args.length > 1 ? args.slice(1) : null;
  if (!inputs) {
    console.log('\n========== ' + projectName + ' (' + docs.length + '个文档) ==========');
    docs.forEach((d, i) => console.log('  [' + (i + 1) + '] ' + d.name));
    console.log('========================================');
    const ans = await ask('\n选择序号(多选逗号分隔)或输入文档名: ');
    inputs = ans.split(',').map(s => s.trim()).filter(Boolean);
    if (inputs.length === 0) console.log('未选择文档');
  }
  const targets = inputs.map(input => ({ input, doc: pickDoc(docs, input) }));

  // 逐篇截图：单篇失败不影响其余
  const done = [], skipped = [], failed = [];
  for (const { input, doc } of targets) {
    if (!doc) { console.log('\n找不到文档: ' + input); failed.push(input); continue; }
    console.log('\n→ 截图: ' + doc.name + '...');
    try {
      const o = await screenshotDoc(page, projectName, doc);
      if (o) { done.push(doc.name); console.log('  完成: ' + o); }
      else skipped.push(doc.name);
    } catch (e) {
      failed.push(doc.name);
      console.log('  失败: ' + e.message.split('\n')[0]);
    }
  }
  if (targets.length > 1) {
    console.log('\n========== 汇总：完成 ' + done.length + '，跳过 ' + skipped.length + '，失败 ' + failed.length + ' ==========');
    skipped.forEach(n => console.log('  跳过: ' + n));
    failed.forEach(n => console.log('  失败: ' + n));
  }
  await browser.close();
})().catch(e => { console.error('致命错误:', e.message); process.exit(1); });
