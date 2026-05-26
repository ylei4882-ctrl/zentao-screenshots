// ============================================================
// 禅道文档截图工具
// 用法: node zentao-shot.js [项目名] [文档名]
// ============================================================
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { PNG } = require('pngjs');

// ============================================================
// 配置
// ============================================================
const SCRIPT_DIR = __dirname;
const configPath = path.join(SCRIPT_DIR, 'config.json');
if (!fs.existsSync(configPath)) { console.error('错误: 找不到 config.json'); process.exit(1); }
const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const CONFIG = {
  baseUrl: userConfig.baseUrl || 'http://192.168.10.227:90/zentao',
  username: userConfig.username || '',
  password: userConfig.password || '',
  stateFile: path.join(SCRIPT_DIR, '.zentao-session.json'),
  outputBase: userConfig.outputPath || SCRIPT_DIR,
  viewport: userConfig.viewport || { width: 1920, height: 3600 },
};

// ============================================================
// 等待 / 超时
// ============================================================
const W = {
  PAGE: 800, TAB: 600, NETIDLE: 15000, DOC_BUFFER: 2000,
  STABLE_POLL: 1000, STABLE_MAX: 30, STABLE_NEED: 3,
  SCROLL_INITIAL: 1000, SCROLL_STEP: 800, SCROLL_FINAL: 1000,
  OVERFLOW_SETTLE: 800, OVERFLOW_OLD: 1000, POST_EXPAND: 1500,
  VP_RESIZE: 500, VP_SETTLE: 800,
  CLICK: 3000, CLICK_ALT: 2000, FALLBACK: 5000,
  TIMEOUT: 10000, EDITOR_TO: 15000,
};
const PAD_X = 10, PAD_BOTTOM = 10;

// ============================================================
// 选择器
// ============================================================
const SCROLL_CONTAINER = '.doc-view-content, .doc-main, .scrollbar-hover';
const EXPAND_ALL = SCROLL_CONTAINER + ', .doc-app-body, #mainContent, #main, .doc-editor, .doc-view, .detail-body, .detail-main, .detail-sections, .editor.doc-editor-control';
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

