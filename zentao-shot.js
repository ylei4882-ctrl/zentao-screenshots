const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { PNG } = require('pngjs');

// ===== 读取配置文件 =====
const SCRIPT_DIR = __dirname;
const configPath = path.join(SCRIPT_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('错误: 找不到 config.json，请在 ' + SCRIPT_DIR + ' 下创建配置文件。');
  console.error('格式: { "baseUrl": "...", "username": "...", "password": "...", "outputPath": "..." }');
  process.exit(1);
}
const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const CONFIG = {
  baseUrl: userConfig.baseUrl || 'http://192.168.10.227:90/zentao',
  username: userConfig.username || '',
  password: userConfig.password || '',
  stateFile: path.join(SCRIPT_DIR, '.zentao-session.json'),
  outputBase: userConfig.outputPath || SCRIPT_DIR,
  viewport: userConfig.viewport || { width: 1920, height: 3600 },
};

// 用像素分析找到内容的实际底部（从下往上找第一个非白像素行）
function findContentBottom(pngBuffer) {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const WHITE_THRESHOLD = 250;
  const SAMPLE_STEP = 4;

  for (let y = height - 1; y >= 0; y--) {
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const idx = rowStart + x * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      if (a > 0 && (r < WHITE_THRESHOLD || g < WHITE_THRESHOLD || b < WHITE_THRESHOLD)) {
        return y + 1 + 10;
      }
    }
  }
  return height;
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans.trim()); }));
}

async function ensureLogin(page) {
  await page.goto(CONFIG.baseUrl + '/my.html', { waitUntil: 'domcontentloaded', timeout: 10000 });

  if (page.url().includes('user-login')) {
    await page.locator('input[name="account"]').fill(CONFIG.username);
    await page.locator('input[name="password"]').fill(CONFIG.password);
    await page.locator('#submit, button[type="submit"], input[type="submit"], .btn-primary').first().click();
    await page.waitForURL(/\/my/, { timeout: 10000 });
    const st = await page.context().storageState();
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(st));
  }
}

