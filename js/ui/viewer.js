/* ==========================================================================
   池核 · POOLCORE — 360 查看器
   --------------------------------------------------------------------------
   · 按住拖动 = 抓着画面走：左右无限环绕，上下低头看水 / 抬头看天窗
   · 松手有惯性，停下来之后水面继续慢慢晃（12fps，便宜）
   · 滚轮 / 双指缩放视野，键盘方向键也能看
   · 按需渲染：画面不动就不花 CPU；交互时按实测耗时自动选分辨率，
     既不糊也不卡；一停手立刻补一帧所选画质
   ========================================================================== */

(function (root) {
  'use strict';

  var P = root.POOLCORE = root.POOLCORE || {};
  var doc = root.document;
  var DEG = Math.PI / 180, RAD = 180 / Math.PI;
  var MAX_PITCH = 34 * DEG;         // 池核要的是平视与低头，不做全向翻转
  /* 交互时的分辨率不再写死成 240p（那样在 2K 屏上会糊成一团），
     改为按实测每帧耗时自动伸缩：
       像素数 ∝ 分辨率²，所以用 √(预算/实测) 缩放，一步就能找到合适的分辨率；
       高清帧的耗时又反过来告诉我们这台机器在预算内能画多清楚。
     参考（真浏览器、无 GPU）：360p ≈ 15ms、540p ≈ 34ms、720p ≈ 60ms。 */
  /* 手感优先。渲染是逐像素的、与分辨率严格成正比，所以「清晰度」只能用
     「每帧时间」换。以前交互预算给到 50ms（≈20fps），拖动时明显一顿一顿；
     现在压到 26ms（≈38fps）：像素数 ∝ 分辨率²，分辨率会自己退到 450~500p，
     一松手立刻补回所选画质 —— 动着的时候眼睛在追画面，退那点分辨率看不出来。 */
  var DRAG_TARGET_MS = 20;          // 交互时的每帧预算（落地约 30fps，留出抖动余量）
  var DRAG_MIN = 300;               // 交互分辨率下限：再低就明显糊了
  /* 停手后水面动画的节奏：按实耗自适应。
     固定 130ms（7.5fps）在「1.2 秒一个起伏」的水面上只有 9 帧，看着就是一跳一跳的；
     现在往 60fps 顶，但每帧画完都知道自己花了多少毫秒，不够快就自动退 ——
     慢机器上最差也有 ~9fps，不会变成幻灯片。 */
  var IDLE_MIN_MS = 16;             // 最快 60fps（rAF 一拍）
  var IDLE_MAX_MS = 100;            // 最慢 10fps
  var IDLE_SLOW_MS = 140;           // 「省电」档：约 7fps，水还在动，只是慢
  var IDLE_ROW = 0.45;              // 动画只重画下半屏，天花板与墙不用重算
  var REFINE_MS = 190;              // 拖动 / 缩放停下多久后补一帧高清
  var KEY_REFINE_MS = 320;          // 方向键：按住连按时不补，真松手才补
  var QUALITIES = [360, 540, 720];
  var READOUT_MS = 160;             // 读数面板刷新间隔（拖动时别每帧都改 DOM）

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function $id(id) { return doc.getElementById(id); }
  function wrapYaw(y) {              // 归到 (-π, π]，用于最短路径
    while (y > Math.PI) y -= Math.PI * 2;
    while (y <= -Math.PI) y += Math.PI * 2;
    return y;
  }

  P.createViewer = function (opts) {
    opts = opts || {};
    var sound = opts.sound || null;
    var onChange = opts.onChange || function () {};
    var reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

    var el = {
      root: $id('viewer'),
      canvas: $id('viewer-canvas'),
      loading: $id('viewer-loading'),
      title: $id('viewer-title'),
      cat: $id('viewer-cat'),
      hint: $id('viewer-hint'),
      sound: $id('viewer-sound'),
      soundLabel: $id('viewer-sound-label'),
      quality: $id('viewer-quality'),
      qualityLabel: $id('viewer-quality-label'),
      prev: $id('viewer-prev'),
      next: $id('viewer-next'),
      fav: $id('viewer-fav'),
      favLabel: $id('viewer-fav-label'),
      full: $id('viewer-full'),
      info: $id('viewer-info'),
      light: $id('viewer-light'),
      lightOut: $id('viewer-light-out'),
      close: $id('viewer-close'),
      drawer: $id('viewer-drawer'),
      drawerHandle: $id('viewer-drawer-handle'),
      drawerTitle: $id('drawer-title'),
      drawerMeta: $id('drawer-meta'),
      drawerDesc: $id('drawer-desc'),
      drawerTags: $id('drawer-tags'),
      drawerHotspots: $id('drawer-hotspots'),
      anim: $id('anim-toggle'),
      readout: $id('drawer-readout'),
      toast: $id('viewer-toast')
    };
    if (!el.root || !el.canvas) return null;

    var renderer = null, scene = null, compiled = null;
    var cam = { yaw: 0, pitch: -6 * DEG, fov: 62, time: 0, light: 1, x: null, z: null, height: null };
    var quality = 540;
    var isOpen = false;
    var dragging = false;
    var pinching = false;
    var pointers = {};
    var nPointers = 0;
    var dragFrom = null;
    var pinch = null;
    var vYaw = 0, vPitch = 0;
    /* 前后移动（↑↓ / W S）：视角只交给 ←→ 与鼠标，↑↓ 改成在池子里前后走 */
    var walkDir = 0, walkV = 0, walkRaf = 0, walkLast = 0;
    /* 竖直方向：站高 / 落水 / 沉浮。cam.height 是「眼睛离池沿地面的高度」，
       站在岸上等于站高，沉到池底就是 池底 + 站高（负的） */
    var STAND_H = 1.66;
    var vert = { vy: 0, space: false, splashed: false };
    var dragH = 540;                  // 交互时的内部渲染高度（会自适应）
    var rafPending = 0, wantFull = false;
    var vRaf = 0;
    var refineTimer = 0;
    var idleTimer = 0, idleLast = 0, idleStep = 60, idleSlow = false;
    var lightLevel = 1;                // 光照强度（1 = 场景原样）
    var lightActive = false;           // 正在拉光照滑条
    var waterRows = null;              // 上一整帧里「真的有水」的行范围
    var hintGone = false;
    var tween = 0;
    var toastTimer = 0;
    var timeOffset = 0;
    var lastQualityUsed = 0;
    var store = P.store;

    /* ---------------- 渲染调度 ---------------- */

    function draw(cap, rows) {
      if (!isOpen || !renderer) return null;
      var w = el.canvas.clientWidth || el.root.clientWidth;
      var h = el.canvas.clientHeight || el.root.clientHeight;
      if (!w || !h) return null;
      renderer.resize(w, h, cap);
      cam.time = timeOffset + ((root.performance && root.performance.now ? root.performance.now() : Date.now()) / 1000);
      var st = renderer.render(cam, rows ? { rows: rows } : null);
      lastQualityUsed = cap;
      /* 整帧时记下渲染器报的「真的有水的行范围」，空闲动画只重画这一段。
         只在整帧更新：局部重画时那个范围只是子集，拿它当依据会让下一帧越缩越小 */
      if (!rows && st && st.wy1 > st.wy0) waterRows = [st.wy0, st.wy1];
      updateReadout(st);
      /* 保险丝：查看器开着、没在拖、没在惯性或转场、动画循环却没在跑 ——
         那就立刻拉起来。任何一条路径把它漏掉（切场景 / 全屏 / 手势中断 /
         定时器被浏览器节流……），下一帧都会被这一次检查抓回来。
         定时器那份（setInterval）就是漏在这里：一旦被节流或漏掉，
         表现就是「只有拽着才动」。 */
      if (!dragging && !lightActive && !idleTimer && !vRaf && !tween &&
        vYaw * vYaw + vPitch * vPitch < 1e-7) startIdle();
      return st;
    }

    /* 交互分辨率必须落在 [下限, 所选画质] 之间 */
    function clampDragH() {
      if (dragH > quality) dragH = quality;
      if (dragH < DRAG_MIN) dragH = DRAG_MIN;
      return dragH;
    }

    function dragCap() {
      return clampDragH();
    }

    /* 高清帧的耗时：这台机器在这张画面上花多少钱。
       按平方根换算成「预算内能画到多清楚」，下次一开口拖动就已经是对的分辨率。 */
    function seedDragH(st) {
      if (!st || !(st.ms > 0)) return;
      dragH = Math.round(quality * clamp(Math.sqrt(DRAG_TARGET_MS / st.ms), 0.5, 1));
      clampDragH();
    }

    /* 交互帧实测：像素数 ∝ 分辨率²，所以按平方根缩放；夹住幅度、留死区，免得来回抖 */
    function tuneDrag(st) {
      if (!st || !(st.ms > 0)) return;
      var k = Math.sqrt(DRAG_TARGET_MS / st.ms);
      if (k > 0.92 && k < 1.08) return;          // 已经在预算附近，不动
      dragH = Math.round(dragH * clamp(k, 0.7, 1.3));
      clampDragH();
    }

    function requestRender(full) {
      if (full) wantFull = true;
      if (rafPending) return;
      rafPending = root.requestAnimationFrame(function () {
        rafPending = 0;
        var isFull = wantFull;
        wantFull = false;
        var st = draw(isFull ? quality : dragCap());
        if (isFull) seedDragH(st);
        else tuneDrag(st);
      });
    }

    /* 说完话就补高清：拖动停下 / 键盘不再按 / 滚轮停了，都走这里 */
    function refineSoon(delay) {
      if (refineTimer) root.clearTimeout(refineTimer);
      refineTimer = root.setTimeout(function () {
        refineTimer = 0;
        if (!isOpen || vRaf || rafPending) return;   // 还在惯性滑行就等它自己收尾
        requestRender(true);
        startIdle();
      }, delay || REFINE_MS);
    }

    function idleRows() {
      var h = renderer && renderer.size ? renderer.size().h : 0;
      if (!h) return null;
      /* 在水下：整屏都在动（水把池壁和池底都在揉），没有「只重画水面那几行」
         这回事 —— 局部重画的话，瓷砖会一动不动，看着就是一潭死水 */
      if (cam.height != null && compiled && compiled.water && cam.height < compiled.water.y - 0.01) return null;
      /* 优先只重画「上一整帧里真的有水」的那几行（上下各留 2 行余量）：
         水面通常只占屏高的一半，比固定重画下半屏省一半以上，帧率就上得去 */
      if (waterRows) {
        var a = Math.max(0, waterRows[0] - 2), b = Math.min(h, waterRows[1] + 3);
        if (b - a >= 8) return [a, b];
      }
      return [Math.round(h * IDLE_ROW), h];
    }

    /* 空闲动画用 requestAnimationFrame 自己计时，而不是 setInterval：
       浏览器对 setInterval 有各种节流（后台、被遮挡、省电模式），定时器被掐掉
       就会变成「动一两秒然后不动了」；rAF 只在页面真的不可见时才停，
       而且页面不可见时我们本来就不该画 */
    /* 闲置帧的内部分辨率：最高 450p。拖动/补高清仍用完整画质 */
    function idleQuality() {
      return quality > 450 ? 450 : quality;
    }

    function idleFrame(ts) {
      idleTimer = root.requestAnimationFrame(idleFrame);
      if (!isOpen || doc.hidden || dragging) { idleLast = ts; return; }
      if (ts - idleLast < idleStep) return;
      idleLast = ts;
      /* 闲置动画用「降一档的内部分辨率」+ 只重画水面那半屏：
         水一直在动，内部分辨率低一点根本看不出来，但帧时间能省三成上下 ——
         全画质画闲置帧，水一重就要 60~70ms，帧率掉到 10fps 左右，看起来就是卡。
         静止时照旧用全画质补高清（refineSoon 那条路不变），所以截图/细看不受影响。
         只有上一帧就是同一档分辨率时才能局部重画，否则上半屏是空的，
         得整帧重画一次。 */
      var iq = idleQuality();
      var st = draw(iq, lastQualityUsed === iq ? idleRows() : null);
      /* 按这一帧的实耗定下一帧的间隔：刚够画完 + 一点余量，
         于是快机器跑满 30fps、慢机器自动拉开，不会是固定的一跳一跳 */
      if (st && st.ms > 0) {
        var step = st.ms * 1.05 + 1.5;
        idleStep = step < IDLE_MIN_MS ? IDLE_MIN_MS : (step > IDLE_MAX_MS ? IDLE_MAX_MS : step);
      }
      /* 「省电」档：水照样在动，只是闲置刷新压到 ~7fps。
         以前这一档是「彻底不画」—— 于是停下脚步水面就是一潭死水，
         只有走动时才有帧、才显得水在动（用户报的就是这个） */
      if (idleSlow && idleStep < IDLE_SLOW_MS) idleStep = IDLE_SLOW_MS;
    }

    function startIdle() {
      if (idleTimer || reduced || !isOpen) return;
      /* 动效开关不再等于「冻结」：关掉只是省电（见 idleFrame 末尾） */
      idleSlow = !store.settings().animate;
      if (!compiled || compiled.water.ripple < 0.05) return;
      idleLast = (root.performance && root.performance.now ? root.performance.now() : Date.now());
      idleTimer = root.requestAnimationFrame(idleFrame);
    }

    function stopIdle() {
      if (idleTimer) { root.cancelAnimationFrame(idleTimer); idleTimer = 0; }
    }

    /* ---------------- 惯性 ---------------- */

    function inertiaFrame() {
      vRaf = 0;
      if (!isOpen || dragging) return;
      cam.yaw += vYaw;
      cam.pitch = clamp(cam.pitch + vPitch, -MAX_PITCH, MAX_PITCH);
      vYaw *= 0.93;
      vPitch *= 0.90;
      requestRender(false);
      if (Math.abs(vYaw) > 2e-4 || Math.abs(vPitch) > 2e-4) {
        vRaf = root.requestAnimationFrame(inertiaFrame);
      } else {
        vYaw = vPitch = 0;
        requestRender(true);
        startIdle();
      }
    }

    function flick() {
      if (reduced || Math.abs(vYaw) < 1e-4 && Math.abs(vPitch) < 1e-4) {
        requestRender(true);
        startIdle();
        return;
      }
      if (!vRaf) vRaf = root.requestAnimationFrame(inertiaFrame);
    }

    /* ---------------- 前后移动（↑↓ / W S）----------------
       视角只交给 ←→ 与鼠标；↑↓ 改成在池子里前后走。
       位移写在世界坐标里（cam.x / cam.z），带加减速 —— 松手滑一小段停住，
       不是一按一顿。方向只取水平的 (sin yaw, -cos yaw)：俯仰不改变前进方向，
       像人走路那样，抬头低头不影响你往哪走 */
    function clampCam() {
      var rm = compiled && compiled.room;
      if (!rm || cam.x == null) return;
      /* 留半米边距，别把眼睛贴到墙上 */
      var mx = (rm.halfW || rm.w * 0.5) - 0.5;
      var mz = (rm.halfD || rm.d * 0.5) - 0.5;
      if (cam.x < -mx) cam.x = -mx; else if (cam.x > mx) cam.x = mx;
      if (cam.z < -mz) cam.z = -mz; else if (cam.z > mz) cam.z = mz;
    }

    /* ---------------- 水：落水 / 上浮 / 沉底 ---------------- */

    function waterY() { return compiled ? compiled.water.y : -0.18; }
    function poolFloorY() { return compiled ? -compiled.pool.depth : -2.2; }
    function standHeight() { return (compiled && compiled.camera.height) || STAND_H; }

    function inPoolAt(x, z, m) {
      var p = compiled && compiled.pool;
      if (!p || x == null || z == null) return false;
      m = m || 0;
      return x > p.x0 + m && x < p.x1 - m && z > p.z0 + m && z < p.z1 - m;
    }

    /* 沉在水里时池壁就是墙：横着穿不出去。浮到水面以后才允许扒着池沿爬上来 */
    function clampInPool() {
      var p = compiled && compiled.pool;
      if (!p) return;
      var m = 0.32;
      if (cam.x < p.x0 + m) cam.x = p.x0 + m; else if (cam.x > p.x1 - m) cam.x = p.x1 - m;
      if (cam.z < p.z0 + m) cam.z = p.z0 + m; else if (cam.z > p.z1 - m) cam.z = p.z1 - m;
    }

    /* 一帧的竖直运动。返回 true = 还没稳定，主循环得接着跑 */
    function stepVertical(dt) {
      if (!compiled || cam.x == null) return false;
      var stand = standHeight();
      var wY = waterY(), floorY = poolFloorY();
      if (cam.height == null) cam.height = stand;

      if (!inPoolAt(cam.x, cam.z)) {
        /* 岸上：站直。刚从水里爬上来的那一下，眼睛从这个插值抬回站高 */
        vert.vy = 0;
        vert.splashed = false;
        var d = stand - cam.height;
        if (Math.abs(d) < 0.004) { cam.height = stand; return false; }
        cam.height += d * Math.min(1, dt * 8);
        if (Math.abs(stand - cam.height) < 0.004) cam.height = stand;
        return true;
      }

      var feet = cam.height - stand;
      if (feet > wY + 0.002) {
        /* 脚还在水面之上：自由落体。入水那一下速度砍掉大半 —— 水会接住你，
           不然会直接砸到池底（那种「啪」一下到底，反而没有掉进水里的感觉） */
        vert.vy -= 9.8 * 1.6 * dt;
        cam.height += vert.vy * dt;
        /* 干池（水位在池底以下）：踩到池底就站住，别一路穿过去 */
        if (cam.height - stand <= floorY) {
          cam.height = floorY + stand;
          vert.vy = 0;
          return false;
        }
        if (cam.height - stand <= wY) {
          vert.vy *= 0.2;
          if (!vert.splashed) {
            vert.splashed = true;
            showToast('掉水里了 · 按住空格浮起来');
          }
        }
        return true;
      }

      /* 已经在水里：按住空格往上浮，松开就一直沉到池底 */
      if (vert.space) vert.vy += 9.2 * dt;        // 蹬水
      else vert.vy -= 5.4 * dt;                    // 自重
      vert.vy *= Math.exp(-3.2 * dt);              // 水的阻力，越快越明显
      cam.height += vert.vy * dt;

      var top = wY + 0.62;                         // 浮在水面：头露在水上
      var bot = floorY + stand - 0.04;             // 沉到底：脚踩池底
      if (cam.height > top) { cam.height = top; if (vert.vy > 0) vert.vy = 0; }
      else if (cam.height < bot) { cam.height = bot; if (vert.vy < 0) vert.vy = 0; }

      if (Math.abs(vert.vy) < 0.045 &&
        ((cam.height <= bot + 0.02 && !vert.space) || (cam.height >= top - 0.02 && vert.space))) {
        cam.height = cam.height <= bot + 0.02 ? bot : top;
        vert.vy = 0;
        return false;
      }
      return true;
    }

    function walkFrame(ts) {
      walkRaf = 0;
      if (!isOpen || cam.x == null) { walkDir = 0; walkV = 0; walkLast = 0; return; }
      var dt = walkLast ? (ts - walkLast) / 1000 : 0.016;
      if (dt > 0.1) dt = 0.1;                    // 掉帧别一步跨太远（但别夹太小，否则慢机器上走路会变成爬）
      walkLast = ts;
      /* 巡航速度：前进 2.4 m/s、后退 1.6 m/s；用指数趋近，起停都不突。
         松手时用更快的衰减，滑出半米左右停下 */
      var stand = standHeight();
      var submerged = inPoolAt(cam.x, cam.z) && cam.height != null && cam.height - stand <= waterY() + 0.002;
      var want = walkDir > 0 ? 2.4 : (walkDir < 0 ? -1.6 : 0);
      if (submerged) want *= 0.6;                 // 水里走不快，划水而已
      var rate = walkDir === 0 ? 0.0008 : 0.06;
      walkV += (want - walkV) * (1 - Math.pow(rate, dt));

      if (walkV !== 0) {
        var wasInPool = inPoolAt(cam.x, cam.z);
        cam.x += Math.sin(cam.yaw) * walkV * dt;
        cam.z -= Math.cos(cam.yaw) * walkV * dt;
        clampCam();
        /* 沉在水里时池壁挡着，浮到水面才爬得出去。
           干池不封边 —— 那里没有浮力，封死就再也上不来了；
           走出去时 stepVertical 会把眼睛平滑抬回站高，看起来就是爬出池子 */
        if (wasInPool && cam.height != null && cam.height < waterY() - 0.15) clampInPool();
      }

      var rising = stepVertical(dt);

      if (walkDir === 0 && Math.abs(walkV) < 0.03 && !rising) {
        walkV = 0; walkLast = 0;
        requestRender(true);
        refineSoon(KEY_REFINE_MS);
        startIdle();
        return;
      }
      requestRender(false);
      walkRaf = root.requestAnimationFrame(walkFrame);
    }

    function startWalk() {
      stopIdle();
      hideHint();
      if (!walkRaf) walkRaf = root.requestAnimationFrame(walkFrame);
    }

    /* dir：1 前进 / -1 后退 */
    function walkKey(dir, down) {
      if (down) { walkDir = dir; startWalk(); }
      else if (walkDir === dir) walkDir = 0;
    }

    function stopWalk() {
      if (walkRaf) { root.cancelAnimationFrame(walkRaf); walkRaf = 0; }
      walkDir = 0; walkV = 0; walkLast = 0;
    }

    /* ---------------- 指针交互 ---------------- */

    function pdist() {
      var ks = Object.keys(pointers);
      if (ks.length < 2) return 0;
      var a = pointers[ks[0]], b = pointers[ks[1]];
      var dx = a.x - b.x, dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function unlockSound() {
      if (!sound) return;
      var st = sound.state();
      if (!st.unlocked && st.supported) {
        sound.unlock();
        sound.setMuted(!!store.settings().muted);   // 拖动不该覆盖用户自己的静音选择
        syncSoundButton();
        onChange();
      }
    }

    function onDown(e) {
      if (!isOpen) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { el.canvas.setPointerCapture(e.pointerId); } catch (err) {}
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      nPointers = Object.keys(pointers).length;
      stopIdle();
      if (refineTimer) { root.clearTimeout(refineTimer); refineTimer = 0; }
      if (tween) { root.cancelAnimationFrame(tween); tween = 0; }
      if (nPointers === 1) {
        dragging = true;
        dragFrom = { x: e.clientX, y: e.clientY };
        vYaw = 0; vPitch = 0;
        el.canvas.classList.add('is-dragging');
        hideHint();
        unlockSound();
      } else if (nPointers >= 2) {
        dragging = false;
        pinching = true;
        pinch = { d: pdist(), fov: cam.fov };
      }
      if (e.preventDefault) e.preventDefault();
    }

    function onMove(e) {
      var p = pointers[e.pointerId];
      if (!p || !isOpen) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;

      if (pinching && nPointers >= 2) {
        var d = pdist();
        if (pinch && pinch.d > 12 && d > 12) setFov(pinch.fov * (pinch.d / d));
        requestRender(false);
        refineSoon();
        if (e.preventDefault) e.preventDefault();
        return;
      }
      if (!dragging || !dragFrom) return;
      var sens = 0.0031 * (cam.fov / 62);
      var dYaw = -dx * sens;                   // 抓着画面走：往右拖 = 视角往左转
      var dPitch = dy * sens * 0.85;
      cam.yaw += dYaw;
      cam.pitch = clamp(cam.pitch + dPitch, -MAX_PITCH, MAX_PITCH);
      vYaw = vYaw * 0.55 + dYaw * 0.45;
      vPitch = vPitch * 0.55 + dPitch * 0.45;
      requestRender(false);
      /* 手按着不动的时候也别一直糊着：停一小会儿就补一帧高清 */
      refineSoon();
      if (e.preventDefault) e.preventDefault();
    }

    function onUp(e) {
      if (!pointers[e.pointerId]) return;
      delete pointers[e.pointerId];
      nPointers = Object.keys(pointers).length;
      if (nPointers < 2) pinching = false;
      if (nPointers === 0) {
        dragging = false;
        dragFrom = null;
        el.canvas.classList.remove('is-dragging');
        flick();
      }
    }

    function onWheel(e) {
      if (!isOpen) return;
      if (e.preventDefault) e.preventDefault();
      var step = (e.deltaY > 0 ? 4.5 : -4.5) * (cam.fov / 62);
      setFov(cam.fov + step);
      stopIdle();
      requestRender(false);
      refineSoon();
    }

    function setFov(f) {
      cam.fov = clamp(f, 28, 100);
      updateReadout(null);
    }

    /* ---------------- 键盘 ---------------- */

    function onKey(e) {
      if (!isOpen) return;
      var tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      var kk = e.key, lk = kk.length === 1 ? kk.toLowerCase() : kk;
      /* ↑↓ / W S：前后移动。视角回给 ←→ 与鼠标 —— 俯仰用鼠标拖（或点热区）就够了 */
      if (lk === 'w' || kk === 'ArrowUp') {
        if (e.preventDefault) e.preventDefault();
        walkKey(1, true);
        return;
      }
      if (lk === 's' || kk === 'ArrowDown') {
        if (e.preventDefault) e.preventDefault();
        walkKey(-1, true);
        return;
      }
      /* 空格：在水里按住就浮起来，松开就往下沉。岸上按没反应，
         但也拦掉默认动作（否则页面会被翻下去） */
      if (kk === ' ' || kk === 'Spacebar' || kk === 'Space') {
        if (e.preventDefault) e.preventDefault();
        if (!vert.space) { vert.space = true; startWalk(); }
        return;
      }
      var step = (e.shiftKey ? 1.2 : 3.4) * DEG;
      var handled = true;
      switch (e.key) {
        case 'ArrowLeft': cam.yaw -= step; break;
        case 'ArrowRight': cam.yaw += step; break;
        case '+': case '=': setFov(cam.fov - 3); break;
        case '-': case '_': setFov(cam.fov + 3); break;
        case 'Escape':
          if (el.drawer && !el.drawer.hidden) { toggleDrawer(false); return; }
          close();
          return;
        case 'f': case 'F': toggleFull(); return;
        case 'm': case 'M': toggleSound(); return;
        case 'i': case 'I': toggleDrawer(); return;
        case 'PageUp': case '[': if (opts.cycle) opts.cycle(-1); return;
        case 'PageDown': case ']': if (opts.cycle) opts.cycle(1); return;
        default: handled = false;
      }
      if (handled) {
        if (e.preventDefault) e.preventDefault();
        hideHint();
        stopIdle();
        requestRender(false);
        /* 松开方向键就回高清。延迟要大于「连按的间隔」，否则会和降分辨率
           来回翻，画面忽清忽糊 —— 那是比糊更难受的东西 */
        refineSoon(KEY_REFINE_MS);
      }
    }

    /* ---------------- 界面 ---------------- */

    function hideHint() {
      if (hintGone || !el.hint) return;
      hintGone = true;
      el.hint.classList.add('is-gone');
      root.setTimeout(function () { if (el.hint) el.hint.hidden = true; }, 600);
    }

    function showToast(msg) {
      if (!el.toast) return;
      el.toast.textContent = msg;
      el.toast.hidden = false;
      if (toastTimer) root.clearTimeout(toastTimer);
      toastTimer = root.setTimeout(function () { el.toast.hidden = true; }, 1800);
    }

    /* 「人在哪」—— 岸上 / 正在掉下去 / 浮在水面 / 沉到水下几米 */
    function bodyLine() {
      if (cam.height == null) return '身体  站在岸上';
      if (!inPoolAt(cam.x, cam.z)) return '身体  站在岸上';
      var stand = standHeight(), wY = waterY();
      var feet = cam.height - stand;
      var floorY = poolFloorY();
      /* 干池：没有水可沉，落到池底就是站住 */
      if (!(compiled.metrics.waterDepth > 0.02)) {
        return feet <= floorY + 0.06 ? '身体  站在干池底' : '身体  正在下落';
      }
      if (feet > wY + 0.002) return '身体  正在下落';
      /* 浮在水面时脚还在水面下一米多（人本来就是半沉半浮），
         所以这里按「眼睛离水面多高」判，而不是按脚 */
      if (cam.height >= wY + 0.5) return '身体  浮在水面（按住空格）';
      return '身体  水下 ' + (wY - feet).toFixed(1) + ' m' + (vert.space ? ' · 上浮中' : ' · 下沉中');
    }

    var readoutAt = 0;
    function updateReadout(st) {
      if (!el.readout || !compiled) return;
      /* 抽屉关着时没人看这些数字：连字符串都不用拼。
         开着的时候也只 6 次/秒 —— 拖动时每帧改一次多行 textContent，
         光排版就能吃掉好几毫秒，那可是实打实的帧时间 */
      if (el.drawer && el.drawer.hidden) return;
      var nowMs = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
      if (nowMs - readoutAt < READOUT_MS) return;
      readoutAt = nowMs;
      var m = compiled.metrics;
      var lines = [
        '大厅  ' + m.roomW.toFixed(0) + ' × ' + m.roomD.toFixed(0) + ' × ' + m.roomH.toFixed(1) + ' m',
        '池子  ' + m.poolW.toFixed(1) + ' × ' + m.poolD.toFixed(1) + ' m ／ 深 ' + m.depth.toFixed(1) + ' m',
        '水深  ' + m.waterDepth.toFixed(2) + ' m · 泳道 ' + m.lanes + ' 条',
        '灯具  ' + m.fixtures + ' 组 · 天窗 ' + m.skyFormat,
        bodyLine(),
        '视线  yaw ' + Math.round(wrapYaw(cam.yaw) * RAD) + '°  pitch ' + Math.round(cam.pitch * RAD) + '°  fov ' + Math.round(cam.fov) + '°',
        '位置  ' + (cam.x == null ? '场景默认' : ('x ' + cam.x.toFixed(1) + ' m  z ' + cam.z.toFixed(1) + ' m（↑↓ 前后走）')),
        '渲染  ' + Math.round(quality) + 'p（本次 ' + (lastQualityUsed || 0) + 'p）' + (st && st.ms ? ' · ' + st.ms.toFixed(1) + ' ms' : '')
      ];
      el.readout.textContent = lines.join('\n');
    }

    function syncSoundButton() {
      if (!sound) return;
      var st = sound.state();
      var on = st.unlocked && !st.muted;
      if (el.sound) {
        el.sound.setAttribute('aria-pressed', on ? 'true' : 'false');
        var use = el.sound.querySelector('use');
        if (use) use.setAttribute('href', on ? '#i-sound' : '#i-mute');
      }
      if (el.soundLabel) {
        el.soundLabel.textContent = !st.supported ? '声音不可用' : (!st.unlocked ? '点击开启声音' : (st.muted ? '声音 · 关' : '声音 · 开'));
      }
    }

    function toggleSound() {
      if (!sound) return;
      var st = sound.state();
      if (!st.supported) { showToast('这个浏览器拿不到音频上下文'); return; }
      if (!st.unlocked) {
        sound.unlock();
        sound.setMuted(false);
      } else {
        sound.setMuted(!st.muted);
      }
      store.saveSettings({ muted: !!sound.state().muted });
      syncSoundButton();
      onChange();
      showToast(sound.state().muted ? '已静音' : '环境音已开');
    }

    function syncFavButton() {
      if (!scene) return;
      var on = store.isFav(scene.id);
      if (el.fav) el.fav.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (el.favLabel) el.favLabel.textContent = on ? '已收藏' : '收藏';
    }

    function toggleFav() {
      if (!scene) return;
      store.toggleFav(scene.id);
      syncFavButton();
      showToast(store.isFav(scene.id) ? '已收进我的收藏' : '已取消收藏');
      onChange();
    }

    function toggleDrawer(force) {
      if (!el.drawer) return;
      var show = force == null ? el.drawer.hidden : force;
      el.drawer.hidden = !show;
      if (el.info) el.info.setAttribute('aria-expanded', show ? 'true' : 'false');
      if (show) { readoutAt = 0; requestRender(false); }
    }

    function toggleFull() {
      try {
        var d = doc;
        if (!d.fullscreenElement && !d.webkitFullscreenElement) {
          var fn = el.root.requestFullscreen || el.root.webkitRequestFullscreen;
          if (fn) fn.call(el.root);
          else showToast('这个浏览器不支持全屏');
        } else {
          var xf = d.exitFullscreen || d.webkitExitFullscreen;
          if (xf) xf.call(d);
        }
      } catch (e) {
        showToast('全屏没成功');
      }
    }

    /* 光照强度：滑条改的是 cam.light，渲染器在出像素那一刻整幅缩放。
       拉的过程中走交互分辨率（跟手），松手补一帧满画质 */
    function syncLight() {
      lightLevel = store.lightLevel();
      cam.light = lightLevel;
      var pct = Math.round(lightLevel * 100);
      if (el.light) el.light.value = String(pct);
      if (el.lightOut) el.lightOut.textContent = pct + '%';
    }

    function setLight(pct) {
      lightLevel = clamp(pct / 100, 0.3, 1.5);
      cam.light = lightLevel;
      if (el.lightOut) el.lightOut.textContent = Math.round(lightLevel * 100) + '%';
      store.saveSettings({ light: lightLevel });
    }

    function syncAnimButton() {
      if (!el.anim) return;
      var on = !!store.settings().animate && !reduced;
      el.anim.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.anim.classList.toggle('is-active', on);
      el.anim.textContent = reduced ? '系统已关闭' : (on ? '流畅' : '省电');
    }

    function toggleAnim() {
      if (reduced) { showToast('系统设置了「减少动态」，这里就先不动'); return; }
      var on = !store.settings().animate;
      store.saveSettings({ animate: on });
      syncAnimButton();
      idleSlow = !on;
      /* 「省电」不再掐掉闲置动画：水永远在动，这一档只是把帧率压到 ~7fps */
      if (on) showToast('水面动效：流畅');
      else showToast('水面动效：省电（水还是在晃，只是慢一点）');
      startIdle();
    }

    function syncQualityButton() {
      if (el.qualityLabel) el.qualityLabel.textContent = '画质 ' + quality + 'p';
    }

    function cycleQuality() {
      var i = QUALITIES.indexOf(quality);
      quality = QUALITIES[(i + 1) % QUALITIES.length];
      clampDragH();
      store.saveSettings({ quality: quality });
      syncQualityButton();
      requestRender(true);
      showToast('画质 ' + quality + 'p');
    }

    /* 热区：平滑转向 */
    function lookAt(yaw, pitch) {
      var from = cam.yaw, to = from + wrapYaw(yaw - from);
      var p0 = cam.pitch, t0 = clamp(pitch, -MAX_PITCH, MAX_PITCH);
      var tstart = 0;
      var dur = reduced ? 1 : 520;
      stopIdle();
      if (tween) root.cancelAnimationFrame(tween);
      function step(ts) {
        if (!tstart) tstart = ts;
        var k = dur <= 1 ? 1 : Math.min(1, (ts - tstart) / dur);
        var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOutQuad
        cam.yaw = from + (to - from) * e;
        cam.pitch = p0 + (t0 - p0) * e;
        requestRender(false);
        if (k < 1) tween = root.requestAnimationFrame(step);
        else { tween = 0; requestRender(true); startIdle(); }
      }
      tween = root.requestAnimationFrame(step);
    }

    /* ---------------- 打开 / 关闭 ---------------- */

    function findScene(id) {
      return P.sceneById ? (P.sceneById(id) || (store.findSubmission && store.findSubmission(id))) : null;
    }

    function open(id) {
      var s = findScene(id);
      if (!s) { if (opts.onMissing) opts.onMissing(id); return; }
      var settings = store.settings();
      quality = settings.quality || 540;
      clampDragH();
      syncQualityButton();
      syncAnimButton();
      syncLight();

      scene = s;
      renderer = P.createRenderer(el.canvas, scene, { quality: quality });
      if (!renderer) {
        el.root.hidden = true;
        if (opts.onError) opts.onError('这个浏览器画不出 Canvas 2D 画面');
        return;
      }
      compiled = renderer.scene();
      compiled.metrics.skyFormat = compiled.light.skylight > 0.05 ? compiled.light.skylight.toFixed(2) : '无';

      cam.yaw = compiled.camera.yaw;
      cam.pitch = compiled.camera.pitch;
      cam.fov = 62;
      cam.x = compiled.camera.x;
      cam.z = compiled.camera.z;
      cam.height = compiled.camera.height;
      walkDir = 0; walkV = 0; walkLast = 0;
      vert.vy = 0; vert.space = false; vert.splashed = false;
      timeOffset = P.frameTime(scene.seed || 1);
      vYaw = vPitch = 0;
      hintGone = false;

      el.root.hidden = false;
      doc.body.classList.add('is-viewing');
      isOpen = true;

      if (el.loading) { el.loading.hidden = false; el.loading.classList.remove('is-gone'); }
      if (el.hint) { el.hint.hidden = false; el.hint.classList.remove('is-gone'); }
      if (el.title) el.title.textContent = scene.name || '';
      if (el.cat) el.cat.textContent = P.categoryLabel(scene.category);
      if (el.drawerTitle) el.drawerTitle.textContent = scene.name || '';
      if (el.drawerMeta) {
        el.drawerMeta.textContent = P.categoryLabel(scene.category) +
          (scene.mine ? ' · 我的投稿' : '') + ' · ' + (scene.tags || []).join(' / ');
      }
      if (el.drawerDesc) el.drawerDesc.textContent = scene.desc || '';
      if (el.drawerTags) {
        el.drawerTags.innerHTML = '';
        var tags = scene.tags || [];
        for (var i = 0; i < tags.length; i++) {
          var sp = doc.createElement('span');
          sp.className = 'tag';
          sp.textContent = tags[i];
          el.drawerTags.appendChild(sp);
        }
      }
      if (el.drawerHotspots) {
        el.drawerHotspots.innerHTML = '';
        (compiled.hotspots || []).forEach(function (h) {
          var b = doc.createElement('button');
          b.type = 'button';
          b.className = 'hotspot';
          b.textContent = h.label;
          b.addEventListener('click', function () {
            lookAt(compiled.camera.yaw + wrapYaw(h.yaw - compiled.camera.yaw), h.pitch * DEG);
          });
          el.drawerHotspots.appendChild(b);
        });
      }
      toggleDrawer(false);

      if (sound) {
        sound.setScene(scene.audio || 'indoor-hall');
        syncSoundButton();
      }
      syncFavButton();

      /* 首帧画完再撤遮罩 */
      requestRender(true);
      root.setTimeout(function () {
        if (!isOpen) return;
        draw(quality);
        if (el.loading) {
          el.loading.classList.add('is-gone');
          root.setTimeout(function () { if (el.loading) el.loading.hidden = true; }, 420);
        }
        startIdle();
      }, 90);

      try { el.root.focus({ preventScroll: true }); } catch (e) { el.root.focus(); }
      onChange();
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      stopIdle();
      if (refineTimer) { root.clearTimeout(refineTimer); refineTimer = 0; }
      if (rafPending) { root.cancelAnimationFrame(rafPending); rafPending = 0; }
      if (vRaf) { root.cancelAnimationFrame(vRaf); vRaf = 0; }
      if (tween) { root.cancelAnimationFrame(tween); tween = 0; }
      stopWalk();
      dragging = false; pinching = false;
      pointers = {}; nPointers = 0;
      el.root.hidden = true;
      doc.body.classList.remove('is-viewing');
      if (renderer) { renderer.destroy(); renderer = null; }
      compiled = null;
      scene = null;
      onChange();
      if (opts.onClose) opts.onClose();
    }

    function cycle(dir) {
      if (!scene) return;
      var list = P.scenes;
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === scene.id) idx = i;
      if (idx < 0) { open(list[0].id); return; }
      var n = (idx + dir + list.length) % list.length;
      open(list[n].id);
    }

    /* ---------------- 绑定 ---------------- */

    el.canvas.addEventListener('pointerdown', onDown);
    el.canvas.addEventListener('pointermove', onMove);
    el.canvas.addEventListener('pointerup', onUp);
    el.canvas.addEventListener('pointercancel', onUp);
    el.canvas.addEventListener('lostpointercapture', onUp);
    el.canvas.addEventListener('wheel', onWheel, { passive: false });
    el.canvas.addEventListener('dblclick', function (e) { e.preventDefault(); toggleFull(); });
    el.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    /* 松键与失焦：按住走路必须能停 —— 窗口切走时更要停，
       否则回来会发现自己一直在往前走 */
    function onKeyUp(e) {
      if (!isOpen) return;
      var kk = e.key, lk = kk.length === 1 ? kk.toLowerCase() : kk;
      if (lk === 'w' || kk === 'ArrowUp') walkKey(1, false);
      else if (lk === 's' || kk === 'ArrowDown') walkKey(-1, false);
      else if (kk === ' ' || kk === 'Spacebar' || kk === 'Space') {
        /* 松手：浮力消失，人开始往下沉 */
        vert.space = false;
        startWalk();
      }
    }
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('keyup', onKeyUp);
    root.addEventListener('blur', function () { walkDir = 0; vert.space = false; });
    if (el.close) el.close.addEventListener('click', close);
    if (el.prev) el.prev.addEventListener('click', function () { cycle(-1); });
    if (el.next) el.next.addEventListener('click', function () { cycle(1); });
    if (el.fav) el.fav.addEventListener('click', toggleFav);
    if (el.full) el.full.addEventListener('click', toggleFull);
    if (el.info) el.info.addEventListener('click', function () { toggleDrawer(); });
    if (el.quality) el.quality.addEventListener('click', cycleQuality);
    if (el.light) {
      /* 拉动过程用交互分辨率（跟手），松手再补一帧满画质 */
      el.light.addEventListener('input', function () {
        hideHint();
        stopIdle();
        lightActive = true;
        setLight(parseFloat(el.light.value) || 100);
        requestRender(false);
      });
      el.light.addEventListener('change', function () {
        lightActive = false;
        setLight(parseFloat(el.light.value) || 100);
        requestRender(true);
        startIdle();
      });
    }
    if (el.anim) el.anim.addEventListener('click', toggleAnim);
    if (el.sound) el.sound.addEventListener('click', toggleSound);
    if (el.drawerHandle) el.drawerHandle.addEventListener('click', function () { toggleDrawer(false); });

    var resizeTimer = 0;
    root.addEventListener('resize', function () {
      if (!isOpen) return;
      if (resizeTimer) root.clearTimeout(resizeTimer);
      resizeTimer = root.setTimeout(function () { requestRender(true); startIdle(); }, 120);
    });
    doc.addEventListener('visibilitychange', function () {
      if (doc.hidden) stopIdle();
      else if (isOpen) { requestRender(true); startIdle(); }
    });

    return {
      open: open,
      close: close,
      cycle: cycle,
      isOpen: function () { return isOpen; },
      currentId: function () { return scene ? scene.id : null; },
      current: function () { return scene; },
      quality: function () { return quality; },
      setQuality: function (q) { quality = q; syncQualityButton(); requestRender(true); },
      syncSound: syncSoundButton,
      syncFav: syncFavButton,
      toast: showToast,
      scene: function () { return compiled; }
    };
  };

})(window);