// 像素裁剪：从底部向上扫正文区域（跳过左侧大纲面板），找内容结束行
function trimBottom(pngBuf, padBottom) {
  const png = PNG.sync.read(pngBuf);
  const { width, height, data } = png;
  const L = Math.round(width * 0.2);  // 左 20% 是大纲面板，跳过
  const R = Math.round(width * 0.95); // 右 5% 留边距
  const MIN_RANGE = 15;
  for (let y = height - 1; y >= 0; y--) {
    const off = y * width * 4;
    let minR = 255, maxR = 0;
    for (let x = L; x < R; x += 4) {
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
async function ensureLogin(page) {
  await page.goto(CONFIG.baseUrl + '/my.html', { waitUntil: 'domcontentloaded', timeout: W.TIMEOUT });
  if (page.url().includes('user-login')) {
    await page.locator('input[name="account"]').fill(CONFIG.username);
    await page.locator('input[name="password"]').fill(CONFIG.password);
    await page.locator('#submit, button[type="submit"], input[type="submit"], .btn-primary').first().click();
    await page.waitForURL(/\/my/, { timeout: W.TIMEOUT });
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(await page.context().storageState()));
  }
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
  return projects;
}
async function getDocsForProject(page, projectName) {
  await ensureProjectSpace(page);
  const f = getFrame(page);
  await f.locator('text=' + projectName).first().click();
  await page.waitForTimeout(W.PAGE);
  return await getFrame(page).evaluate(exName => {
    const exclude = new Set([
      '文档', '仪表盘', '快捷访问', '我的空间', '团队空间', '产品空间', '项目空间',
      'ID', '文档标题', '收藏', '浏览次数', '由谁添加', '创建日期', '修改者', '修改日期', '操作',
      '全部', '草稿', '我收藏的', '我创建的', '我编辑的', '导入', '创建',
      '项目主库', '附件库', '项目', '执行', exName,
    ]);
    const seen = new Set(), out = [];
    for (const el of document.querySelectorAll('a')) {
      const t = el.textContent?.trim();
      if (t && t.length > 2 && t.length < 80 && !seen.has(t) && !exclude.has(t)
          && !t.includes('共 ') && !t.includes('每页') && !t.match(/^\d+$/)
          && !t.includes('阶段主库') && !t.includes('库：') && !t.includes('全部')) {
        seen.add(t); out.push(t);
      }
    }
    return out;
  }, projectName);
}

// ============================================================
// 文档截图辅助
// ============================================================
async function clickDoc(page, projectName, docName) {
  const f = getFrame(page); let ok = false;
  try { await f.locator('.cursor-pointer:has([title="' + docName + '"])').first().click({ timeout: W.CLICK }); ok = true; }
  catch (e) { console.log('  [warn] click: ' + e.message.slice(0, 50)); }
  if (!ok) {
    try { await f.locator('a:has-text("' + docName + '")').first().click({ timeout: W.CLICK_ALT }); ok = true; }
    catch (e) { console.log('  [warn] click: ' + e.message.slice(0, 50)); }
  }
  if (!ok) {
    console.log('  回退: 重新导航...');
    await ensureProjectSpace(page);
    const t = getFrame(page);
    await t.locator('text=' + projectName).first().click();
    await page.waitForTimeout(W.TAB);
    const tf = getFrame(page);
    try { await tf.locator('.cursor-pointer:has([title="' + docName + '"])').first().click({ timeout: W.FALLBACK }); }
    catch { await tf.locator('a:has-text("' + docName + '")').first().click(); }
  }
  await getFrame(page).locator('#main').waitFor({ state: 'visible', timeout: W.TIMEOUT });
}
async function waitForDocStable(page) {
  await page.waitForLoadState('networkidle', { timeout: W.NETIDLE }).catch(() => {});
  await page.waitForTimeout(W.DOC_BUFFER);
  const f = getFrame(page);
  try { await f.locator('.editor.doc-editor-control, .doc-editor').first().waitFor({ state: 'attached', timeout: W.EDITOR_TO }); }
  catch (e) { console.log('  [warn] editor: ' + e.message.slice(0, 50)); return; }
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
async function verifyDocOpened(page, docName) {
  const f = getFrame(page);
  const t = await f.evaluate(() => document.body?.innerText || '');
  if (!(t.includes('文档标题') && t.includes('由谁添加'))) return true;
  console.log('  重试打开...');
  try {
    await f.locator('.cursor-pointer:has([title="' + docName + '"])').first().click({ timeout: W.FALLBACK });
    await f.locator('#main').waitFor({ state: 'visible', timeout: W.TIMEOUT });
    try { await f.locator('.editor.doc-editor-control, .doc-editor').first().waitFor({ state: 'attached', timeout: W.TIMEOUT }); } catch {}
  } catch (e) { console.log('  [warn] retry: ' + e.message.slice(0, 50)); }
  const t2 = await f.evaluate(() => document.body?.innerText || '');
  if (t2.includes('文档标题') && t2.includes('由谁添加')) {
    try { await f.locator('a:has-text("' + docName + '")').first().click({ timeout: W.FALLBACK }); await page.waitForTimeout(1000); } catch {}
  }
  return !(await f.evaluate(() => document.body?.innerText || '')).includes('由谁添加');
}
async function skipIfAttachment(page) {
  const f = getFrame(page);
  const hasAffine = (await f.locator('.editor.doc-editor-control').count()) > 0;
  const hasOld = (await f.locator('.doc-editor').count()) > 0;
  if (hasAffine) {
    const len = await f.evaluate(() => { const ed = document.querySelector('.editor.doc-editor-control'); return ed ? ed.innerText?.length || 0 : 0; });
    if (len <= 60) { console.log('  跳过: 仅附件'); return true; }
  }
  if (!hasAffine && hasOld) {
    const hasFiles = (await f.locator('.file, .files, [class*="file-list"], [class*="attachment"], [class*="doc-files"]').count()) > 0;
    if (hasFiles) {
      const t = await f.evaluate(() => { const ed = document.querySelector('.doc-editor'); return ed ? ed.innerText?.trim() || '' : ''; });
      if (t.length < 150) { console.log('  跳过: 仅附件'); return true; }
    }
  }
  return false;
}

// Affine 编辑器：缩 viewport → 逐块滚动触发懒渲染 → 展开 overflow → 返回 scrollHeight
async function renderAffine(page) {
  const f = getFrame(page);
  const vp = page.viewportSize();
  await page.setViewportSize({ width: vp.width, height: 400 });
  await page.waitForTimeout(W.VP_RESIZE);

  const preH = await f.evaluate(sel => {
    const el = document.querySelector(sel); return el ? el.scrollHeight : 0;
  }, SCROLL_CONTAINER);

  // 滚动触发懒渲染，追踪最大 scrollHeight
  const maxFromScroll = await f.evaluate(async ({init, stepMs, sel}) => {
    const c = document.querySelector(sel); if (!c) return 0;
    await new Promise(r => setTimeout(r, init));
    let total = c.scrollHeight, maxH = total;
    const s = Math.max(c.clientHeight, 300);
    for (let y = 0; y < total; y += s) {
      c.scrollTo(0, y);
      await new Promise(r => setTimeout(r, stepMs));
      total = c.scrollHeight; if (total > maxH) maxH = total;
    }
    return maxH;
  }, {init: W.SCROLL_INITIAL, stepMs: W.SCROLL_STEP, sel: SCROLL_CONTAINER});

  // 滚回顶部
  await f.evaluate(sel => { const c = document.querySelector(sel); if (c) c.scrollTo(0, 0); }, SCROLL_CONTAINER);
  await page.waitForTimeout(W.SCROLL_FINAL);

  // 恢复大 viewport 后测量（关键：3600px 下 Affine 渲染更多内容，scrollHeight 才准确）
  await page.setViewportSize(vp);
  await page.waitForTimeout(W.OVERFLOW_SETTLE);

  const cur = await f.evaluate((contentSel) => {
    const el = document.querySelector(contentSel);
    return el ? Math.max(el.scrollHeight, document.body.scrollHeight, document.documentElement.scrollHeight) : 0;
  }, CONTENT_EL_AFFINE);
  const captured = Math.max(cur, preH, maxFromScroll);

  // 展开 overflow
  await f.evaluate(sel => {
    for (const el of document.querySelectorAll(sel)) {
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', 'auto', 'important');
    }
  }, EXPAND_ALL);

  // 等图片 + 网络空闲
  await f.evaluate(async () => {
    const imgs = document.querySelectorAll('img');
    await Promise.all([...imgs].map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = img.onerror = r; })));
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(W.POST_EXPAND);

  return captured;
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
async function captureAndCrop(page, contentHeight, projectDir, docName, isAffine) {
  const f = getFrame(page);
  const safe = docName.replace(/[\/:*?"<>|]/g, '_').slice(0, 50);
  const out = path.join(projectDir, safe + '.png');
  const contentSel = isAffine ? CONTENT_EL_AFFINE : CONTENT_EL_OLD;

  // 定位：iframe 在主页面中有偏移，需要加 iframe 坐标才能正确裁剪
  const iframeBox = await page.evaluate(() => {
    const ifr = document.querySelector('iframe[name="app-doc"]');
    if (!ifr) return { x: 0, y: 0 };
    const r = ifr.getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // 宽度用 .doc-view（跳过左侧大纲面板，也不裁右边内容）
  // 顶部用编辑器 body（跳过标题栏+编辑人）
  const info = await f.evaluate(({cachedH, bodySel}) => {
    const view = document.querySelector('.doc-view');
    const body = document.querySelector(bodySel);
    if (!view || !body) return null;
    const v = view.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    const domH = Math.max(body.scrollHeight, document.body.scrollHeight, document.documentElement.scrollHeight, b.height);
    return { x: v.x, y: b.y, w: v.width, h: Math.max(cachedH || 0, domH) };
  }, {cachedH: contentHeight, bodySel: contentSel});

  if (!info || info.h <= 100) { await page.screenshot({ path: out, fullPage: true }); return out; }

  // 绝对坐标 = iframe 偏移 + iframe 内元素坐标
  const absX = iframeBox.x + info.x;
  const absY = iframeBox.y + info.y;

  const targetH = Math.max(contentHeight, 15000);
  console.log('  内容区 absX=' + absX + ' absY=' + absY + ' w=' + info.w + ' contentH=' + contentHeight + ' targetH=' + targetH);

  // 展开主页面 + iframe
  await page.evaluate(h => {
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.documentElement.style.setProperty('overflow', 'visible', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
    const ifr = document.querySelector('iframe[name="app-doc"]');
    if (ifr) { ifr.style.setProperty('height', h + 'px', 'important'); ifr.style.setProperty('max-height', 'none', 'important'); }
  }, targetH);
  await page.waitForTimeout(W.OVERFLOW_OLD);

  const origVp = page.viewportSize();
  await page.setViewportSize({ width: origVp.width, height: targetH + 200 });
  await page.waitForTimeout(W.VP_SETTLE);

  const rawBuf = await page.screenshot();
  const fullPng = PNG.sync.read(rawBuf);

  const cx = Math.max(0, Math.floor(absX) - PAD_X);
  const cy = Math.max(0, Math.floor(absY));
  const cw = Math.min(Math.floor(info.w) + PAD_X * 2, fullPng.width - cx);
  const tmpH = Math.min(contentHeight + PAD_BOTTOM, fullPng.height - cy);

  const tmp = new PNG({ width: cw, height: Math.max(50, tmpH) });
  for (let row = 0; row < tmp.height; row++) {
    const srcOff = ((cy + row) * fullPng.width + cx) * 4;
    fullPng.data.copy(tmp.data, row * tmp.width * 4, srcOff, srcOff + tmp.width * 4);
  }

  // 像素分析精确裁剪底部空白
  const finalH = trimBottom(PNG.sync.write(tmp), PAD_BOTTOM);
  const dst = new PNG({ width: tmp.width, height: Math.max(50, finalH) });
  tmp.data.copy(dst.data, 0, 0, dst.height * tmp.width * 4);
  fs.writeFileSync(out, PNG.sync.write(dst));

  await page.setViewportSize(origVp);
  return out;
}

// ============================================================
// 主流程
// ============================================================
async function screenshotDoc(page, projectName, docName) {
  const projectDir = path.join(CONFIG.outputBase, projectName);
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

  console.log('  [1/6] 打开文档...'); await clickDoc(page, projectName, docName);
  console.log('  [2/6] 等待加载...'); await waitForDocStable(page);
  console.log('  [3/6] 验证...'); if (!await verifyDocOpened(page, docName)) { console.log('  无法打开文档'); return null; }
  console.log('  [4/6] 检测类型...'); if (await skipIfAttachment(page)) return null;

  const f = getFrame(page);
  const isAffine = (await f.locator('.editor.doc-editor-control').count()) > 0;
  const isOld = (await f.locator('.doc-editor, .doc-view').count()) > 0;

  let contentHeight = 0;
  if (isAffine) { console.log('  [5/6] Affine 编辑器渲染...'); contentHeight = await renderAffine(page); }
  else if (isOld) { console.log('  [5/6] 旧版编辑器展开...'); contentHeight = await expandOldEditor(page); }
  else { console.log('  [5/6] 通用截图...'); }

  console.log('  [6/6] 截图 + 裁切...');
  return await captureAndCrop(page, contentHeight, projectDir, docName, isAffine);
}

// ============================================================
// 入口
// ============================================================
(async () => {
  const args = process.argv.slice(2);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--disable-extensions', '--disable-background-networking'],
  });
  const ctx = await browser.newContext({
    viewport: CONFIG.viewport,
    storageState: fs.existsSync(CONFIG.stateFile) ? JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf-8')) : undefined,
  });
  const page = await ctx.newPage();

  console.log('登录...'); await ensureLogin(page);

  let projectName = args[0], docName = args[1];

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

  if (!docName) {
    console.log('获取文档列表...');
    const docs = await getDocsForProject(page, projectName);
    if (docs.length === 0) { console.log('未找到文档'); await browser.close(); process.exit(1); }
    console.log('\n========== ' + projectName + ' (' + docs.length + '个文档) ==========');
    docs.forEach((d, i) => console.log('  [' + (i + 1) + '] ' + d));
    console.log('========================================');
    const ans = await ask('\n选择序号(多选逗号分隔)或输入文档名: ');
    const parts = ans.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      for (const p of parts) {
        const n = parseInt(p); docName = (!isNaN(n) && n >= 1 && n <= docs.length) ? docs[n - 1] : p;
        console.log('\n→ 截图: ' + docName + '...');
        const o = await screenshotDoc(page, projectName, docName);
        if (o) console.log('  完成: ' + o);
      }
      await browser.close(); return;
    } else {
      const n = parseInt(ans); docName = (!isNaN(n) && n >= 1 && n <= docs.length) ? docs[n - 1] : ans;
    }
  }

  console.log('→ 截图: ' + docName + '...');
  const o = await screenshotDoc(page, projectName, docName);
  if (o) console.log('完成: ' + o);
  await browser.close();
})().catch(e => { console.error('致命错误:', e.message); process.exit(1); });
