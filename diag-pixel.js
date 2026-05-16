const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 3600 } });
  const sf = 'D:/zentao-screenshots/.zentao-session.json';

  await page.goto('http://192.168.10.227:90/zentao/my.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(500);
  if (page.url().includes('user-login')) {
    await page.locator('input[name="account"]').fill('haodongp');
    await page.locator('input[name="password"]').fill('Foohu203204');
    await page.locator('#submit, button[type="submit"], input[type="submit"], .btn-primary').first().click();
    await page.waitForTimeout(2000);
    fs.writeFileSync(sf, JSON.stringify(await page.context().storageState()));
  }

  await page.goto('http://192.168.10.227:90/zentao/doc-projectSpace.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.waitForTimeout(800);
  let t = page.frame({ name: 'app-doc' }) || page;
  await t.locator('text=昕原').first().click();
  await page.waitForTimeout(1000);
  t = page.frame({ name: 'app-doc' }) || page;
  await t.locator('text=20260515 期中同步会议').first().click();

  const cf = page.frame({ name: 'app-doc' }) || page;
  await cf.locator('#main').waitFor({ state: 'visible', timeout: 10000 });
  try { await cf.locator('[data-loading]').waitFor({ state: 'hidden', timeout: 15000 }); } catch {}
  await page.waitForTimeout(1000);

  // Scroll
  await cf.evaluate(async () => {
    const containers = document.querySelectorAll('.doc-view-content, .doc-main, .scrollbar-hover');
    for (const c of containers) {
      const sh = c.scrollHeight, ch = c.clientHeight;
      if (sh > ch) for (let y = 0; y < sh; y += Math.max(ch, 400)) { c.scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); }
      c.scrollTo(0, 0);
    }
  });
  await page.waitForTimeout(300);
  await cf.evaluate(() => {
    document.querySelectorAll('.doc-view-content, .doc-main, .scrollbar-hover, .doc-app-body, #mainContent, #main').forEach(el => {
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('overflow-y', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('height', 'auto', 'important');
    });
  });
  await page.waitForTimeout(300);

  // Find editor box (same logic as main script)
  const editorSelectors = ['.editor.doc-editor-control', '.doc-editor', '.article-content', '.markdown-body'];
  let editorBox = null;
  let usedSelector = '';
  for (const sel of editorSelectors) {
    const el = cf.locator(sel).first();
    if (await el.count() > 0) {
      const box = await el.boundingBox();
      if (box && box.height > 50) { editorBox = box; usedSelector = sel; break; }
    }
  }
  console.log('Using selector:', usedSelector);
  console.log('Editor box:', JSON.stringify(editorBox));

  const PAD_X = 20;
  const clipX = Math.max(0, editorBox.x - PAD_X);
  const clipY = Math.max(0, editorBox.y);
  const clipW = Math.min(editorBox.width + PAD_X * 2, 1920);
  const clipH = editorBox.height;

  // Take the screenshot
  const rawBuffer = await page.screenshot({ clip: { x: clipX, y: clipY, width: clipW, height: clipH } });
  
  // Save raw for analysis
  fs.writeFileSync('D:/zentao-screenshots/DEBUG-raw.png', rawBuffer);
  
  // Analyze
  const png = PNG.sync.read(rawBuffer);
  console.log('Raw screenshot: ' + png.width + 'x' + png.height);
  
  // Find content bottom
  let pixelBottom = 0;
  for (let y = png.height - 1; y >= 0; y--) {
    const rowStart = y * png.width * 4;
    for (let x = 0; x < png.width; x += 4) {
      const idx = rowStart + x * 4;
      if (png.data[idx + 3] > 0 && (png.data[idx] < 250 || png.data[idx+1] < 250 || png.data[idx+2] < 250)) {
        pixelBottom = y + 1;
        break;
      }
    }
    if (pixelBottom > 0) break;
  }
  console.log('Pixel bottom:', pixelBottom);
  
  // Also check a few rows to see the content distribution
  const sampleYs = [100, 500, 1000, 1500, 2000, 2500, 3000];
  for (const yy of sampleYs) {
    let nonWhite = 0;
    for (let x = 0; x < png.width; x += 4) {
      const idx = (yy * png.width + x) * 4;
      if (png.data[idx + 3] > 0 && (png.data[idx] < 250 || png.data[idx+1] < 250 || png.data[idx+2] < 250)) nonWhite++;
    }
    console.log('  y=' + yy + ': ' + nonWhite + ' non-white pixels');
  }

  await browser.close();
})();
