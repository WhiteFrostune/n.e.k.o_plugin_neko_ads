const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const engine = require('../static/engine.js');
const templates = require('../static/ad-templates.js');

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

// Actual renderer and game code, with only the DOM, clock and HTTP boundary replaced.
// No running host, real voice, native hotkey or external browser is used here.
async function bridge(initial = {}, {engineLoaded = true, avatar = null, focused = true} = {}) {
  let now = 0, nextTimer = 0, nextId = 0, failPolls = false, failAll = false, statusCalls = 0;
  const timers = new Map(), nodes = {}, documentEvents = {}, windowEvents = {}, calls = [], planned = {poll: [], start: [], status: [], stop: [], shortcut: []}, channels = [], stored = new Map(), retired = new Set();
  const setTimer = (fn, ms) => { const id = ++nextTimer; timers.set(id, {fn, at: now + ms}); return id; };
  const clearTimer = id => timers.delete(id);
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  class Element {
    constructor(tag) { this.tagName = tag; this.style = {}; this.dataset = {}; this.children = []; this.offsetWidth = 260; this.offsetHeight = 100; }
    set id(value) { this._id = value; nodes[value] = this; }
    get id() { return this._id; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {} remove() { this.removed = true; } close() {} showModal() {}
    getBoundingClientRect() { return {left: 0, right: 260, top: 0, bottom: 100, width: 260, height: 100}; }
  }
  const document = {
    readyState: 'complete', hidden: false, hasFocus: () => focused,
    currentScript: {src: 'http://test.invalid/plugin/neko_ads/ui/desktop-bridge.js'},
    body: new Element('body'), head: new Element('head'), createElement: tag => new Element(tag),
    getElementById: id => nodes[id],
    querySelectorAll: selector => selector === '.neko-ad-placeholder' ? nodes['neko-ads-layer'].children : [],
    addEventListener: (name, fn) => { documentEvents[name] = fn; },
  };
  const games = [];
  class Game extends engine.Game {
    constructor(options) { super({...options, schedule: setTimer, cancel: clearTimer, now: () => now}); games.push(this); }
  }
  const api = {...engine, Game};
  class Channel { constructor() { channels.push(this); } postMessage() {} }
  const window = {NekoAds: engineLoaded ? api : undefined, NekoAdTemplates: templates, lanlan_config: {lanlan_name: 'Test'}, addEventListener: (name, fn) => { windowEvents[name] = fn; }};
  if (avatar) {
    window.avatarReactionBubble = {getActiveAvatarBubbleAnchor:()=>avatar.anchor};
    window.live2dManager = avatar.manager;
  }
  const state = {ready:true, active:false, epoch:'test-epoch', owner:null, round_id:null, shortcut:'Ctrl+Shift+1', voice_enabled:false, feedback:{}, ...initial};
  const answer = snapshot => ({ok: true, json: async () => ({result: {data: snapshot}})});
  async function fetch(url, options) {
    if (url.includes('/hosted-ui/context?')) {
      if (failAll) throw new Error('Simulated connection failure');
      return {ok:true,json:async()=>({state:{...state,retired_round_ids:[...retired]}})};
    }
    if (url.includes('/plugin/status?')) {
      statusCalls++;
      if (planned.status.length) return planned.status.shift()(state.ready ? 'running' : 'stopped', options.signal);
      if (failAll) throw new Error('Simulated connection failure');
      return {ok:true, json:async () => ({status:{status:state.ready ? 'running' : 'stopped'}})};
    }
    if (!options) return {json: async () => ({items: [], market_web_url: 'https://test.invalid'})};
    const {command, payload} = JSON.parse(options.body).args;
    calls.push({command, payload});
    if (failAll || command === 'poll' && (failPolls || !state.ready)) throw new Error('Simulated connection failure');
    if (command === 'start') Object.assign(state, {active: true, round_id: payload.round_id, owner: payload.owner, shortcut: payload.shortcut});
    if (command === 'stop') {
      retired.add(payload.round_id);
      if (payload.round_id === state.round_id) state.active = false;
    }
    if (command === 'shortcut') state.shortcut = payload.shortcut;
    if (planned[command] && planned[command].length) return planned[command].shift()({...state}, options.signal);
    return answer({...state,retired_round_ids:[...retired], ...(command === 'stop' ? {stopped_round_id:payload.round_id} : {})});
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/desktop-bridge.js'), 'utf8'), {
    window, document, NekoAds: api, location: {pathname: '/'}, URL, AbortController, BroadcastChannel: Channel,
    crypto: {randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`},
    localStorage: {getItem:key=>stored.get(key) || null, setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    performance:{now:()=>now}, innerWidth:1000, innerHeight:800,
    fetch, setTimeout: setTimer, clearTimeout: clearTimer,
  });
  await flush();
  function holdNext(command) {
    let resolve, reject, signal, snapshot, aborted = false;
    planned[command].push((value, requestSignal) => {
      snapshot = value; signal = requestSignal;
      return new Promise((yes, no) => {
        resolve = yes; reject = no;
        signal.addEventListener('abort', () => { aborted = true; no(new Error('Simulated request timeout')); }, {once: true});
      });
    });
    return {release: (value = snapshot) => resolve(command === 'status' ? {ok:true,json:async()=>({status:{status:value}})} : answer(value)), fail: () => reject(new Error('Simulated request failure')), get aborted() { return aborted; }};
  }
  return {
    nodes, state, calls, games, advance, window, document,
    holdNextPoll: () => holdNext('poll'), holdNextStart: () => holdNext('start'), holdNextStatus: () => holdNext('status'), holdNextStop:()=>holdNext('stop'), holdNextShortcut:()=>holdNext('shortcut'),
    engineScript: () => document.head.children.find(node => node.tagName === 'script' && !node.removed && node.onload),
    loadEngine: () => { window.NekoAds = api; document.head.children.find(node => node.tagName === 'script' && !node.removed && node.onload).onload(); },
    failEngine: () => document.head.children.find(node => node.tagName === 'script' && !node.removed && node.onerror).onerror(),
    focus: () => { focused = true; document.hidden = false; windowEvents.focus(); },
    hide: () => { focused = false; document.hidden = true; windowEvents.blur(); documentEvents.visibilitychange(); },
    get statusCalls() { return statusCalls; },
    failPolls: value => { failPolls = value; }, failAll: value => { failAll = value; },
    start: async () => { nodes['neko-ads-voice'].checked = false; await nodes['neko-ads-start'].onclick(); await flush(); },
    stop: () => nodes['neko-ads-stop'].onclick(),
    input: text => documentEvents.input({target: {type: 'text', value: text}}),
    compose: text => documentEvents.compositionend({data: text}),
    windowEvent: (name, ...args) => windowEvents[name](...args),
    broadcast: (id=state.round_id) => channels[0].onmessage({data:{type:'stop',round_id:id}}),
    nativeStop:()=>{retired.add(state.round_id);state.active=false;},
    key: (shortcut, target = {}) => {
      const parts = shortcut.split('+'), key = parts.pop();
      return {target, ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), metaKey: false,
        key, code: /^\d$/.test(key) ? 'Digit' + key : 'Key' + key, preventDefault() {}, stopImmediatePropagation() {}};
    },
    press(event) { documentEvents.keydown(event); },
    get active() { return games.some(game => game.active); },
    get cards() { return nodes['neko-ads-layer'].children.length; },
  };
}

test('regular rounds omit the hammer and retain safety exits', async () => {
  const h = await bridge();
  await h.start();
  assert.equal(h.cards, 1);
  assert.equal(h.nodes['neko-ads-hammer'], undefined);
  h.input('广告下班');
  assert.equal(h.cards, 0);

  await h.start();
  const key = h.nodes['neko-ads-key'];
  await key.onkeydown(h.key('Ctrl+Alt+K', key));
  h.press(h.key('Ctrl+Alt+K'));
  assert.equal(h.cards, 0);
  assert.equal(h.active, false);
});

test('a delayed pre-start inactive reply cannot stop a newly started round', async () => {
  const h = await bridge(), old = h.holdNextPoll();
  await h.advance(3000); await h.start();
  old.release(); await flush();
  assert.equal(h.active, true); assert.equal(h.cards, 1);
  assert.equal(h.calls.some(call => call.command === 'stop'), false);
  await h.advance(6500); assert.equal(h.active, true, 'discarding a reply must not stop subsequent polling');
  h.stop();
});

test('a delayed pre-start failure cannot hide or stop a new round', async () => {
  const h = await bridge(), old = h.holdNextPoll();
  await h.advance(3000); await h.start(); old.fail(); await flush();
  assert.equal(h.active, true); assert.equal(h.nodes['neko-ads-launcher'].hidden, false);
  h.stop();
});

test('one failed poll retries and retains the same round and advertisements', async () => {
  const h = await bridge(); await h.start(); const id = h.state.round_id, game = h.games[0];
  h.failPolls(true); await h.advance(3000);
  assert.equal(h.active, true); assert.equal(h.cards, 1);
  assert.match(h.nodes['neko-ads-launcher'].textContent, /重连/);
  h.failPolls(false); await h.advance(1500);
  assert.equal(h.state.round_id, id); assert.equal(h.games[0], game); assert.equal(h.games.length, 1);
  assert.match(h.nodes['neko-ads-state'].textContent, /恢复/);
  await h.advance(6500); assert.equal(h.active, true);
  h.stop();
});

test('a playing renderer limits routine status queries and leaves room for retries', async () => {
  const h = await bridge(); await h.start();
  const before = h.calls.filter(call=>call.command==='poll').length;
  await h.advance(30000);
  const polls = h.calls.filter(call=>call.command==='poll').length-before;
  assert.ok(polls<=20 && polls>=18);
  assert.equal(h.active,true);h.stop();
});

test('one timed-out poll is aborted and the next heartbeat recovers before lease expiry', async () => {
  const h = await bridge(); await h.start(); const stalled = h.holdNextPoll();
  await h.advance(9000);
  assert.equal(stalled.aborted, true); assert.equal(h.active, true); assert.ok(h.cards > 0);
  await h.advance(1500); stalled.release(); await flush();
  assert.equal(h.active, true); assert.equal(h.calls.some(call => call.command === 'stop'), false);
  h.stop();
});

test('the observed 4.7-second host delay is accepted without losing the round', async () => {
  const h = await bridge(); await h.start(); const oldGame = h.games[0], stalled = h.holdNextPoll();
  await h.advance(3000); await h.advance(4700);
  assert.equal(stalled.aborted, false);
  stalled.release(); await flush();
  assert.equal(h.active, true); assert.equal(h.games[0], oldGame);
  assert.equal(h.calls.some(call => call.command === 'stop'), false);
  await h.advance(21000); assert.equal(h.active, true); h.stop();
});

test('two consecutive six-second timeouts can recover in the same round', async () => {
  const h = await bridge(); await h.start(); const game = h.games[0], id = h.state.round_id;
  const first = h.holdNextPoll(), second = h.holdNextPoll();
  await h.advance(17000);
  assert.equal(first.aborted, true); assert.equal(second.aborted, true);
  assert.equal(h.active, true);
  await h.advance(1000);
  assert.equal(h.games[0], game); assert.equal(h.state.round_id, id); assert.equal(h.games.length, 1);
  assert.equal(h.calls.some(call => call.command === 'stop'), false); h.stop();
});

test('a slow status probe neither blocks heartbeat recovery nor overrides its newer success', async () => {
  const h = await bridge(); await h.start(); const probe = h.holdNextStatus();
  h.failPolls(true); await h.advance(3000);
  assert.equal(h.statusCalls, 1);
  h.failPolls(false); await h.advance(1500);
  assert.match(h.nodes['neko-ads-state'].textContent, /恢复/);
  probe.release('stopped'); await flush();
  assert.equal(h.active, true); assert.equal(h.calls.some(call => call.command === 'stop'), false);
  h.stop();
});

test('failed heartbeats do not create an extra status probe for every retry', async () => {
  const h = await bridge(); await h.start(); h.failPolls(true);
  await h.advance(7500);
  assert.equal(h.statusCalls, 1); assert.equal(h.active, true);
  h.failPolls(false); await h.advance(1500); assert.equal(h.active, true); h.stop();
});

test('a malformed successful response is retried instead of being read as a stopped game', async () => {
  const h = await bridge(); await h.start(); const malformed = h.holdNextPoll();
  await h.advance(3000); malformed.release({ready: true}); await flush();
  assert.equal(h.active, true); assert.equal(h.cards, 1);
  await h.advance(1500); assert.equal(h.active, true);
  assert.equal(h.calls.some(call => call.command === 'stop'), false);
  h.stop();
});

test('a confirmed start does not issue a duplicate immediate heartbeat for adoption', async () => {
  const h = await bridge(), count = h.calls.filter(call=>call.command==='poll').length;
  await h.start();
  assert.equal(h.calls.filter(call=>call.command==='poll').length, count);
  assert.equal(h.active, true); assert.equal(h.games.length, 1);
  h.stop();
});

test('local start prepares assets before accepting a backend round while heartbeat keeps running', async () => {
  const h = await bridge({}, {engineLoaded:false}), count=h.calls.filter(call=>call.command==='poll').length;
  const starting=h.start();await flush();await h.advance(6000);
  assert.equal(h.calls.some(call=>call.command==='start'),false);
  assert.ok(h.calls.filter(call=>call.command==='poll').length>count);
  h.loadEngine();await starting;
  assert.equal(h.active,true);assert.equal(h.games.length,1);
  h.stop();
});

test('a backend stop while first assets load cannot display a retired game', async () => {
  const h = await bridge({}, {engineLoaded:false});
  const owner=h.calls.find(call=>call.command==='poll').payload.client_id;
  Object.assign(h.state,{active:true,round_id:'00000000-0000-4000-8000-000000000099',owner});
  await h.advance(3000);const late=h.engineScript().onload;
  h.nativeStop();await h.advance(500);late();await h.advance(3000);
  assert.equal(h.active,false);assert.equal(h.games.length,0);assert.equal(h.cards,0);
});

test('a local safety exit while first assets load wins over their late completion', async () => {
  const h = await bridge({}, {engineLoaded:false}), starting=h.start();await flush();
  const late=h.engineScript().onload;
  h.input('广告下班');late();await starting;await h.advance(32000);
  assert.equal(h.active,false);assert.equal(h.games.length,0);assert.equal(h.cards,0);
});

test('an old shortcut reply cannot overwrite the display or key of a replacement round', async () => {
  const h=await bridge();await h.start();const old=h.state.round_id,held=h.holdNextShortcut();
  const changing=h.nodes['neko-ads-key'].onkeydown(h.key('Ctrl+Alt+K',h.nodes['neko-ads-key']));await flush();
  h.stop();await h.start();assert.notEqual(h.state.round_id,old);
  held.release();await changing;await flush();
  assert.equal(h.state.shortcut,'Ctrl+Shift+1');
  assert.equal(h.games.at(-1).shortcut,h.state.shortcut);assert.equal(h.nodes['neko-ads-key'].value,h.state.shortcut);
  h.press(h.key('Ctrl+Shift+1'));assert.equal(h.cards,0);
});

test('a backend replacement retires the old renderer timers before adopting the new round',async()=>{
  const h=await bridge();await h.start();const old=h.games[0];
  const next='00000000-0000-4000-8000-000000000077';
  Object.assign(h.state,{round_id:next});await h.advance(6000);
  assert.equal(old.active,false);assert.equal(old.timers.size,0);
  assert.equal(h.games.length,2);assert.equal(h.active,true);assert.equal(h.state.round_id,next);
  assert.equal(h.calls.some(call=>call.command==='stop'&&call.payload.round_id===next),false);
  h.stop();
});

test('a poll begun before an accepted shortcut change cannot undo the confirmed key', async () => {
  const h=await bridge();await h.start();const held=h.holdNextPoll();await h.advance(3000);
  await h.nodes['neko-ads-key'].onkeydown(h.key('Ctrl+Alt+K',h.nodes['neko-ads-key']));
  held.release();await flush();
  assert.equal(h.nodes['neko-ads-key'].value,'Ctrl+Alt+K');assert.equal(h.games[0].shortcut,'Ctrl+Alt+K');
  h.press(h.key('Ctrl+Alt+K'));assert.equal(h.active,false);
});

test('a lost shortcut reply keeps the previous display until a fresh query confirms the accepted key', async () => {
  const h=await bridge();await h.start();const held=h.holdNextShortcut();
  const changing=h.nodes['neko-ads-key'].onkeydown(h.key('Ctrl+Alt+K',h.nodes['neko-ads-key']));await flush();
  held.fail();await changing;
  assert.equal(h.nodes['neko-ads-key'].value,'Ctrl+Shift+1');assert.equal(h.games[0].shortcut,'Ctrl+Shift+1');
  await h.advance(3000);
  assert.equal(h.nodes['neko-ads-key'].value,'Ctrl+Alt+K');assert.equal(h.games[0].shortcut,h.state.shortcut);
  h.press(h.key('Ctrl+Alt+K'));assert.equal(h.active,false);
});

for(const initiallyHidden of [false,true]){
  test(`a start accepted while ${initiallyHidden?'already unfocused':'blurred before its reply'} waits for focus before ads or feedback`,async()=>{
    const h=await bridge({}, {focused:!initiallyHidden}),held=h.holdNextStart();
    const starting=h.start();await flush();if(!initiallyHidden)h.hide();held.release();await starting;
    assert.equal(h.active,true);assert.equal(h.games[0].paused,true);assert.equal(h.cards,0);
    await h.advance(12000);assert.equal(h.cards,0);assert.equal(h.calls.some(call=>call.command==='speech'),false);
    h.focus();assert.equal(h.cards,1);assert.equal(h.games[0].paused,false);h.stop();
  });
}

test('a temporary avatar anchor failure is not reported as a failed connection and safe exit still works',async()=>{
  const h=await bridge();await h.start();
  h.window.avatarReactionBubble={getActiveAvatarBubbleAnchor(){throw new Error('temporary model error');}};
  await h.advance(27000);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase,'playing');assert.equal(h.active,true);
  assert.equal(h.statusCalls,0);assert.doesNotMatch(h.nodes['neko-ads-launcher'].textContent,/重连|中断/);
  h.input('广告下班');assert.equal(h.cards,0);assert.equal(h.active,false);
});

test('render failure pauses presentation without stopping heartbeat, then recovers in the same round',async()=>{
  const h=await bridge();await h.start();const id=h.state.round_id,original=templates.create;
  try{
    templates.create=()=>{throw new Error('temporary render error');};
    h.windowEvent('resize');await h.advance(9000);
    assert.equal(h.nodes['neko-ads-dialog'].dataset.phase,'playing');assert.equal(h.games[0].paused,true);
    assert.equal(h.statusCalls,0);assert.equal(h.state.round_id,id);
    templates.create=original;await h.advance(1500);
    assert.equal(h.games.length,1);assert.equal(h.games[0].paused,false);assert.equal(h.state.round_id,id);
    assert.ok(h.cards>0);h.stop();
  } finally {templates.create=original;}
});

test('a stalled asset load times out without a backend start, and retry works without reloading the page',async()=>{
  const h=await bridge({}, {engineLoaded:false}),starting=h.start();await flush();
  await h.advance(9000);await starting;
  assert.equal(h.calls.some(call=>call.command==='start'),false);assert.equal(h.active,false);
  assert.ok(h.calls.filter(call=>call.command==='poll').length>=3);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase,'standby');
  const retry=h.start();await flush();h.loadEngine();await retry;
  assert.equal(h.active,true);h.stop();
});

test('an asset script without its expected export fails cleanly and can be retried',async()=>{
  const h=await bridge({}, {engineLoaded:false}),starting=h.start();await flush();
  h.engineScript().onload();await starting;
  assert.equal(h.calls.some(call=>call.command==='start'),false);
  assert.match(h.nodes['neko-ads-state'].textContent,/资源无效/);
  const retry=h.start();await flush();h.loadEngine();await retry;assert.equal(h.active,true);h.stop();
});

for(const exit of ['word','key','native']){
  test(`${exit} exit during deferred first presentation wins over later focus`,async()=>{
    const h=await bridge({}, {focused:false});await h.start();assert.equal(h.games[0].paused,true);
    if(exit==='word')h.input('广告下班');
    else if(exit==='key')h.press(h.key('Ctrl+Shift+1'));
    else {h.nativeStop();await h.advance(500);}
    h.focus();await h.advance(12000);
    assert.equal(h.active,false);assert.equal(h.cards,0);assert.equal(h.state.active,false);
  });
}

test('remote start asset preparation does not block lease heartbeats or native safety exit',async()=>{
  const h=await bridge({}, {engineLoaded:false});
  const owner=h.calls.find(call=>call.command==='poll').payload.client_id,id='00000000-0000-4000-8000-000000000088';
  Object.assign(h.state,{active:true,round_id:id,owner});await h.advance(6500);
  const polls=h.calls.filter(call=>call.command==='poll');
  assert.ok(polls.length>=3);assert.equal(polls.at(-1).payload.round_id,id);assert.equal(h.active,false);
  h.nativeStop();await h.advance(500);assert.equal(h.engineScript(),undefined);
  assert.equal(h.cards,0);assert.equal(h.nodes['neko-ads-stop'].disabled,true);
});

test('sustained loss clears twenty seconds after the first failed query even if stop cannot reach the plugin', async () => {
  const h = await bridge(); await h.start(); h.failAll(true);
  await h.advance(3000); // First failed query, rather than the preceding success.
  await h.advance(19999); assert.equal(h.active, true);
  await h.advance(1); assert.equal(h.active, false); assert.equal(h.cards, 0);
  assert.match(h.nodes['neko-ads-state'].textContent, /持续失联/);
  h.failAll(false); await h.advance(2000);
  assert.equal(h.active, false); assert.equal(h.cards, 0, 'a recovered old server snapshot cannot revive the round');
});

test('standby uses the same fixed grace and repeated failures cannot extend it', async () => {
  const h = await bridge(); h.failPolls(true); await h.advance(3000);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'reconnecting');
  await h.advance(19999);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'reconnecting');
  await h.advance(1);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'unavailable');
  await h.advance(9000);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'unavailable');
  h.failPolls(false); await h.advance(3000);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'standby');
  assert.equal(h.cards, 0);
});

test('a timed-out request gets the full grace after failure, and never revives after expiry', async () => {
  const h = await bridge(); await h.start(); h.holdNextPoll();
  await h.advance(3000); h.failAll(true);
  await h.advance(6000); // Failure is observed now, six seconds after dispatch.
  await h.advance(19999); assert.equal(h.active, true);
  await h.advance(1); assert.equal(h.active, false);
  h.failAll(false); await h.advance(4000); assert.equal(h.cards, 0);
});

test('a delayed stopped probe cannot overwrite a newer successful standby query', async () => {
  const h = await bridge(), probe = h.holdNextStatus();
  h.failPolls(true); await h.advance(3000);
  h.failPolls(false); await h.advance(3000);
  probe.release('stopped'); await flush();
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'standby');
});

for (const shortcut of ['Ctrl+Shift+1', 'Ctrl+Alt+K']) {
  test(`${shortcut} native backend exit clears locally through SDK context while an action query is hung`, async () => {
    const h = await bridge(); await h.start();
    if (shortcut !== 'Ctrl+Shift+1') await h.nodes['neko-ads-key'].onkeydown(h.key(shortcut, h.nodes['neko-ads-key']));
    const stalled = h.holdNextPoll(); await h.advance(3000);
    h.nativeStop(); await h.advance(500);
    assert.equal(stalled.aborted, false); assert.equal(h.cards, 0); assert.equal(h.active, false);
    stalled.release(); await flush(); await h.advance(8000); assert.equal(h.cards, 0);
  });
}

test('stop retries remain bound to the old round and cannot stop its replacement', async () => {
  const h = await bridge(); await h.start(); const oldId = h.state.round_id, held = h.holdNextStop();
  h.stop(); await h.start(); const newId = h.state.round_id;
  h.failPolls(true);
  await h.advance(8000);
  assert.notEqual(oldId, newId); assert.equal(held.aborted, true);
  assert.equal(h.active, true); assert.equal(h.state.round_id, newId);
  const stops = h.calls.filter(c=>c.command === 'stop');
  assert.ok(stops.length >= 2); assert.ok(stops.every(c=>c.payload.round_id === oldId));
  h.broadcast(oldId); assert.equal(h.active, true);
  h.failPolls(false);
  h.stop();
});

test('a fresh query confirming a retired round stops retries even if its stop reply is hung', async () => {
  const h = await bridge(); await h.start(); const held = h.holdNextStop(); h.stop();
  await h.advance(25000);
  assert.equal(held.aborted,true);
  assert.equal(h.calls.filter(c=>c.command === 'stop').length,1);
  assert.doesNotMatch(h.nodes['neko-ads-state'].textContent,/后台停止尚未确认/);
});

test('after a failed stop local idle polls never renew the retired round', async () => {
  const h = await bridge(); await h.start(); h.failAll(true); h.stop();
  h.failAll(false); await h.advance(4000);
  assert.equal(h.cards, 0);
  const lastPoll = h.calls.filter(c=>c.command === 'poll').at(-1);
  assert.equal(lastPoll.payload.round_id, null);
});

for (const method of ['input', 'compose', 'shortcut', 'button', 'broadcast', 'pagehide']) {
  test(`${method} exit clears immediately during a stalled poll and late replies cannot revive ads`, async () => {
    const h = await bridge(); await h.start(); const old = h.holdNextPoll();
    await h.advance(3000);
    if (method === 'input') h.input('广告下班');
    else if (method === 'compose') h.compose('广 告 下 班');
    else if (method === 'shortcut') h.press(h.key('Ctrl+Shift+1'));
    else if (method === 'button') h.stop();
    else if (method === 'broadcast') h.broadcast();
    else h.windowEvent('pagehide');
    assert.equal(h.active, false); assert.equal(h.cards, 0);
    old.release(); await flush(); await h.advance(32000);
    assert.equal(h.active, false); assert.equal(h.cards, 0);
  });
}

test('safety-word exit wins over a pending start acknowledgement', async () => {
  const h = await bridge(), old = h.holdNextStart(), starting = h.start();
  await flush(); h.input('广告下班');
  assert.equal(h.cards, 0); old.release(); await starting; await h.advance(32000);
  assert.equal(h.active, false); assert.equal(h.cards, 0); assert.equal(h.state.active, false);
});

test('the customized exit key still works while reconnecting', async () => {
  const h = await bridge(); await h.start();
  await h.nodes['neko-ads-key'].onkeydown(h.key('Ctrl+Alt+K', h.nodes['neko-ads-key']));
  h.failPolls(true); await h.advance(3000);
  h.press(h.key('Ctrl+Shift+1')); assert.equal(h.active, true);
  h.press(h.key('Ctrl+Alt+K')); assert.equal(h.active, false); assert.equal(h.cards, 0);
  await h.advance(32000); assert.equal(h.active, false);
});

for (const method of ['input', 'shortcut']) {
  test(`${method} exit remains immediate after a connection failure even if the stop request fails`, async () => {
    const h = await bridge(); await h.start(); h.failAll(true); await h.advance(3000);
    assert.match(h.nodes['neko-ads-launcher'].textContent, /重连/);
    if (method === 'input') h.input('广告下班');
    else h.press(h.key('Ctrl+Shift+1'));
    assert.equal(h.active, false); assert.equal(h.cards, 0);
    h.failAll(false); await h.advance(32000);
    assert.equal(h.active, false); assert.equal(h.cards, 0);
  });
}

test('a fresh explicit server stop is applied without waiting for the loss deadline', async () => {
  const h = await bridge(); await h.start(); h.state.active = false;
  await h.advance(3000); assert.equal(h.active, false); assert.equal(h.cards, 0);
});

test('a late active reply from the previous round cannot affect a restarted round', async () => {
  const h = await bridge(); await h.start(); const old = h.holdNextPoll();
  await h.advance(3000); h.stop(); await h.start(); const id = h.state.round_id;
  old.release(); await flush(); await h.advance(6500);
  assert.equal(h.active, true); assert.equal(h.state.round_id, id); assert.equal(h.games.length, 2);
  h.stop();
});

test('an internet offline notification alone does not end a healthy local connection', async () => {
  const h = await bridge(); await h.start(); h.windowEvent('offline');
  assert.equal(h.active, true); await h.advance(6500); assert.equal(h.active, true);
  h.stop();
});

test('enabling and polling stays in standby without starting cards or speech', async () => {
  const h = await bridge(); await h.advance(20000);
  assert.equal(h.games.length, 0); assert.equal(h.cards, 0);
  assert.equal(h.calls.some(call => ['start', 'speech'].includes(call.command)), false);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'standby');
  assert.equal(h.nodes['neko-ads-start'].disabled, false);
  assert.equal(h.nodes['neko-ads-stop'].disabled, true);
});

test('ending a round returns to standby and a new round requires another click', async () => {
  const h = await bridge(); await h.start();
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'playing');
  assert.equal(h.nodes['neko-ads-start'].disabled, true);
  h.stop(); await h.advance(10000);
  assert.equal(h.state.ready, true); assert.equal(h.cards, 0);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'standby');
  assert.equal(h.nodes['neko-ads-start'].disabled, false);
  assert.equal(h.calls.filter(call => call.command === 'start').length, 1);
  await h.start(); assert.equal(h.games.length, 2); assert.equal(h.cards, 1); h.stop();
});

test('plugin shutdown clears the round and re-enabling stays idle', async () => {
  const h = await bridge(); await h.start(); Object.assign(h.state, {ready: false, active: false});
  await h.advance(3000); assert.equal(h.cards, 0);
  assert.equal(h.nodes['neko-ads-start'].disabled, true);
  h.state.ready = true; await h.advance(10000);
  assert.equal(h.active, false); assert.equal(h.cards, 0); assert.equal(h.games.length, 1);
  assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'standby');
});

for (const playing of [false, true]) {
  test(`confirmed plugin shutdown stays hidden beyond reconnect grace (${playing ? 'playing' : 'standby'})`, async () => {
    const h = await bridge();
    if (playing) await h.start();
    Object.assign(h.state, {ready:false, active:false});
    await h.advance(3000);
    const commands = h.calls.length;
    assert.equal(h.active, false); assert.equal(h.cards, 0);
    assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'disabled');
    assert.equal(h.nodes['neko-ads-launcher'].hidden, true);
    await h.advance(65000);
    assert.equal(h.calls.length, commands, 'stopped plugins should only receive lifecycle status probes');
    assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'disabled');
    assert.equal(h.nodes['neko-ads-launcher'].hidden, true);
    assert.doesNotMatch(h.nodes['neko-ads-state'].textContent, /重连|失联|中断|尚未确认/);
    const unknown = h.holdNextStatus(); await h.advance(3000);
    unknown.release('unknown'); await flush();
    assert.equal(h.calls.length, commands, 'unknown lifecycle status cannot be treated as a restart');
    h.windowEvent('offline');
    assert.equal(h.nodes['neko-ads-launcher'].hidden, true);
    h.failAll(true); await h.advance(30000);
    assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'disabled');
    assert.equal(h.nodes['neko-ads-launcher'].hidden, true);
    h.failAll(false); h.state.ready = true; await h.advance(10000);
    assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'standby');
    assert.equal(h.nodes['neko-ads-launcher'].hidden, false);
    assert.equal(h.active, false); assert.equal(h.cards, 0);
    assert.equal(h.calls.filter(call => call.command === 'start').length, playing ? 1 : 0);
  });
}

for (const shortcut of ['Ctrl+Shift+1', 'Ctrl+Alt+K']) {
  test(`${shortcut} can cancel an in-flight start before a Game exists`, async () => {
    const h = await bridge({shortcut});
    if (shortcut !== 'Ctrl+Shift+1') await h.nodes['neko-ads-key'].onkeydown(h.key(shortcut, h.nodes['neko-ads-key']));
    const old = h.holdNextStart(), starting = h.start(); await flush();
    assert.equal(h.nodes['neko-ads-dialog'].dataset.phase, 'starting');
    assert.equal(h.nodes['neko-ads-stop'].disabled, false);
    h.press(h.key(shortcut)); old.release(); await starting; await h.advance(32000);
    assert.equal(h.cards, 0); assert.equal(h.active, false); assert.equal(h.state.active, false);
    assert.equal(h.games.length, 0);
  });
}
