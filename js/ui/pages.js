/* ==========================================================================
   池核 · POOLCORE — 页面装配：首页 / 收藏 / 投稿 / 关于 + 全站导航
   ========================================================================== */

(function (root) {
  'use strict';

  var P = root.POOLCORE = root.POOLCORE || {};
  var doc = root.document;
  function $id(id) { return doc.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ======================================================================
     首页主视觉：一整块水面慢慢转，停手也有生命
     ====================================================================== */

  function startHero(canvas, sceneId) {
    if (!canvas) return null;
    var scene = P.sceneById(sceneId) || P.scenes[0];
    var reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var r = P.createRenderer(canvas, scene, { quality: 420 });
    if (!r) return null;
    var S = r.scene();
    var yaw = S.camera.yaw;
    var timer = 0, heroLast = 0;
    var visible = true;
    var t0 = (root.performance && root.performance.now ? root.performance.now() : Date.now()) / 1000;

    function frame() {
      var now = (root.performance && root.performance.now ? root.performance.now() : Date.now()) / 1000;
      yaw = S.camera.yaw + Math.sin((now - t0) * 0.035) * 0.5;
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (w && h) {
        /* 主视觉在幕布后面，不必满画质：0.4 倍高度、约 12fps 就够，
           省下来的 CPU 留给画廊缩略图与查看器 */
        r.resize(w, h, Math.min(400, Math.max(200, Math.round(h * 0.4))));
        r.render({
          yaw: yaw,
          pitch: -6 * Math.PI / 180 + Math.sin((now - t0) * 0.05) * 0.02,
          fov: 72,
          time: P.frameTime(scene.seed) + (now - t0) * 0.6,
          light: P.store.lightLevel()
        });
      }
    }

    /* 用 rAF 自己计时，而不是 setTimeout：Safari（和 Chrome）对「还没被用户点过」
       的页面的定时器会收紧，主视觉就会一顿一顿甚至停住；rAF 是 canvas 动画的正路 */
    function loop(ts) {
      timer = root.requestAnimationFrame(loop);
      if (!visible || doc.hidden) return;
      if (!heroLast) heroLast = ts;
      if (ts - heroLast < 84) return;          // ~12fps 就够，主视觉不需要 60
      heroLast = ts;
      frame();
    }

    /* paused：查看器打开后由外面按住，避免它被「可见了 / 页面回来了」
       这些回调重新拉起来 —— 主视觉和查看器同时画是纯浪费 CPU */
    var paused = false;
    function start() { if (!timer && !paused) { heroLast = 0; timer = root.requestAnimationFrame(loop); } }
    function stop() { if (timer) { root.cancelAnimationFrame(timer); timer = 0; } }

    if (reduced) frame();
    else {
      start();
      if (root.IntersectionObserver) {
        new root.IntersectionObserver(function (es) {
          visible = es[0].isIntersecting;
          if (visible) start();
          else stop();
        }, { threshold: 0.02 }).observe(canvas);
      }
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden) stop();
        else start();
      });
    }
    root.addEventListener('resize', function () { if (!timer) frame(); });

    return {
      /* start/stop 是「按路由开关」，pause/resume 是「按遮挡开关」：
         两者都要放行才真的画 */
      start: start,
      stop: stop,
      pause: function () { paused = true; stop(); },
      resume: function () { paused = false; start(); },
      destroy: function () { stop(); r.destroy(); }
    };
  }

  /* ======================================================================
     首页：精选 + 数据条
     ====================================================================== */

  var FEATURED = ['indoor-morning', 'indoor-flood', 'night-half', 'abandoned-dry'];

  function renderHome(opts) {
    var grid = $id('featured-grid');
    if (grid && !grid.childNodes.length) {
      var list = [];
      for (var i = 0; i < FEATURED.length; i++) {
        var s = P.sceneById(FEATURED[i]);
        if (s) list.push(s);
      }
      P.renderGrid(grid, list, { onOpen: opts.onOpen, onFav: opts.onFavChange });
    }
    renderStats();
  }

  function renderStats() {
    var box = $id('home-stats');
    if (!box) return;
    var favs = P.store.favoriteIds().length;
    var subs = P.store.submissions().length;
    var items = [
      { n: P.scenes.length, label: '收录场景' },
      { n: P.categories.length - 1, label: '分类' },
      { n: favs, label: '我的收藏' },
      { n: subs, label: '我的投稿' },
      { n: P.scenes.reduce(function (a, s) { return a + (s.tags || []).length; }, 0), label: '标签' }
    ];
    box.innerHTML = '';
    items.forEach(function (it) {
      var d = doc.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<div class="stat-num">' + it.n + '</div><div class="stat-label">' + it.label + '</div>';
      box.appendChild(d);
    });
  }

  /* ======================================================================
     收藏页
     ====================================================================== */

  function renderCollection(opts) {
    var grid = $id('collection-grid');
    var empty = $id('collection-empty');
    var summary = $id('collection-summary');
    var actions = $id('collection-actions');
    if (!grid) return;
    bindCollectionActions(opts);

    var list = P.store.favScenes();
    if (empty) empty.hidden = list.length > 0;
    if (actions) actions.hidden = list.length === 0;

    if (summary) {
      summary.innerHTML = '';
      if (list.length) {
        var byCat = {};
        list.forEach(function (s) { byCat[s.category] = (byCat[s.category] || 0) + 1; });
        var cells = [{ n: list.length, label: '已收藏' }];
        P.categories.forEach(function (c) {
          if (c.id === 'all') return;
          if (byCat[c.id]) cells.push({ n: byCat[c.id], label: c.label });
        });
        cells.push({ n: P.store.available ? '本地' : '本次', label: '存储' });
        cells.forEach(function (c) {
          var d = doc.createElement('div');
          d.className = 'stat';
          d.innerHTML = '<div class="stat-num">' + c.n + '</div><div class="stat-label">' + c.label + '</div>';
          summary.appendChild(d);
        });
      }
    }

    P.renderGrid(grid, list, {
      onOpen: opts.onOpen,
      onFav: function () { renderCollection(opts); if (opts.onFavChange) opts.onFavChange(); },
      onRemove: function (id) {
        P.store.setFav(id, false);
        renderCollection(opts);
        if (opts.onFavChange) opts.onFavChange();
      }
    });
  }

  /* 收藏清单的复制 / 下载 / 清空（绑定一次就够） */
  var collectionBound = false;
  function bindCollectionActions(opts) {
    if (collectionBound) return;
    collectionBound = true;
    var copy = $id('collection-copy');
    var dl = $id('collection-download');
    var clear = $id('collection-clear');

    if (copy) copy.addEventListener('click', function () {
      var text = P.store.favoritesText();
      var done = function () { if (opts.toast) opts.toast('收藏清单已复制'); };
      try {
        if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
          root.navigator.clipboard.writeText(text);
          done();
          return;
        }
      } catch (e) { /* 退回到下载 */ }
      P.store.download('poolcore-收藏清单.txt', text);
      if (opts.toast) opts.toast('这个浏览器不给复制，改成下载文件了');
    });

    if (dl) dl.addEventListener('click', function () {
      P.store.download('poolcore-收藏清单.txt', P.store.favoritesText());
      if (opts.toast) opts.toast('清单已下载');
    });

    if (clear) clear.addEventListener('click', function () {
      if (!P.store.favoriteIds().length) return;
      var ok = root.confirm ? root.confirm('清空全部收藏？这一步不可撤销（不会动你的投稿）。') : true;
      if (!ok) return;
      P.store.setJSON('favorites', []);
      renderCollection(opts);
      if (opts.onFavChange) opts.onFavChange();
      if (opts.toast) opts.toast('收藏已清空');
    });
  }

  /* ======================================================================
     投稿页
     ====================================================================== */

  /* 分类底子：滑块只负责几个参数，其余气质按分类给定 */
  var TEMPLATES = {
    indoor: {
      room: { w: 24, d: 14, h: 4.8 },
      pool: { insetX: 3.0, insetZ: 3.8 },
      water: { level: -0.18, ripple: 0.4 },
      tile: { sat: 0.32, light: 0.8, grout: 0.06 },
      light: { hue: 38, skylight: 0.8, fixtures: 5 },
      fog: { near: 5, far: 30 },
      dirt: 0.12,
      camera: { height: 1.66, pitch: -7 },
      audio: 'indoor-hall'
    },
    outdoor: {
      room: { w: 30, d: 18, h: 3.4 },
      pool: { insetX: 3.2, insetZ: 4.2 },
      water: { level: -0.2, ripple: 0.5 },
      tile: { sat: 0.3, light: 0.86, grout: 0.055 },
      light: { hue: 46, skylight: 1.4, fixtures: 0 },
      fog: { near: 7, far: 44 },
      dirt: 0.1,
      camera: { height: 1.68, pitch: -6 },
      audio: 'outdoor-open'
    },
    night: {
      room: { w: 25, d: 14, h: 4.8 },
      pool: { insetX: 3.2, insetZ: 4.0 },
      water: { level: -0.18, ripple: 0.3 },
      tile: { sat: 0.36, light: 0.62, grout: 0.065 },
      light: { hue: 190, skylight: 0.12, fixtures: 3 },
      fog: { near: 3, far: 22 },
      dirt: 0.18,
      camera: { height: 1.66, pitch: -6 },
      audio: 'night-hum'
    },
    abandoned: {
      room: { w: 23, d: 15, h: 4.5 },
      pool: { insetX: 3.0, insetZ: 3.6 },
      water: { level: -1.1, ripple: 0.14 },
      tile: { sat: 0.2, light: 0.62, grout: 0.09 },
      light: { hue: 42, skylight: 0.4, fixtures: 2 },
      fog: { near: 5, far: 26 },
      dirt: 0.7,
      camera: { height: 1.66, pitch: -12 },
      audio: 'abandoned-drip'
    }
  };

  function hex2(rgb) {
    function h(v) { var s = Math.round(clamp(v, 0, 1) * 255).toString(16); return s.length < 2 ? '0' + s : s; }
    return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
  }

  function buildScene() {
    var cat = ($id('c-cat') || {}).value || 'indoor';
    var t = TEMPLATES[cat] || TEMPLATES.indoor;
    var hue = parseFloat(($id('c-hue') || {}).value || '196');
    var tileSize = parseFloat(($id('c-tilesize') || {}).value || '0.25');
    var level = parseFloat(($id('c-level') || {}).value || '-0.18');   // 水位（池底固定）
    var clarity = parseFloat(($id('c-clarity') || {}).value || '0.7');
    var lightI = parseFloat(($id('c-light') || {}).value || '1');
    var fogD = parseFloat(($id('c-fog') || {}).value || '1');
    var name = (($id('c-name') || {}).value || '').trim();
    var tagsRaw = (($id('c-tags') || {}).value || '').trim();
    var desc = (($id('c-desc') || {}).value || '').trim();
    var tags = tagsRaw ? tagsRaw.split(/[\s,，、]+/).filter(function (s) { return s; }).slice(0, 6) : [];

    var waterColor = hex2(P.util.hsl2rgb(hue - 24, Math.min(0.75, t.tile.sat + 0.28), 0.34 + clarity * 0.16));
    var id = 'mine-' + (name || cat) + '-' + hue + '-' + Math.round(level * 20) + '-' + Math.round(tileSize * 100);

    return {
      id: id,
      name: name || '未命名的池',
      category: cat,
      tags: tags.length ? tags : ['我的投稿'],
      desc: desc || '在投稿页里调出来的一组参数。',
      seed: 1000 + (Math.abs(hashStr(id)) % 8000),
      room: t.room,
      /* 池子只有大小与位置；盆底是渲染器里的标准盆底，深浅全靠水位 */
      pool: { insetX: t.pool.insetX, insetZ: t.pool.insetZ },
      water: { level: level, color: waterColor, clarity: clarity, ripple: t.water.ripple },
      tile: { size: tileSize, hue: hue, sat: t.tile.sat, light: t.tile.light, grout: t.tile.grout },
      light: { intensity: lightI, hue: t.light.hue, skylight: t.light.skylight, fixtures: t.light.fixtures },
      fog: { color: waterColor, near: t.fog.near, far: t.fog.far, density: fogD },
      dirt: t.dirt,
      calm: 3,
      camera: t.camera,
      audio: t.audio,
      mine: true
    };
  }

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h;
  }

  function createContribute(opts) {
    var form = $id('contrib-form');
    var previewCanvas = $id('contrib-preview');
    var frame = previewCanvas ? previewCanvas.parentNode : null;
    var jsonBox = $id('contrib-json');
    var metaBox = $id('contrib-meta');
    var mineGrid = $id('contrib-mine');
    var countEl = $id('contrib-count');
    if (!form || !previewCanvas) return null;

    var renderer = null;
    var look = { yaw: 0, pitch: -7 * Math.PI / 180, fov: 70 };
    var debTimer = 0;
    var current = null;

    function paint() {
      if (!current) return;
      if (!renderer) renderer = P.createRenderer(previewCanvas, current, { quality: 240 });
      else renderer.setScene(current);
      var w = previewCanvas.clientWidth || 480;
      var h = previewCanvas.clientHeight || 270;
      renderer.resize(w, h, Math.min(260, Math.max(160, Math.round(h * 0.7))));
      var S = renderer.scene();
      if (!look.init) {
        look.yaw = S.camera.yaw;
        look.pitch = S.camera.pitch;
        look.init = true;
      }
      renderer.render({ yaw: look.yaw, pitch: look.pitch, fov: look.fov, time: P.frameTime(current.seed), light: P.store.lightLevel() });
      if (metaBox && S.metrics) {
        var m = S.metrics;
        metaBox.innerHTML =
          '<div><b>' + m.poolW.toFixed(1) + '×' + m.poolD.toFixed(1) + '</b><span>池子 米</span></div>' +
          '<div><b>' + m.waterDepth.toFixed(2) + '</b><span>水深 米</span></div>' +
          '<div><b>' + m.lanes + '</b><span>泳道</span></div>';
      }
    }

    function rebuild(immediate) {
      if (debTimer) { root.clearTimeout(debTimer); debTimer = 0; }
      var run = function () {
        debTimer = 0;
        current = buildScene();
        look.init = false;
        paint();
        if (jsonBox) jsonBox.textContent = JSON.stringify(current, function (k, v) {
          return (typeof v === 'number' && !isFinite(v)) ? 0 : v;
        }, 2);
        syncOutputs();
      };
      if (immediate) run();
      else debTimer = root.setTimeout(run, 60);
    }

    /* 滑块的数值回显 */
    function syncOutputs() {
      var pairs = [
        ['c-hue', 'c-hue-out', function (v) { return v + '°'; }],
        ['c-tilesize', 'c-tilesize-out', function (v) { return v.toFixed(2) + 'm'; }],
        ['c-level', 'c-level-out', function (v) {
          return (v > 0 ? '+' : '') + v.toFixed(2) + 'm';
        }],
        ['c-clarity', 'c-clarity-out', function (v) { return Math.round(v * 100) + '%'; }],
        ['c-light', 'c-light-out', function (v) { return v.toFixed(2); }],
        ['c-fog', 'c-fog-out', function (v) { return v.toFixed(2); }]
      ];
      pairs.forEach(function (p) {
        var i = $id(p[0]), o = $id(p[1]);
        if (i && o) o.textContent = p[2](parseFloat(i.value));
      });
    }

    /* 表单里所有会改变画面的东西 */
    var live = form.querySelectorAll('input[type="range"], select, input[type="text"], textarea');
    Array.prototype.forEach.call(live, function (el) {
      el.addEventListener('input', function () { rebuild(el.type === 'range'); });
      el.addEventListener('change', function () { rebuild(true); });
    });

    /* 换类别时把「水位」滑条带到该类模板的水位上 —— 模板里的半淹/废弃
       本来就是靠水位说的，不跟着动的话选了废弃池还是满池水 */
    var catSel = $id('c-cat');
    if (catSel) catSel.addEventListener('change', function () {
      var t2 = TEMPLATES[catSel.value];
      var lv = $id('c-level');
      if (t2 && lv && t2.water && t2.water.level != null) lv.value = t2.water.level;
      syncOutputs();
      rebuild(true);
    });

    /* 预览里也能拖动环视 */
    if (frame) {
      var p = null;
      frame.addEventListener('pointerdown', function (e) {
        p = { x: e.clientX, y: e.clientY };
        try { frame.setPointerCapture(e.pointerId); } catch (err) {}
        if (e.preventDefault) e.preventDefault();
      });
      frame.addEventListener('pointermove', function (e) {
        if (!p) return;
        var dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        look.yaw -= dx * 0.004;
        look.pitch = clamp(look.pitch + dy * 0.0035, -0.6, 0.6);
        paint();
      });
      frame.addEventListener('pointerup', function () { p = null; });
      frame.addEventListener('pointercancel', function () { p = null; });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var s = buildScene();
      if (!(($id('c-name') || {}).value || '').trim()) {
        if (opts.toast) opts.toast('先给它起个名字吧');
        var n = $id('c-name');
        if (n) n.focus();
        return;
      }
      P.store.addSubmission(s);
      renderMine();
      if (opts.toast) opts.toast('已收进「我的投稿」，只存在你自己的浏览器里');
      if (opts.onFavChange) opts.onFavChange();
    });

    var copyBtn = $id('contrib-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () { copyJson(buildScene()); });

    var dlBtn = $id('contrib-download');
    if (dlBtn) dlBtn.addEventListener('click', function () {
      var s = buildScene();
      P.store.download('poolcore-' + s.id + '.json', JSON.stringify(s, null, 2), 'application/json;charset=utf-8');
    });

    var randBtn = $id('contrib-random');
    if (randBtn) randBtn.addEventListener('click', function () {
      var rnd = function (a, b) { return a + Math.random() * (b - a); };
      var setv = function (id, v) { var el = $id(id); if (el) el.value = v; };
      setv('c-hue', Math.round(rnd(150, 260)));
      setv('c-tilesize', rnd(0.12, 0.5).toFixed(2));
      setv('c-level', rnd(-2.2, 0.3).toFixed(2));
      setv('c-clarity', rnd(0.2, 0.95).toFixed(2));
      setv('c-light', rnd(0.4, 1.5).toFixed(2));
      setv('c-fog', rnd(0.3, 1.5).toFixed(2));
      rebuild(true);
      if (opts.toast) opts.toast('换了一组参数');
    });

    var resetBtn = $id('contrib-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      var setv = function (id, v) { var el = $id(id); if (el) el.value = v; };
      setv('c-hue', 196); setv('c-tilesize', '0.25'); setv('c-level', '-0.18');
      setv('c-clarity', '0.7'); setv('c-light', '1'); setv('c-fog', '1');
      var n = $id('c-name'); if (n) n.value = '';
      var tg = $id('c-tags'); if (tg) tg.value = '';
      var ds = $id('c-desc'); if (ds) ds.value = '';
      rebuild(true);
    });

    function copyJson(s) {
      var text = JSON.stringify(s, null, 2);
      try {
        if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
          root.navigator.clipboard.writeText(text);
          if (opts.toast) opts.toast('已复制场景数据');
          return;
        }
      } catch (e) { /* 落到下面 */ }
      /* file:// 下剪贴板 API 常常不可用：退回到选中让用户自己复制 */
      if (jsonBox) {
        var range = doc.createRange();
        range.selectNodeContents(jsonBox);
        var sel = root.getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(range); }
        if (opts.toast) opts.toast('已选中，按 ⌘/Ctrl + C 复制');
      }
    }

    function renderMine() {
      var list = P.store.submissions();
      if (countEl) countEl.textContent = list.length;
      if (!mineGrid) return;
      mineGrid.innerHTML = '';
      if (!list.length) {
        var p = doc.createElement('p');
        p.className = 'empty-note';
        p.textContent = '还没有投稿。上面调好参数、起个名字，按「收进我的投稿」就会出现在这里。';
        mineGrid.appendChild(p);
        return;
      }
      P.renderGrid(mineGrid, list, {
        onOpen: opts.onOpen,
        onFav: function () { if (opts.onFavChange) opts.onFavChange(); },
        onRemove: function (id) {
          P.store.removeSubmission(id);
          renderMine();
          if (opts.onFavChange) opts.onFavChange();
        }
      });
    }

    rebuild(true);
    renderMine();

    return {
      rebuild: function () { rebuild(true); },
      refreshMine: renderMine,
      paint: paint
    };
  }

  /* ======================================================================
     导航：抽屉、声音开关、回到顶部
     ====================================================================== */

  function createNav(sound) {
    var toggle = $id('nav-toggle');
    var drawer = $id('nav-drawer');
    var soundBtn = $id('sound-toggle');
    var soundLabel = $id('sound-toggle-label');
    var toTop = $id('to-top');

    if (toggle && drawer) {
      toggle.addEventListener('click', function () {
        var open = drawer.hidden;
        drawer.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      Array.prototype.forEach.call(drawer.querySelectorAll('a'), function (a) {
        a.addEventListener('click', function () {
          drawer.hidden = true;
          toggle.setAttribute('aria-expanded', 'false');
        });
      });
    }
    if (toTop) {
      toTop.addEventListener('click', function () {
        root.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    function sync() {
      if (!soundBtn || !sound) return;
      var st = sound.state();
      var on = st.unlocked && !st.muted;
      soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      var use = soundBtn.querySelector('use');
      if (use) use.setAttribute('href', on ? '#i-sound' : '#i-mute');
      if (soundLabel) {
        soundLabel.textContent = !st.supported ? '声音不可用'
          : (!st.unlocked ? '点击开启声音' : (st.muted ? '声音 · 关' : '声音 · 开'));
      }
    }

    /* 声音开关的点击行为统一由 app 层处理（要落盘设置），这里只负责同步外观 */
    sync();
    return { sync: sync };
  }

  /* ======================================================================
     关于页里的小数字（收录声明）
     ====================================================================== */

  function renderAbout() {
    var el = $id('about-counts');
    if (!el) return;
    var favs = P.store.favoriteIds().length;
    el.innerHTML =
      '<div class="stat"><div class="stat-num">' + P.scenes.length + '</div><div class="stat-label">收录场景</div></div>' +
      '<div class="stat"><div class="stat-num">0</div><div class="stat-label">图片素材</div></div>' +
      '<div class="stat"><div class="stat-num">0</div><div class="stat-label">音频文件</div></div>' +
      '<div class="stat"><div class="stat-num">' + favs + '</div><div class="stat-label">我的收藏</div></div>';
  }

  P.startHero = startHero;
  P.renderHome = renderHome;
  P.renderStats = renderStats;
  P.renderCollection = renderCollection;
  P.createContribute = createContribute;
  P.createNav = createNav;
  P.renderAbout = renderAbout;
  P.buildScene = buildScene;
  P.TEMPLATES = TEMPLATES;

})(window);
