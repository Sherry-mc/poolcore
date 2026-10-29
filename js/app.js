/* ==========================================================================
   池核 · POOLCORE — 装配层
   --------------------------------------------------------------------------
   hash 路由：#/home  #/gallery  #/view/:id  #/collection  #/contribute  #/about
   这里也是唯一允许「组装」的地方：把渲染器、音景、存储、三块界面接起来。
   任何一处初始化失败都不该让整站白屏 —— 每步都兜底，并把原因告诉用户。
   ========================================================================== */

(function (root) {
  'use strict';

  var P = root.POOLCORE = root.POOLCORE || {};
  var doc = root.document;
  var VIEWS = ['home', 'gallery', 'collection', 'contribute', 'about'];
  var toastTimer = 0;
  var storageToldOnce = false;

  function $(id) { return doc.getElementById(id); }

  function toast(msg, ms) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) root.clearTimeout(toastTimer);
    toastTimer = root.setTimeout(function () { el.hidden = true; }, ms || 2400);
  }

  var state = {
    view: 'home',
    viewedFrom: 'home',
    sound: null,
    viewer: null,
    gallery: null,
    contribute: null,
    nav: null,
    hero: null,
    ready: false
  };

  /* ---------------- 音景 ---------------- */

  function soundToggle() {
    var s = state.sound;
    if (!s) return;
    var st = s.state();
    if (!st.supported) { toast('这个浏览器拿不到音频上下文，声音就先算了'); return; }
    if (!st.unlocked) { s.unlock(); s.setMuted(false); }
    else s.setMuted(!st.muted);
    P.store.saveSettings({ muted: !!s.state().muted });
    syncSound();
  }

  function syncSound() {
    if (state.nav) state.nav.sync();
    if (state.viewer) state.viewer.syncSound();
  }

  function unlockFromGesture() {
    var s = state.sound;
    if (!s || s.state().unlocked) return;
    s.unlock();
    s.setMuted(!!P.store.settings().muted);
    syncSound();
  }

  /* ---------------- 收藏变化 ---------------- */

  function noticeStorage() {
    if (storageToldOnce || P.store.available) return;
    storageToldOnce = true;
    toast('这个浏览器不让网页在本地存东西：收藏只保留到刷新前。用本地服务器打开就能记住。', 4200);
  }

  function refreshAll() {
    noticeStorage();
    P.renderStats();
    if (state.gallery) state.gallery.refresh();
    if (state.view === 'collection') P.renderCollection(uiOpts());
    if (state.view === 'contribute' && state.contribute) state.contribute.refreshMine();
    if (state.view === 'about') P.renderAbout();
  }

  function uiOpts() {
    return {
      onOpen: openScene,
      onFavChange: refreshAll,
      toast: toast
    };
  }

  /* ---------------- 路由 ---------------- */

  function parseHash() {
    var h = (root.location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('/');
    return { name: parts[0] || 'home', param: parts.slice(1).join('/') };
  }

  function setActive(name) {
    var links = doc.querySelectorAll('.nav-link');
    Array.prototype.forEach.call(links, function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-route') === name);
    });
  }

  function showView(name) {
    if (VIEWS.indexOf(name) < 0) name = 'home';
    for (var i = 0; i < VIEWS.length; i++) {
      var el = $('view-' + VIEWS[i]);
      if (el) el.hidden = VIEWS[i] !== name;
    }
    setActive(name);
    state.view = name;

    try {
      if (name === 'home') {
        ensureHero();
        P.renderHome(uiOpts());
      } else if (name === 'gallery') {
        if (state.gallery) state.gallery.render();
      } else if (name === 'collection') {
        P.renderCollection(uiOpts());
      } else if (name === 'contribute') {
        if (state.contribute) state.contribute.refreshMine();
      } else if (name === 'about') {
        P.renderAbout();
      }
    } catch (e) {
      reportOnce(e, '渲染这个页面时出错了');
    }

    if (state.hero) {
      if (name === 'home') state.hero.start();
      else state.hero.stop();
    }
    root.scrollTo(0, 0);
  }

  function ensureHero() {
    if (state.hero) return;
    var cv = $('hero-canvas');
    if (!cv) return;
    try {
      state.hero = P.startHero(cv, cv.getAttribute('data-scene') || 'indoor-morning');
    } catch (e) {
      /* 主视觉失败不影响其余部分 */
    }
  }

  function openScene(id) {
    state.viewedFrom = state.view;
    root.location.hash = '#/view/' + encodeURIComponent(id);
  }

  function handleRoute() {
    var r = parseHash();
    if (r.name === 'view') {
      var id = decodeURIComponent(r.param || '');
      var exists = P.sceneById(id) || P.store.findSubmission(id);
      if (!exists) {
        toast('找不到这个场景，先回画廊');
        root.location.hash = '#/gallery';
        return;
      }
      if (state.viewer.isOpen() && state.viewer.currentId() === id) return;
      /* 查看器要盖住首页了：主视觉那块水面还在后面按 12fps 画，
         每帧照样要花十几毫秒 —— 不掐掉就是在跟查看器抢 CPU，
         拖动会一顿一顿。关掉查看器回首页时 showView 会把它重新拉起来。 */
      if (state.hero) state.hero.pause();
      state.viewedFrom = state.view;
      state.viewer.open(id);
      return;
    }
    if (state.viewer.isOpen()) state.viewer.close();
    showView(r.name);
  }

  function viewerClosed() {
    /* 查看器关了：主视觉可以接着画了（在首页的话） */
    if (state.hero) state.hero.resume();
    if (parseHash().name === 'view') {
      root.location.hash = '#/' + state.viewedFrom;
    }
    refreshAll();
  }

  var reported = {};
  function reportOnce(e, msg) {
    var key = msg + '|' + (e && e.message ? e.message : '');
    if (reported[key]) return;
    reported[key] = 1;
    if (root.console && root.console.warn) root.console.warn('[池核]', msg, e);
    toast(msg, 3400);
  }

  /* ---------------- 启动 ---------------- */

  function boot() {
    /* 先确认这台浏览器能不能画 */
    var probe = doc.createElement('canvas');
    var ok = probe.getContext && (probe.getContext('2d'));
    if (!ok) {
      toast('这台浏览器不支持 Canvas 2D，画面就画不出来了', 6000);
      return;
    }

    try {
      state.sound = P.createSoundscape();
      var s = P.store.settings();
      state.sound.setVolume(s.volume);
      state.sound.setMuted(s.muted);
    } catch (e) {
      state.sound = P.createSoundscape();     // 退化：仍然给出对象，只是不出声
      reportOnce(e, '音景初始化失败了，画面不受影响');
    }

    state.viewer = P.createViewer({
      sound: state.sound,
      cycle: function (dir) { state.viewer.cycle(dir); },
      onChange: syncSound,
      onClose: viewerClosed,
      onError: function (m) { toast(m, 3600); },
      onMissing: function () { toast('找不到这个场景'); }
    });
    if (!state.viewer) {
      toast('查看器初始化失败：这台浏览器拿不到 Canvas', 6000);
    }

    try {
      state.gallery = P.createGallery({
        onOpen: openScene,
        onFavChange: refreshAll
      });
    } catch (e) {
      reportOnce(e, '画廊初始化失败了');
    }

    try {
      state.contribute = P.createContribute(uiOpts());
    } catch (e) {
      reportOnce(e, '投稿页初始化失败了');
    }

    state.nav = P.createNav(state.sound);
    var navSoundBtn = $('sound-toggle');
    if (navSoundBtn) navSoundBtn.addEventListener('click', soundToggle);

    /* 首次用户手势：浏览器才允许出声 */
    doc.addEventListener('pointerdown', unlockFromGesture, true);
    doc.addEventListener('keydown', unlockFromGesture, true);

    root.addEventListener('hashchange', handleRoute);

    showView(parseHash().name === 'view' ? 'home' : parseHash().name);
    handleRoute();
    state.ready = true;

    /* 退出前把音量之类的设置落盘（顺手，不做也不影响） */
    root.addEventListener('beforeunload', function () {
      try { P.store.saveSettings({ muted: !!state.sound.state().muted }); } catch (e) {}
    });

    if (root.console && root.console.info) {
      root.console.info('[池核] 场景 ' + P.scenes.length + ' 个 · 音景预设 ' + P.soundPresetNames.length + ' 个 · 本地存储 ' + (P.store.available ? '可用' : '不可用'));
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  P.app = {
    state: state,
    toast: toast,
    open: function (id) { openScene(id); },
    soundToggle: soundToggle,
    refresh: refreshAll
  };

})(window);
