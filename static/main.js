(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const BASE = '/plugin/neko_ads/hosted-ui';
  let roundId = null;
  let starting = false;
  let revision = 0;
  let pollTimer = null;
  let voiceEnabled = true;
  let japaneseVoice = null;
  let marketBase = null;
  let keyBuffer = '';
  let keyTime = 0;
  let connected = false;
  let epoch = '';
  const speech = window.speechSynthesis;

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(url, {...options, signal: controller.signal, cache: 'no-store'});
      if (!response.ok) throw new Error('request_failed');
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  async function action(name, args = {}, keepalive = false) {
    const envelope = await request(`${BASE}/action/${name}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({args, kind: 'panel', surface_id: 'main', locale: 'zh-CN'}), keepalive,
    });
    const result = envelope.result;
    if (!result || result.success === false) throw new Error('action_failed');
    return result.data || result;
  }
  function retire(id) {
    if (id) action('stop_game', {round_id: id}, true).catch(() => {});
  }
  function updateVoices() {
    japaneseVoice = speech && speech.getVoices().find(v => /^ja(?:-|_)/i.test(v.lang));
    $('voice-status').textContent = japaneseVoice ? '使用系统日语语音，非角色原声' : '未发现日语语音，使用文字反馈';
    $('voice').disabled = !japaneseVoice;
    if (!japaneseVoice) $('voice').checked = false;
  }
  if (speech) speech.addEventListener('voiceschanged', updateVoices);
  updateVoices();

  const game = new NekoAds.Game({
    onChange: render,
    onFeedback: ([text, japanese, mood], speak) => {
      $('speech').textContent = text;
      $('companion').dataset.mood = mood;
      if (speak && voiceEnabled && japaneseVoice && speech) {
        try {
          speech.cancel();
          const utterance = new SpeechSynthesisUtterance(japanese);
          utterance.voice = japaneseVoice;
          utterance.lang = 'ja-JP'; utterance.rate = 1.08; utterance.pitch = 1.18; utterance.volume = 0.65;
          speech.speak(utterance);
        } catch (_) { voiceEnabled = false; }
      }
    },
    onStop: reason => {
      revision++;
      starting = false;
      clearTimeout(pollTimer);
      if (speech) speech.cancel();
      retire(roundId);
      roundId = null;
      keyBuffer = '';
      $('chat-input').value = '';
      document.body.classList.remove('playing');
      $('playfield').hidden = $('chat').hidden = $('lobby').hidden = true;
      $('result').hidden = false;
      $('result-message').textContent = reason === 'connection' ? '与插件的连接已断开，本局已自动结束。所有广告与语音均已停止。' : '所有广告与语音均已停止。';
      $('result-score').textContent = `本局关掉 ${game.closed} 张广告 · 尝试 ${game.attempts} 次`;
      $('back').focus();
    },
  });

  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function render() {
    const focusedId = document.activeElement && document.activeElement.dataset.closeId;
    $('ads').replaceChildren();
    for (const card of game.cards) {
      const ad = node('article', `ad ${card.kind}`);
      ad.dataset.cardId = card.id;
      ad.setAttribute('aria-label', card.title);
      const bar = node('div', 'ad-bar');
      bar.append(node('span', '', card.subtitle));
      const close = node('button', 'ad-close', '×');
      close.type = 'button'; close.dataset.closeId = card.id;
      close.setAttribute('aria-label', `关闭广告：${card.title}`);
      close.addEventListener('pointerenter', e => { if (e.pointerType !== 'touch') game.hover(card.id); });
      close.addEventListener('click', () => game.close(card.id));
      bar.append(close);
      const content = node('div', 'ad-content');
      content.append(node('span', 'ad-badge', card.badge), node('h2', '', card.title), node('p', '', card.body));
      const link = node('a', 'ad-cta', card.action);
      link.href = card.kind === 'market' ? '/ui/market' : card.pluginId && marketBase ? `${marketBase}/#/plugin/${encodeURIComponent(card.pluginId)}` : 'https://github.com/Project-N-E-K-O/N.E.K.O';
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', () => game.feedback('view'));
      content.append(link);
      const later = node('button', 'ad-later', '稍后提醒');
      later.type = 'button'; later.addEventListener('click', () => game.postpone(card.id));
      content.append(later);
      ad.append(bar, content, node('div', 'ad-footer', card.pluginId ? '真实插件功能以上方介绍为准 · 猫娘广告部倾情吆喝' : '猫娘计划宣传 · 猫娘广告部出品'));
      $('ads').append(ad);
      const area = $('ads');
      ad.style.left = `${Math.round(card.x * Math.max(0, area.clientWidth - ad.offsetWidth))}px`;
      ad.style.top = `${Math.round(card.y * Math.max(0, area.clientHeight - ad.offsetHeight))}px`;
      if (focusedId === String(card.id)) close.focus({preventScroll: true});
    }
    $('score').textContent = `已关 ${game.closed} 张 / 猫娘还在营业`;
  }

  async function probe() {
    try {
      const context = await request(`${BASE}/context?kind=panel&id=main&locale=zh-CN`);
      connected = context.state && context.state.ready === true;
      epoch = context.state && context.state.epoch || '';
    } catch (_) { connected = false; }
    $('start').disabled = !connected;
    $('start').textContent = connected ? '确认，开始游戏 ↗' : '重新连接广告部';
    // Allow retry even when the plugin was started after this page loaded.
    $('start').disabled = false;
    $('connection').textContent = connected ? '广告部已就绪，等待主人开局。' : '请先启动本插件，再点击重新连接。';
  }
  async function heartbeat(id) {
    if (!game.active || roundId !== id) return;
    try {
      const status = await action('heartbeat', {round_id: id});
      if (!game.active || roundId !== id) return;
      if (status.active !== true) { game.stop('connection'); return; }
      pollTimer = setTimeout(() => heartbeat(id), 1000);
    } catch (_) { if (game.active && roundId === id) game.stop('connection'); }
  }
  $('start').addEventListener('click', async () => {
    if (!connected) { await probe(); return; }
    if (starting || game.active) return;
    starting = true;
    $('start').disabled = true;
    $('connection').textContent = '正在开局…';
    const ticket = ++revision;
    const id = crypto.randomUUID();
    roundId = id;
    try {
      const result = await action('start_game', {round_id: id, confirmed: true, epoch});
      if (ticket !== revision || document.hidden) { retire(id); return; }
      if (result.active !== true || result.round_id !== id) throw new Error('start_rejected');
      starting = false;
      voiceEnabled = $('voice').checked;
      $('lobby').hidden = $('result').hidden = true;
      $('playfield').hidden = $('chat').hidden = false;
      document.body.classList.add('playing');
      game.start();
      $('chat-input').focus({preventScroll: true});
      heartbeat(id);
    } catch (error) {
      console.warn('Neko Ads start failed:', error);
      if (ticket === revision) game.stop('connection');
      else retire(id);
    } finally { if (ticket === revision) { starting = false; $('start').disabled = false; } }
  });
  $('back').addEventListener('click', () => {
    $('result').hidden = true; $('lobby').hidden = false;
    probe();
  });
  $('chat-input').addEventListener('input', e => game.input(e.target.value));
  $('chat-input').addEventListener('compositionend', e => game.input(e.target.value));
  $('chat').addEventListener('submit', e => {
    e.preventDefault();
    if (!game.input($('chat-input').value) && game.active && $('chat-input').value.trim()) {
      game.feedback('fake'); $('chat-input').value = '';
    }
  });
  document.addEventListener('keydown', e => {
    if (!game.active && !starting) return;
    if (game.key(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1) {
      if (Date.now() - keyTime > 5000) keyBuffer = '';
      keyTime = Date.now(); keyBuffer = (keyBuffer + e.key).slice(-20);
      game.input(keyBuffer);
    }
  }, true);
  // Captures committed IME text even if focus moved away from the chat input.
  document.addEventListener('compositionend', e => {
    if (game.active || starting) game.input(e.data || '');
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (game.active || starting)) game.stop('leave');
  });
  window.addEventListener('pagehide', () => { if (game.active || starting) game.stop('leave'); });
  window.addEventListener('resize', render);
  window.addEventListener('offline', () => { if (game.active || starting) game.stop('connection'); });

  async function loadCatalog() {
    try {
      const [catalog, status] = await Promise.all([
        request('/market/catalog/api/v1/plugins?page=1&page_size=12'), request('/market/status'),
      ]);
      const url = new URL(status.market_web_url || status.market_url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_market');
      marketBase = url.origin + url.pathname.replace(/\/$/, '');
      game.catalog = NekoAds.normalizeCatalog(catalog);
      $('catalog-status').textContent = game.catalog.length ? `本期收到 ${game.catalog.length} 条真实插件推荐。` : '市场暂无推荐，使用猫娘计划宣传。';
    } catch (_) {
      $('catalog-status').textContent = '插件市场暂不可用，本局仅宣传猫娘计划。';
    }
  }
  probe(); loadCatalog();
})();
