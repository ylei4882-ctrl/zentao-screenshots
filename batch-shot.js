const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const SCRIPT_DIR = __dirname;
const cfg = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, 'config.json'), 'utf-8'));
const CONFIG = {
  baseUrl: cfg.baseUrl,
  username: cfg.username,
  password: cfg.password,
  stateFile: path.join(SCRIPT_DIR, '.zentao-session.json'),
  outputBase: cfg.outputPath || SCRIPT_DIR,
  viewport: cfg.viewport || { width: 1920, height: 3600 },
};

const PROJECT = process.argv[2];
const DOCS = process.argv.slice(3);

function findContentBottom(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const WHITE_THRESHOLD = 250;
  const SAMPLE_STEP = 4;
  for (let y = height - 1; y >= 0; y--) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const idx = rowStart + x * 4;
      const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
      if (a > 0 && (r < WHITE_THRESHOLD || g < WHITE_THRESHOLD || b < WHITE_THRESHOLD)) return y + 1 + 10;
    }
  }
  return height;
}

async function ensureLogin(page) {
  await page.goto(CONFIG.baseUrl + '/my.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  if (page.url().includes('user-login')) {
    await page.locator('input[name="account"]').fill(CONFIG.username);
    await page.locator('input[name="password"]').fill(CONFIG.password);
    await page.locator('#submit').click();
    await page.waitForURL(/\/my/, { timeout: 15000 });
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(await page.context().storageState()));
  }
}