async function getProjects(page) {
  await page.goto(CONFIG.baseUrl + '/doc-projectSpace.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(800);

  let frame = page.frame({ name: 'app-doc' }) || page;

  let projects = await frame.evaluate(() => {
    const exclude = new Set([
      '文档','仪表盘','快捷访问','我的空间','团队空间','产品空间','项目空间',
      '浩东','我参与的','其他','仅显示有文档的项目','显示已关闭的项目',
      '', '共 1 项','每页 5 项','1/1','暂无数据'
    ]);
    const seen = new Set();
    const results = [];
    for (const el of document.querySelectorAll('div')) {
      const text = el.textContent?.trim();
      if (text && text.length >= 2 && text.length <= 20
          && !text.includes('\n') && !text.includes('共')
          && !exclude.has(text) && !text.match(/^\d/)
          && !seen.has(text)) {
        seen.add(text);
        results.push(text);
      }
    }
    return results;
  });

  // 如果取到 0 个项目，点击"项目空间"标签页后重试
  if (projects.length === 0) {
    await frame.locator('text="项目空间"').first().click();
    await page.waitForTimeout(600);
    frame = page.frame({ name: 'app-doc' }) || page;
    projects = await frame.evaluate(() => {
      const exclude = new Set([
        '文档','仪表盘','快捷访问','我的空间','团队空间','产品空间','项目空间',
        '浩东','我参与的','其他','仅显示有文档的项目','显示已关闭的项目',
        '', '共 1 项','每页 5 项','1/1','暂无数据'
      ]);
      const seen = new Set();
      const results = [];
      for (const el of document.querySelectorAll('div')) {
        const text = el.textContent?.trim();
        if (text && text.length >= 2 && text.length <= 20
            && !text.includes('\n') && !text.includes('共')
            && !exclude.has(text) && !text.match(/^\d/)
            && !seen.has(text)) {
          seen.add(text);
          results.push(text);
        }
      }
      return results;
    });
  }
  return projects;
}

async function getDocsForProject(page, projectName) {
  // 如果当前不在项目空间页面则导航过去
  if (!page.url().includes('doc-projectSpace')) {
    await page.goto(CONFIG.baseUrl + '/doc-projectSpace.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(800);
    let t0 = page.frame({ name: 'app-doc' }) || page;
    // 无数据时点击"项目空间"标签页
    const bodyText = await t0.evaluate(() => document.body?.innerText || '');
    if (bodyText.includes('暂无数据') && bodyText.includes('共 0 项')) {
      await t0.locator('text="项目空间"').first().click();
      await page.waitForTimeout(600);
    }
  }

  const t = page.frame({ name: 'app-doc' }) || page;
  await t.locator('text=' + projectName).first().click();
  await page.waitForTimeout(800);

  const frame = page.frame({ name: 'app-doc' }) || page;
  const docs = await frame.evaluate((excludeProjectName) => {
    const exclude = new Set([
      '文档','仪表盘','快捷访问','我的空间','团队空间','产品空间','项目空间',
      'ID','文档标题','收藏','浏览次数','由谁添加','创建日期','修改者','修改日期','操作',
      '全部','草稿','我收藏的','我创建的','我编辑的','导入','创建',
      '项目主库','附件库','项目','执行', excludeProjectName
    ]);
    const seen = new Set();
    const results = [];
    for (const el of document.querySelectorAll('a')) {
      const text = el.textContent?.trim();
      if (text && text.length > 2 && text.length < 80 && !seen.has(text) && !exclude.has(text)
          && !text.includes('共 ') && !text.includes('每页') && !text.match(/^\d+$/)
          && !text.includes('阶段主库') && !text.includes('库：') && !text.includes('全部')) {
        seen.add(text);
        results.push(text);
      }
    }
    return results;
  }, projectName);
  return docs;
}

async function screenshotDoc(page, projectName, docName) {
  const projectDir = path.join(CONFIG.outputBase, projectName);
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

  const frame = page.frame({ name: 'app-doc' }) || page;

  // 点击文档行（Zentao 用 .cursor-pointer 父级 div 的事件委托，不能直接用 <a>）
  let docClicked = false;
  try {
    await frame.locator('.cursor-pointer:has([title="' + docName + '"])').first().click({ timeout: 3000 });
    docClicked = true;
  } catch {
    try {
      await frame.locator('a:has-text("' + docName + '")').first().click({ timeout: 2000 });
      docClicked = true;
    } catch {}
  }

  // 回退：完整导航
  if (!docClicked) {
    await page.goto(CONFIG.baseUrl + '/doc-projectSpace.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(800);
    let t = page.frame({ name: 'app-doc' }) || page;
    // 无数据时点击"项目空间"标签页
    const bodyText = await t.evaluate(() => document.body?.innerText || '');
    if (bodyText.includes('暂无数据') && bodyText.includes('共 0 项')) {
      await t.locator('text="项目空间"').first().click();
      await page.waitForTimeout(600);
      t = page.frame({ name: 'app-doc' }) || page;
    }
    await t.locator('text=' + projectName).first().click();
    await page.waitForTimeout(600);
    const tf = page.frame({ name: 'app-doc' }) || page;
    try {
      await tf.locator('.cursor-pointer:has([title="' + docName + '"])').first().click({ timeout: 5000 });
    } catch {
      await tf.locator('a:has-text("' + docName + '")').first().click();
    }
  }

  const cf = page.frame({ name: 'app-doc' }) || page;
  await cf.locator('#main').waitFor({ state: 'visible', timeout: 10000 });

  // 等待编辑器加载并等待内容稳定（innerText 连续 2 秒不变）
  try {
    await cf.locator('.editor.doc-editor-control, .doc-editor').first().waitFor({ state: 'attached', timeout: 15000 });
    // 轮询等 innerText 稳定
    let prevLen = -1, stable = 0;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(1000);
      const len = await cf.evaluate(() => {
        const ed = document.querySelector('.editor.doc-editor-control');
        return ed ? ed.innerText?.length || 0 : 0;
      });
      if (len === prevLen && len > 0) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      prevLen = len;
    }
  } catch {}

  // 验证是否真正打开了文档。列表页正文包含 "文档标题"+"由谁添加" 等表头文字
  const bodyText = await cf.evaluate(() => document.body?.innerText || '');
  const isDocListPage = bodyText.includes('文档标题') && bodyText.includes('由谁添加');
  if (isDocListPage) {
    // 点击未生效，重试：点击 .cursor-pointer 父级 div
    const retryFrame = page.frame({ name: 'app-doc' }) || page;
    try {
      await retryFrame.locator('.cursor-pointer:has([title="' + docName + '"])').first().click({ timeout: 5000 });
      await retryFrame.locator('#main').waitFor({ state: 'visible', timeout: 10000 });
      try {
        await retryFrame.locator('.editor.doc-editor-control, .doc-editor').first().waitFor({ state: 'attached', timeout: 10000 });
        await page.waitForTimeout(500);
      } catch {}
    } catch {}
    // 再次检查
    const retryText = await retryFrame.evaluate(() => document.body?.innerText || '');
    if (retryText.includes('文档标题') && retryText.includes('由谁添加')) {
      try {
        await retryFrame.locator('a:has-text("' + docName + '")').first().click({ timeout: 5000 });
        await page.waitForTimeout(1000);
      } catch {}
    }
  }

  // 检测是否为仅附件文档（无内联正文）
  const hasAffineEditor = await cf.locator('.editor.doc-editor-control').count() > 0;
  const hasOldEditor = await cf.locator('.doc-editor').count() > 0;

  // Affine 编辑器：检查 innerText 长度（排除占位文本）
  if (hasAffineEditor) {
    const len = await cf.evaluate(() => {
      const ed = document.querySelector('.editor.doc-editor-control');
      return ed ? ed.innerText?.length || 0 : 0;
    });
    if (len <= 60) { console.log('  跳过: 仅附件，无内联正文'); return null; }
  }
  // 旧版编辑器（无 Affine）：检测是否有附件但无内联正文
  if (!hasAffineEditor && hasOldEditor) {
    const hasFiles = await cf.locator('.file, .files, [class*="file-list"], [class*="attachment"], [class*="doc-files"]').count() > 0;
    if (hasFiles) {
      // 检查是否有实质正文（超过元数据长度 ~120 字）
      const docText = await cf.evaluate(() => {
        const ed = document.querySelector('.doc-editor');
        return ed ? ed.innerText?.trim() || '' : '';
      });
      if (docText.length < 150) { console.log('  跳过: 仅附件，无内联正文'); return null; }
    }
  }

  // 处理编辑器：先缩 viewport 逐块滚动触发懒渲染，再展开 overflow 截全图
  const isAffine = await cf.locator('.editor.doc-editor-control').count() > 0;
  if (isAffine) {
    const origViewport = page.viewportSize();
    // 先缩到 400px 强制产生可滚动区域，逐块滚动触发 Affine 渲染
    await page.setViewportSize({ width: origViewport.width, height: 400 });
    await page.waitForTimeout(500);

    await cf.evaluate(async () => {
      const container = document.querySelector('.doc-view-content, .doc-main, .scrollbar-hover');
      if (!container) return;
      // 等待 scrollHeight 增长
      await new Promise(r => setTimeout(r, 500));
      const totalH = container.scrollHeight;
      const step = Math.max(container.clientHeight, 300);
      for (let y = 0; y < totalH; y += step) {
        container.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 300));
      }
      container.scrollTo(0, 0);
    });
    await page.waitForTimeout(500);

    // 恢复大 viewport + 展开 overflow
    await page.setViewportSize(origViewport);
    await page.waitForTimeout(300);

    await cf.evaluate(() => {
      const els = document.querySelectorAll('.doc-view-content, .doc-main, .scrollbar-hover, .doc-app-body, #mainContent, #main, .doc-editor, .doc-view, .detail-body, .detail-main, .detail-sections, .editor.doc-editor-control');
      for (const el of els) {
        el.style.setProperty('overflow', 'visible', 'important');
        el.style.setProperty('overflow-y', 'visible', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('height', 'auto', 'important');
      }
    });
    await page.waitForTimeout(300);
  } else {
    const hasOldEditor = await cf.locator('.doc-editor, .doc-view').count() > 0;
    if (hasOldEditor) {
      await cf.evaluate(() => {
        const els = document.querySelectorAll('.doc-editor, .doc-view, .detail-body, .detail-main, .detail-sections, #mainContent');
        for (const el of els) {
          el.style.setProperty('overflow', 'visible', 'important');
          el.style.setProperty('overflow-y', 'visible', 'important');
          el.style.setProperty('max-height', 'none', 'important');
          el.style.setProperty('height', 'auto', 'important');
        }
      });
      await page.waitForTimeout(300);
    }
  }

  const safeName = docName.replace(/[\/:*?"<>|]/g, '_').substring(0, 50);
  const output = path.join(projectDir, safeName + '.png');
  const PAD_X = 20;
  const PAD_BOTTOM = 20;

  const editorSelectors = ['.editor.doc-editor-control', '.doc-editor', '.article-content', '.markdown-body'];
  let editorBox = null;
  for (const sel of editorSelectors) {
    const el = cf.locator(sel).first();
    if (await el.count() > 0) {
      const box = await el.boundingBox();
      if (box && box.height > 50) { editorBox = box; break; }
    }
  }
  if (!editorBox) {
    const mb = await cf.locator('#mainContent').first().boundingBox();
    if (mb) editorBox = { x: mb.x + 20, y: mb.y, width: mb.width - 40, height: mb.height };
  }

  if (editorBox) {
    const clipX = Math.max(0, editorBox.x - PAD_X);
    const clipY = Math.max(0, editorBox.y);
    const clipW = Math.min(editorBox.width + PAD_X * 2, 1920);
    const clipH = editorBox.height;

    const rawBuffer = await page.screenshot({ clip: { x: clipX, y: clipY, width: clipW, height: clipH } });
    const pixelBottom = findContentBottom(rawBuffer);
    const contentHeight = Math.min(pixelBottom + PAD_BOTTOM, clipH);
    const src = PNG.sync.read(rawBuffer);
    const dst = new PNG({ width: src.width, height: Math.max(50, contentHeight) });
    src.data.copy(dst.data, 0, 0, dst.height * src.width * 4);
    fs.writeFileSync(output, PNG.sync.write(dst));
  } else {
    const mainBox = await cf.locator('#mainContent').first().boundingBox();
    if (mainBox) {
      await page.screenshot({
        path: output,
        clip: { x: mainBox.x + 20, y: mainBox.y + 10, width: mainBox.width - 40, height: mainBox.height - 10 }
      });
    } else {
      await page.screenshot({ path: output, fullPage: true });
    }
  }
  return output;
}

(async () => {
  const args = process.argv.slice(2);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox', '--disable-extensions', '--disable-background-networking'],
  });
  const context = await browser.newContext({
    viewport: CONFIG.viewport,
    storageState: fs.existsSync(CONFIG.stateFile) ? JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf-8')) : undefined,
  });
  const page = await context.newPage();

  console.log('登录...');
  await ensureLogin(page);

  let projectName = args[0];
  let docName = args[1];

  // === 交互选项目 ===
  if (!projectName) {
    console.log('获取项目列表...');
    const projects = await getProjects(page);
    console.log('\n========== 可选项目 ==========');
    projects.forEach((p, i) => console.log(`  [${i + 1}] ${p}`));
    console.log('===============================');
    const ans = await ask('\n选择序号或输入项目名: ');
    const num = parseInt(ans);
    projectName = (!isNaN(num) && num >= 1 && num <= projects.length) ? projects[num - 1] : ans;
  }
  console.log('→ 项目: ' + projectName);

  // === 交互选文档 ===
  if (!docName) {
    console.log('获取文档列表...');
    const docs = await getDocsForProject(page, projectName);
    if (docs.length === 0) {
      console.log('未找到文档。请检查项目名。');
      await browser.close();
      process.exit(1);
    }
    console.log(`\n========== ${projectName} (${docs.length}个文档) ==========`);
    docs.forEach((d, i) => console.log(`  [${i + 1}] ${d}`));
    console.log('========================================');
    const ans = await ask('\n选择序号(多个用逗号分隔)或输入文档名: ');

    const parts = ans.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      for (const sel of parts) {
        const num = parseInt(sel);
        docName = (!isNaN(num) && num >= 1 && num <= docs.length) ? docs[num - 1] : sel;
        console.log('\n→ 截图: ' + docName + '...');
        const out = await screenshotDoc(page, projectName, docName);
        if (out) console.log('  完成: ' + out);
      }
      await browser.close();
      return;
    } else {
      const num = parseInt(ans);
      docName = (!isNaN(num) && num >= 1 && num <= docs.length) ? docs[num - 1] : ans;
    }
  }

  console.log('→ 截图: ' + docName + '...');
  const out = await screenshotDoc(page, projectName, docName);
  if (out) console.log('完成: ' + out);
  await browser.close();
})();
