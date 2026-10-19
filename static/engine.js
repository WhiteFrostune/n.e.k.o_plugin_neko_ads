/* Pure round state, shared by the browser and deterministic exit/race tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NekoAds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SAFE_WORD = '广告下班';
  const FEEDBACK = {
    start: ['广告部，开——业！主人今天也要好好看广告哦♡', '広告の時間だよ。ちゃんと見てね♡', 'smug'],
    dodge: ['こっち、こっち～连一个叉都追不上？', 'こっち、こっち。遅いね、ざぁこ♡', 'smug'],
    fake: ['ざぁこ♡ 你关闭的是广告的广告哦。', 'ざぁこ。それは広告の広告だよ♡', 'smug'],
    split: ['关掉一张，赠送一张！猫娘广告部就是这么贴心～', 'もう一枚、プレゼントだよ♡', 'smug'],
    scan: ['体检完毕！主人缺的不是优化，是猫娘♡', '足りないのは、猫ちゃんだよ♡', 'smug'],
    later: ['稍后？本广告部的稍后，就是现在哦～', 'あとで？今すぐだよ♡', 'smug'],
    closed: ['哼，刚刚算你赢。可别得意忘形了！', '今回は負けてあげる。調子に乗らないでね。', 'pout'],
    streak: ['等、等等……你怎么越来越熟练了！不许笑！', 'ちょっと。上手くなりすぎ。笑わないで！', 'flustered'],
    view: ['嘴上嫌烦，点得倒是很诚实嘛，主人♡', 'ふふ、気になるんだね、ざぁこ♡', 'smug'],
  };
  const BUILTINS = [
    {kind: 'poster', title: '是主人就来养我！', subtitle: '猫娘计划 · 桌面陪伴', body: '开局一只猫，陪伴全靠聊。你的桌面，猫娘承包了！', badge: '今日热喵', action: '领取桌面猫娘', trick: 'fake'},
    {kind: 'nearby', title: '你附近有一只猫娘', subtitle: '正在等你说话！', body: '不用跨服，不用排队。打开猫娘计划，和桌面上的她聊两句。', badge: '猫娘在线', action: '查看猫娘计划', trick: 'dodge'},
    {kind: 'scan', title: '桌面含猫量严重不足！', subtitle: '猫娘广告部 · 一本正经体检', body: '建议补充：一只猫娘、一段闲聊，以及一点点对主人的关爱。', badge: '紧急补猫', action: '立即补猫', trick: 'scan'},
    {kind: 'market', title: '震惊！桌面还能这样玩？', subtitle: '猫娘计划 · 插件市场', body: '搜索、提醒、陪伴……去插件市场看看真实功能，猫娘广告部负责夸张宣传！', badge: '插件上新', action: '逛逛插件市场', trick: 'split'},
  ];
  function normalizeCatalog(payload) {
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    return items.filter(p => p && typeof p.name === 'string' && p.name.trim() && p.id != null)
      .slice(0, 12).map(p => ({
        kind: 'recommendation', title: `震惊！${p.name.trim().slice(0, 40)}登场！`,
        subtitle: '来自猫娘计划插件市场 · 真实推荐',
        body: String(p.short_description || p.description || '点击查看这个插件的真实功能。').slice(0, 180),
        badge: '主人必看', action: '查看插件介绍', trick: 'split',
        pluginId: String(p.id).slice(0, 100), pluginName: p.name.trim().slice(0, 40),
      }));
  }
  class Game {
    constructor({schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id), now = Date.now, random = Math.random, onChange = () => {}, onFeedback = () => {}, onStop = () => {}} = {}) {
      Object.assign(this, {schedule, cancel, now, random, onChange, onFeedback, onStop});
      this.active = false;
      this.generation = 0;
      this.timers = new Set();
      this.cards = [];
      this.catalog = [];
      this.nextId = 0;
      this.cursor = 0;
      this.closed = 0;
      this.attempts = 0;
      this.lastFeedback = -Infinity;
    }
    later(fn, ms) {
      const generation = this.generation;
      const id = this.schedule(() => {
        this.timers.delete(id);
        if (this.active && generation === this.generation) fn();
      }, ms);
      this.timers.add(id);
    }
    start() {
      if (this.active) return;
      this.generation++;
      this.active = true;
      this.cards = [];
      this.cursor = this.closed = this.attempts = 0;
      this.lastFeedback = -Infinity;
      this.spawn();
      this.feedback('start');
      this.loop();
    }
    stop(reason = 'exit') {
      this.active = false;
      this.generation++;
      for (const id of this.timers) this.cancel(id);
      this.timers.clear();
      this.cards = [];
      this.onStop(reason);
      this.onChange();
    }
    loop() {
      this.later(() => { this.spawn(); this.loop(); }, 6500 + this.random() * 3500);
    }
    spawn() {
      if (!this.active || this.cards.length >= 3) return;
      const pool = [...BUILTINS, ...this.catalog];
      const template = pool[this.cursor++ % pool.length];
      this.cards.push({...template, id: ++this.nextId, tries: 0, dodges: 0, x: this.random(), y: this.random()});
      this.onChange();
    }
    feedback(event) {
      if (!this.active) return;
      const speak = this.now() - this.lastFeedback >= 2200;
      if (speak) this.lastFeedback = this.now();
      this.onFeedback(FEEDBACK[event], speak);
    }
    hover(id) {
      const card = this.cards.find(c => c.id === id);
      if (!this.active || !card || card.trick !== 'dodge' || card.dodges >= 2) return false;
      card.dodges++;
      card.x = this.random(); card.y = this.random();
      this.feedback('dodge'); this.onChange();
      return true;
    }
    close(id) {
      const card = this.cards.find(c => c.id === id);
      if (!this.active || !card) return;
      this.attempts++;
      if (card.trick === 'fake' && card.tries++ === 0) {
        card.title = '您关闭的是广告的广告';
        card.subtitle = '真正的猫娘宣传，现在才开始！';
        this.feedback('fake'); this.onChange(); return;
      }
      if (card.trick === 'scan' && card.tries++ === 0) {
        card.title = '体检结果：主人需要补猫';
        card.body = '缺猫指数 99.9%（猫娘广告部编的）。处方：打开猫娘计划，陪她聊聊天。';
        this.feedback('scan'); this.onChange(); return;
      }
      this.cards = this.cards.filter(c => c !== card);
      this.closed++;
      this.feedback(this.closed >= 3 ? 'streak' : card.trick === 'split' ? 'split' : 'closed');
      this.onChange();
      if (card.trick === 'split') this.later(() => this.spawn(), 700);
    }
    postpone(id) {
      if (!this.active || !this.cards.some(c => c.id === id)) return;
      this.feedback('later'); this.spawn();
    }
    input(value) {
      const text = String(value).normalize('NFKC').replace(/\s/g, '');
      if (text.includes(SAFE_WORD)) { this.stop('safe-word'); return true; }
      return false;
    }
    key(event) {
      if (event.ctrlKey && event.shiftKey && (event.code === 'KeyQ' || String(event.key).toLowerCase() === 'q')) {
        this.stop('shortcut'); return true;
      }
      return false;
    }
  }
  return {Game, BUILTINS, FEEDBACK, SAFE_WORD, normalizeCatalog};
});