async function gotoProject(page, projectName) {
  await page.goto(CONFIG.baseUrl + '/doc-projectSpace.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1500);
  let t0 = page.frame({ name: 'app-doc' }) || page;
  const bodyText = await t0.evaluate(() => document.body?.innerText || '');
  if (bodyText.includes('暂无数据') && bodyText.includes('共 0 项')) {
    try { await t0.locator('text="项目空间"').first().click(); } catch {}
    await page.waitForTimeout(800);
  }
  const t = page.frame({ name: 'app-doc' }) || page;
  await t.locator('text=' + projectName).first().click();
  await page.waitForTimeout(1500);
}

async function getDocIdByName(page, docName) {
  const f = page.frame({ name: 'app-doc' }) || page;
  return await f.evaluate((name) => {
    const els = document.querySelectorAll('.cursor-pointer');
    for (const el of els) {
      const titled = el.querySelector('[title="' + name + '"]');
      if (titled) {
        const idCell = el.querySelector('[class*="text-gray"], td:first-child, .col-id');
        const idText = idCell ? idCell.textContent.trim() : '';
        const m = idText.match(/(\d+)/);
        if (m) return m[1];
        const attrId = el.getAttribute('data-id') || el.getAttribute('data-doc-id');
        if (attrId) return attrId;
      }
    }
    return null;
  }, docName);
}

async function screenshotDoc(page, projectName, docName) {
  const projectDir = path.join(CONFIG.outputBase, projectName);
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

  // 通过点击进入文档（导航到 doc-view-{id}.html）
  const f = page.frame({ name: 'app-doc' }) || page;
  try {
    await f.locator('.cursor-pointer:has([title="' + docName + '"])').first().click({ timeout: 3000 });
  } catch {
    await f.locator('a:has-text("' + docName + '")').first().click({ timeout: 5000 });
  }

  // 等待导航到 doc-view 页或文档内容加载
  await page.waitForTimeout(2000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}

  // 等编辑器加载完：用 .editor.doc-editor-control 的 height 判断
  let attempts = 0;
  let prevH = -1, stable = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    attempts++;
    // 在所有 frame 中找编辑器，取最大的那个（真正的内容）
    let maxH = 0, maxText = 0, maxImgs = 0, stillLoading = false;
    for (const fr of page.frames()) {
      try {
        const v = await fr.evaluate(() => {
          const isLoading = (document.body?.innerText || '').includes('正在加载编辑器');
          const ed = document.querySelector('.editor.doc-editor-control');
          if (!ed) return { h: 0, t: 0, imgs: 0, loading: isLoading };
          const r = ed.getBoundingClientRect();
          return {
            h: Math.round(r.height),
            t: (ed.innerText || '').length,
            imgs: ed.querySelectorAll('img').length,
            loading: isLoading,
          };
        });
        if (v.h > maxH) { maxH = v.h; maxText = v.t; maxImgs = v.imgs; }
        if (v.loading) stillLoading = true;
      } catch {}
    }
    console.log('    wait t=' + attempts + 's h=' + maxH + ' text=' + maxText + ' imgs=' + maxImgs + ' loading=' + stillLoading + ' stable=' + stable);
    if (!stillLoading && maxH > 100 && maxH === prevH) {
      stable++;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
    prevH = maxH;
  }

  // 找包含编辑器的 frame
  let contentFrame = null, editorBox = null;
  for (const fr of page.frames()) {
    try {
      const has = await fr.evaluate(() => !!document.querySelector('.editor.doc-editor-control'));
      if (has) {
        const box = await fr.locator('.editor.doc-editor-control').first().boundingBox();
        if (box && box.height > 100) {
          if (!editorBox || box.height > editorBox.height) { editorBox = box; contentFrame = fr; }
        }
      }
    } catch {}
  }

  if (!editorBox) {
    console.log('  跳过: 未找到内容编辑器');
    return null;
  }

  // 检查是否为纯附件（无文字也无图片）
  const meta = await contentFrame.evaluate(() => {
    const ed = document.querySelector('.editor.doc-editor-control');
    return { t: (ed.innerText || '').length, imgs: ed.querySelectorAll('img').length };
  });
  if (meta.t <= 10 && meta.imgs === 0) {
    console.log('  跳过: 仅附件，无内联正文或图片');
    return null;
  }

  // 展开 overflow 让内容完整显示
  await contentFrame.evaluate(() => {
    const els = document.querySelectorAll('.doc-view-content, .doc-main, .scrollbar-hover, .doc-app-body, #mainContent, #main, .doc-editor, .doc-view, .detail-body, .detail-main, .detail-sections, .editor.doc-editor-control');
    for (const el of els) {
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', 'auto', 'important');
    }
  });
  await page.waitForTimeout(500);

  // 重新取边界框
  const finalBox = await contentFrame.locator('.editor.doc-editor-control').first().boundingBox();
  const box = finalBox || editorBox;

  const safe = docName.replace(/[\/:*?"<>|]/g, '_').substring(0, 50);
  const out = path.join(projectDir, safe + '.png');
  const PAD_X = 20, PAD_BOTTOM = 20;
  const clipX = Math.max(0, box.x - PAD_X);
  const clipY = Math.max(0, box.y);
  const clipW = Math.min(box.width + PAD_X * 2, 1920);
  const clipH = box.height;
  const raw = await page.screenshot({ clip: { x: clipX, y: clipY, width: clipW, height: clipH } });
  const bottom = findContentBottom(raw);
  const ch = Math.min(bottom + PAD_BOTTOM, clipH);
  const src = PNG.sync.read(raw);
  const dst = new PNG({ width: src.width, height: Math.max(50, ch) });
  src.data.copy(dst.data, 0, 0, dst.height * src.width * 4);
  fs.writeFileSync(out, PNG.sync.write(dst));
  return out;
}

(async () => {
  const chromePath = path.join(process.env.USERPROFILE, 'AppData', 'Local', 'ms-playwright', 'chromium-1223', 'chrome-win64', 'chrome.exe');
  const browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport: CONFIG.viewport,
    storageState: fs.existsSync(CONFIG.stateFile) ? JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf-8')) : undefined,
  });
  const page = await ctx.newPage();

  console.log('登录...');
  await ensureLogin(page);
  console.log('进入项目:', PROJECT);
  await gotoProject(page, PROJECT);

  for (const doc of DOCS) {
    console.log('\n截图:', doc);
    try {
      const out = await screenshotDoc(page, PROJECT, doc);
      if (out) console.log('  完成 ->', out);
    } catch (e) {
      console.log('  失败:', e.message);
    }
  }
  await browser.close();
})().catch(e => { console.error('错误:', e.message); process.exit(1); });
