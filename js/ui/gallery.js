/* ==========================================================================
   池核 · POOLCORE — 画廊：卡片、缩略图、筛选、搜索
   --------------------------------------------------------------------------
   缩略图是真渲染：每个卡片用同一套渲染器画一帧低分辨率画面（同一 seed 永远同一帧）。
   渲染是串行的（一次只建一个渲染器，画完就销毁），不占内存也不卡首屏。
   ========================================================================== */

(function (root) {
  'use strict';

  var P = root.POOLCORE = root.POOLCORE || {};
  var doc = root.document;
  var CAT_ICON = { indoor: '室内', outdoor: '户外', night: '夜', abandoned: '废弃' };

  /* ---------------- 缩略图 ---------------- */

  var thumbQueue = [];
  var thumbRunning = false;

  function scheduleThumb(canvas, scene) {
    thumbQueue.push({ canvas: canvas, scene: scene });
    if (!thumbRunning) {
      thumbRunning = true;
      root.setTimeout(runThumb, 16);
    }
  }

  function runThumb() {
    var job = thumbQueue.shift();
    if (!job) { thumbRunning = false; return; }
    paintThumb(job.canvas, job.scene);
    if (thumbQueue.length) root.setTimeout(runThumb, 24);
    else thumbRunning = false;
  }

  function paintThumb(canvas, scene) {
    var w = canvas.clientWidth || 320;
    var h = canvas.clientHeight || Math.round(w * 9 / 16);
    var r = P.createRenderer(canvas, scene, { quality: 150 });
    if (!r) return;
    r.resize(w, h, Math.min(180, Math.max(110, Math.round(h * 1.4))));
    var S = r.scene();
    /* 缩略图不要把视线压得太低：稍微抬起来一点，看得到墙与天花板 */
    r.render({
      yaw: S.camera.yaw + 0.1,
      pitch: -5 * Math.PI / 180,
      fov: 74,
      time: P.frameTime(scene.seed || 1),
      light: P.store.lightLevel()
    });
    r.destroy();
  }

  /* ---------------- 卡片 ---------------- */

  function makeCard(scene, opts) {
    opts = opts || {};
    var fav = P.store.isFav(scene.id);
    var card = doc.createElement('article');
    card.className = 'card';
    card.setAttribute('data-id', scene.id);

    var thumb = doc.createElement('div');
    thumb.className = 'card-thumb';
    var cv = doc.createElement('canvas');
    thumb.appendChild(cv);

    var cat = doc.createElement('span');
    cat.className = 'card-cat mono';
    cat.textContent = P.categoryLabel(scene.category);
    thumb.appendChild(cat);

    if (scene.mine) {
      var badge = doc.createElement('span');
      badge.className = 'card-badge';
      badge.textContent = '我的投稿';
      thumb.appendChild(badge);
    }
    card.appendChild(thumb);

    var body = doc.createElement('div');
    body.className = 'card-body';

    var h = doc.createElement('h3');
    h.className = 'card-title';
    h.textContent = scene.name;
    body.appendChild(h);

    var d = doc.createElement('p');
    d.className = 'card-desc';
    d.textContent = scene.desc || '';
    body.appendChild(d);

    if (scene.tags && scene.tags.length) {
      var row = doc.createElement('div');
      row.className = 'tagrow';
      for (var i = 0; i < scene.tags.length && i < 4; i++) {
        var t = doc.createElement('span');
        t.className = 'tag';
        t.textContent = scene.tags[i];
        row.appendChild(t);
      }
      body.appendChild(row);
    }

    var actions = doc.createElement('div');
    actions.className = 'card-actions';

    var enter = doc.createElement('button');
    enter.type = 'button';
    enter.className = 'btn btn-primary';
    enter.innerHTML = '进入场景<svg class="ico" aria-hidden="true"><use href="#i-enter"></use></svg>';
    enter.addEventListener('click', function (e) {
      e.stopPropagation();
      if (opts.onOpen) opts.onOpen(scene.id);
    });
    actions.appendChild(enter);

    var favBtn = doc.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'fav-btn';
    favBtn.setAttribute('aria-pressed', fav ? 'true' : 'false');
    favBtn.setAttribute('aria-label', fav ? '取消收藏' : '收藏');
    favBtn.title = fav ? '取消收藏' : '收藏';
    favBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-heart"></use></svg>';
    favBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      P.store.toggleFav(scene.id);
      var on = P.store.isFav(scene.id);
      favBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      favBtn.setAttribute('aria-label', on ? '取消收藏' : '收藏');
      if (opts.onFav) opts.onFav(scene.id, on);
    });
    actions.appendChild(favBtn);

    if (opts.onRemove) {
      var rm = doc.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn-ghost btn-mini';
      rm.textContent = '移除';
      rm.addEventListener('click', function (e) {
        e.stopPropagation();
        opts.onRemove(scene.id);
      });
      actions.appendChild(rm);
    }

    body.appendChild(actions);
    card.appendChild(body);

    /* 直接用卡片上的指针来点缩略图也能进 */
    thumb.addEventListener('click', function () { if (opts.onOpen) opts.onOpen(scene.id); });
    /* 悬停视差：真渲染太贵，用位移装作镜头在动 */
    thumb.addEventListener('pointermove', function (ev) {
      var r = thumb.getBoundingClientRect();
      var kx = (ev.clientX - r.left) / r.width - 0.5;
      var ky = (ev.clientY - r.top) / r.height - 0.5;
      cv.style.transform = 'scale(1.06) translate(' + (-kx * 10).toFixed(1) + 'px,' + (-ky * 7).toFixed(1) + 'px)';
    });
    thumb.addEventListener('pointerleave', function () { cv.style.transform = ''; });

    scheduleThumb(cv, scene);
    return card;
  }

  /* ---------------- 网格 ---------------- */

  function renderGrid(container, scenes, opts) {
    if (!container) return;
    container.innerHTML = '';
    if (!scenes.length) return;
    var frag = doc.createDocumentFragment();
    for (var i = 0; i < scenes.length; i++) frag.appendChild(makeCard(scenes[i], opts));
    container.appendChild(frag);
  }

  /* ---------------- 画廊页 ---------------- */

  function createGallery(opts) {
    opts = opts || {};
    var elGrid = doc.getElementById('gallery-grid');
    var elChips = doc.getElementById('gallery-chips');
    var elSearch = doc.getElementById('gallery-search');
    var elSort = doc.getElementById('gallery-sort');
    var elTags = doc.getElementById('gallery-tags');
    var elEmpty = doc.getElementById('gallery-empty');
    var elCount = doc.getElementById('gallery-count');
    var elReset = doc.getElementById('gallery-reset');

    var state = { cat: 'all', q: '', tag: '', sort: 'default' };

    function buildChips() {
      if (!elChips || elChips.childNodes.length) return;
      P.categories.forEach(function (c) {
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'chip' + (c.id === state.cat ? ' is-active' : '');
        b.setAttribute('data-cat', c.id);
        var n = c.id === 'all' ? P.scenes.length : P.scenes.filter(function (s) { return s.category === c.id; }).length;
        b.innerHTML = c.label + '<span class="mono">' + n + '</span>';
        b.addEventListener('click', function () {
          state.cat = c.id;
          Array.prototype.forEach.call(elChips.children, function (ch) {
            ch.classList.toggle('is-active', ch.getAttribute('data-cat') === c.id);
          });
          apply();
        });
        elChips.appendChild(b);
      });
    }

    function buildTags() {
      if (!elTags || elTags.childNodes.length) return;
      /* 标签一共几十个，全摆出来会把画廊顶下去：按出现次数取前 16 个 */
      var freq = {};
      P.scenes.forEach(function (s) {
        (s.tags || []).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
      });
      var tags = Object.keys(freq).sort(function (a, b) {
        return freq[b] - freq[a] || a.localeCompare(b, 'zh-Hans-CN');
      }).slice(0, 16);
      for (var i = 0; i < tags.length; i++) {
        (function (tg) {
          var b = doc.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = '#' + tg;
          b.addEventListener('click', function () {
            state.tag = state.tag === tg ? '' : tg;
            Array.prototype.forEach.call(elTags.children, function (c) {
              c.classList.toggle('is-active', c.textContent === '#' + state.tag);
            });
            apply();
          });
          elTags.appendChild(b);
        })(tags[i]);
      }
    }

    function match(s) {
      if (state.cat !== 'all' && s.category !== state.cat) return false;
      if (state.tag && (s.tags || []).indexOf(state.tag) < 0) return false;
      if (!state.q) return true;
      var q = state.q.toLowerCase();
      var hay = (s.name + ' ' + (s.desc || '') + ' ' + (s.tags || []).join(' ') + ' ' + P.categoryLabel(s.category)).toLowerCase();
      return hay.indexOf(q) >= 0;
    }

    function apply() {
      var list = P.scenes.filter(match);
      list = P.sortScenes(list, state.sort);
      renderGrid(elGrid, list, {
        onOpen: opts.onOpen,
        onFav: function () { if (opts.onFavChange) opts.onFavChange(); }
      });
      if (elEmpty) elEmpty.hidden = list.length > 0;
      if (elCount) elCount.textContent = list.length;
    }

    if (elSearch) {
      elSearch.addEventListener('input', function () {
        state.q = elSearch.value.trim();
        apply();
      });
    }
    if (elSort) {
      elSort.addEventListener('change', function () {
        state.sort = elSort.value;
        apply();
      });
    }
    if (elReset) {
      elReset.addEventListener('click', function () {
        state = { cat: 'all', q: '', tag: '', sort: 'default' };
        if (elSearch) elSearch.value = '';
        if (elSort) elSort.value = 'default';
        if (elChips) Array.prototype.forEach.call(elChips.children, function (c) {
          c.classList.toggle('is-active', c.getAttribute('data-cat') === 'all');
        });
        if (elTags) Array.prototype.forEach.call(elTags.children, function (c) { c.classList.remove('is-active'); });
        apply();
      });
    }

    return {
      render: function () {
        buildChips();
        buildTags();
        apply();
      },
      refresh: apply
    };
  }

  P.makeCard = makeCard;
  P.renderGrid = renderGrid;
  P.paintThumb = paintThumb;
  P.createGallery = createGallery;
  P.CAT_ICON = CAT_ICON;

})(window);
