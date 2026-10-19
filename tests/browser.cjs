/* Local fake host + real Chromium. No production service or external network. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const projectRequire = createRequire(path.resolve(__dirname, '../../../../frontend/plugin-manager/package.json'));
const {chromium} = projectRequire('@playwright/test');
const root = path.resolve(__dirname, '../static');
const output = path.resolve(__dirname, '../../../../tmp/neko-ads-qa');
fs.mkdirSync(output, {recursive: true});
let active = null, alive = true, delayStart = 0;
const retired = new Set();
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.endsWith('/context')) return res.end(JSON.stringify({state: {ready: alive, epoch: 'test-epoch'}}));
  if (url.pathname === '/market/status') return res.end(JSON.stringify({market_web_url: 'https://market.example.test'}));
  if (url.pathname.startsWith('/market/catalog/')) return res.end(JSON.stringify({items: [{id: 'qa-real', name: '测试提醒插件', short_description: '按设定时间提醒。'}]}));
  if (url.pathname.includes('/action/')) {
    let body = ''; for await (const chunk of req) body += chunk;
    const {args} = JSON.parse(body);
    const name = url.pathname.split('/').pop();
    if (name === 'start_game') {
      if (delayStart) await new Promise(resolve => setTimeout(resolve, delayStart));
      if (!retired.has(args.round_id)) active = args.round_id;
    }
    if (name === 'stop_game') { retired.add(args.round_id); if (active === args.round_id) active = null; }
    return res.end(JSON.stringify({result: {success: true, data: {active: alive && active === args.round_id, round_id: args.round_id}}}));
  }
  const file = url.pathname.split('/').pop() || 'index.html';
  if (!['index.html', 'main.js', 'engine.js', 'style.css'].includes(file)) { res.writeHead(404); return res.end('{}'); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(path.join(root, file)));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, channel: process.env.NEKO_ADS_BROWSER || 'msedge'});
    const page = await browser.newPage({viewport: {width: 1280, height: 900}});
    page.setDefaultTimeout(8000);
    page.on('console', msg => { if (msg.type() === 'warning') console.log('Browser:', msg.text()); });
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.error('Page error:', e.message); });
    await page.addInitScript(() => {
      window.__voiceCancels = 0;
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      Object.defineProperty(window, 'speechSynthesis', {value: {
        getVoices: () => [{lang: 'ja-JP', name: 'test'}],
        addEventListener() {}, cancel() { window.__voiceCancels++; }, speak() {},
      }});
    });
    const base = `http://127.0.0.1:${server.address().port}/plugin/neko_ads/ui/`;
    const start = async () => {
      await page.locator('#start').click();
      await page.locator('#playfield').waitFor({state: 'visible'});
      await page.waitForTimeout(250);
    };
    await page.goto(base);
    await page.getByText('广告部已就绪，等待主人开局。', {exact: true}).waitFor();
    await page.screenshot({path: path.join(output, '01-lobby.png'), fullPage: true});
    await start();
    assert.equal(await page.locator('.ad').count(), 1);
    await page.screenshot({path: path.join(output, '02-game.png')});
    await page.locator('.ad-close').click();
    assert.match(await page.locator('.ad h2').innerText(), /广告的广告/);
    assert.match(await page.locator('#speech').innerText(), /广告的广告/);
    await page.locator('.ad-close').click();
    assert.equal(await page.locator('.ad').count(), 0);
    await page.waitForTimeout(10500);
    assert.ok(await page.locator('.ad').count() >= 1);
    assert.ok(await page.locator('.ad').count() <= 3);
    const cancels = await page.evaluate(() => window.__voiceCancels);
    await page.locator('#chat-input').fill('广告下班');
    await page.locator('#result').waitFor({state: 'visible'});
    assert.equal(await page.locator('.ad').count(), 0);
    assert.ok(await page.evaluate(() => window.__voiceCancels) > cancels);
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('.ad').count(), 0);
    await page.locator('#back').click(); await start();
    await page.locator('.ad-close').focus();
    await page.keyboard.press('Control+Shift+Q');
    await page.locator('#result').waitFor({state: 'visible'});
    await page.locator('#back').click(); await start();
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable: true, value: true});
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.hidden;
    });
    await page.locator('#result').waitFor({state: 'visible'});
    assert.equal(await page.locator('.ad').count(), 0);
    await page.locator('#back').click(); await start();
    alive = false;
    await page.getByText('与插件的连接已断开，本局已自动结束。所有广告与语音均已停止。', {exact: true}).waitFor();
    assert.equal(await page.locator('.ad').count(), 0);
    alive = true;
    await page.reload();
    assert.equal(await page.locator('.ad').count(), 0);
    assert.equal(await page.locator('#playfield').isVisible(), false);
    await page.setViewportSize({width: 390, height: 844});
    await page.getByText('广告部已就绪，等待主人开局。', {exact: true}).waitFor();
    await page.screenshot({path: path.join(output, '03-mobile-lobby.png'), fullPage: true});
    await start();
    await page.screenshot({path: path.join(output, '04-mobile-game.png')});
    const overlap = await page.evaluate(() => {
      const a = document.querySelector('.ad').getBoundingClientRect();
      const c = document.querySelector('#chat').getBoundingClientRect();
      return a.bottom > c.top;
    });
    assert.equal(overlap, false, 'ads must never cover the safe-word input');
    await page.locator('#chat-input').evaluate(el => {
      el.value = '广告下班'; el.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: '广告下班'}));
    });
    await page.locator('#result').waitFor({state: 'visible'});
    // An exit during a slow start must win even when the start response arrives later.
    delayStart = 500;
    await page.locator('#back').click();
    await page.getByText('广告部已就绪，等待主人开局。', {exact: true}).waitFor();
    await page.locator('#start').click();
    await page.keyboard.press('Control+Shift+Q');
    await page.locator('#result').waitFor({state: 'visible'});
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(await page.locator('.ad').count(), 0);
    assert.equal(active, null);
    assert.deepEqual(errors, []);
    console.log('Browser QA passed: pranks, immediate text feedback, safe word, focused shortcut, IME, voice cancellation, page leave, plugin stop, reload, mobile, delayed-start race.');
    console.log(`Screenshots: ${output}`);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
