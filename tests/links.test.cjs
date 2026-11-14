const {test} = require('node:test');
const assert = require('node:assert/strict');
const {openAdLink} = require('../static/engine.js');

const url = 'https://market.project-neko.cn/#/plugin/test-plugin';
function harness(options = {}) {
  const calls = [], errors = [];
  const event = {type: 'click', button: 0, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }};
  let paused = 0;
  const args = {url, electron: true, shell: {openExternal: async target => { calls.push(target); return {success: true}; }},
    onOpening: () => { paused++; }, onError: text => errors.push(text), ...options};
  return {event, args, calls, errors, paused: () => paused};
}

test('Electron ad click uses the system-browser bridge and cancels the frameless child', async () => {
  const h = harness();
  assert.equal(await openAdLink(h.event, h.args), true);
  assert.equal(h.event.defaultPrevented, true);
  assert.deepEqual(h.calls, [url]);
  assert.equal(h.paused(), 1);
  assert.deepEqual(h.errors, []);
});

test('middle-click and modified click also bypass Electron child windows', async () => {
  for (const props of [{type: 'auxclick', button: 1}, {ctrlKey: true}, {shiftKey: true}]) {
    const h = harness(); Object.assign(h.event, props);
    await openAdLink(h.event, h.args);
    assert.equal(h.event.defaultPrevented, true);
    assert.deepEqual(h.calls, [url]);
  }
});

test('rejected or unsuccessful native opening remains cancelled without a popup fallback', async () => {
  for (const openExternal of [async () => { throw new Error('Unavailable'); }, async () => ({success: false}), async () => false]) {
    const h = harness({shell: {openExternal}});
    assert.equal(await openAdLink(h.event, h.args), false);
    assert.equal(h.event.defaultPrevented, true);
    assert.equal(h.errors.length, 1);
  }
});

test('an Electron host without its browser bridge does not open an unclosable child', async () => {
  const h = harness({shell: null});
  assert.equal(await openAdLink(h.event, h.args), false);
  assert.equal(h.event.defaultPrevented, true);
  assert.equal(h.paused(), 0);
  assert.equal(h.errors.length, 1);
});

test('a normal browser keeps its native new-tab navigation', async () => {
  const h = harness({shell: null, electron: false});
  assert.equal(await openAdLink(h.event, h.args), true);
  assert.equal(h.event.defaultPrevented, false);
  assert.equal(h.paused(), 1);
});

test('invalid protocols and embedded credentials cannot reach the system opener', async () => {
  for (const target of ['javascript:alert(1)', 'file:///C:/test', 'https://user:password@example.com/']) {
    const h = harness({url: target});
    assert.equal(await openAdLink(h.event, h.args), false);
    assert.equal(h.event.defaultPrevented, true);
    assert.deepEqual(h.calls, []);
    assert.equal(h.errors.length, 1);
  }
});

test('ads only open project destinations or catalog routes at the configured market', async () => {
  for (const [target, market, allowed] of [
    ['https://project-neko.online/zh-CN/', undefined, true],
    ['https://github.com/Project-N-E-K-O/N.E.K.O#readme', undefined, true],
    ['https://store.steampowered.com/app/4099310/__NEKO/', undefined, true],
    ['https://github.com/someone/else', undefined, false],
    ['https://project-neko.online.example.com/', undefined, false],
    ['https://market.project-neko.cn/login#/plugins', undefined, false],
    ['http://localhost:5173/dev/#/plugin/test', 'http://localhost:5173/dev', true],
    ['https://custom.example.com/catalog/#/plugins', 'https://custom.example.com/catalog', true],
    ['https://alt.example.com/catalog/#/plugins', 'https://custom.example.com/catalog', false],
    ['http://custom.example.com/#/plugins', 'http://custom.example.com/', false],
  ]) {
    const h = harness({url:target, market});
    assert.equal(await openAdLink(h.event, h.args), allowed, target);
    assert.equal(h.calls.length, Number(allowed), target);
  }
});
