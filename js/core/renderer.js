/* ==========================================================================
   池核 · POOLCORE — Canvas 2D 第一人称渲染器
   --------------------------------------------------------------------------
   思路：
     · 房间是一个轴对齐的盒子，池子是从池沿往下挖的一个矩形盆。
     · 每列投一条射线，先算出它撞房间四壁的距离（列常量），
       再按行算出它撞各个水平面（池沿 y=0 / 水面 / 池底 / 天花板）的距离（行常量）。
     · 谁近画谁：天花板 / 墙 / 池沿地面 / 水面 / 池底 / 池内壁。
     · 水面是「透 + 反」：透的是池底瓷砖被水吃掉一部分，反的是把天花板灯管的
       亮度镜像采回来 —— 于是水里的灯是晃的，边上还有一层焦散网纹。
   相机：{ x, z, height, yaw, pitch, fov, time }，yaw 取模 = 无限环绕。
   ========================================================================== */

(function (root) {
  'use strict';

  var POOLCORE = root.POOLCORE = root.POOLCORE || {};
  var DEG = Math.PI / 180;

  /* ---------------- 小工具 ---------------- */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function mixv(a, b, t) { return a + (b - a) * t; }

  /* 正弦查表：热路径里 fsin 比 Math.sin 便宜得多 */
  var SIN_N = 512, SIN_MASK = SIN_N - 1, SIN_K = SIN_N / (Math.PI * 2);
  var SIN = new Float32Array(SIN_N);
  for (var s0 = 0; s0 < SIN_N; s0++) SIN[s0] = Math.sin(s0 / SIN_N * Math.PI * 2);
  function fsin(x) { return SIN[((x * SIN_K) | 0) & SIN_MASK]; }

  function hexRGB(hex) {
    if (typeof hex !== 'string') return [0.5, 0.5, 0.5];
    var s = hex.charAt(0) === '#' ? hex.slice(1) : hex;
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    var n = parseInt(s, 16);
    if (isNaN(n)) return [0.5, 0.5, 0.5];
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    if (s <= 0.0001) return [l, l, l];
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    function cc(t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [cc(h + 1 / 3), cc(h), cc(h - 1 / 3)];
  }

  /* 泳道线间距（米）的倒数：池底逐像素要用，先算好 */
  var INV_LANE = 1 / 2.2;

  /* 所有池子共用的标准盆底（米）。现实里池子的深浅差在池底，但这里要的是
     「同一个池子，不同的水量」——所以池底固定，深浅交给水位去说。
     儿童 / 戏水池是另一个池子，用场景里的 pool.bottom 把盆底抬高。 */
  var POOL_BOTTOM = 2.2;

  /* 水面波的整体时间缩放：1 = 真实秒。**想放慢/加快波动只改这一个数** ——
     ω 仍是色散关系 ω=√(g·k) 给的，所以「短波快、长波慢」的相对关系不变，
     相当于把整池水一起放慢/加快，不会变成另一种水。
     0.55 时静止看几乎看不出水在动（实测两帧平均只差 5 个灰阶），
     0.75 大约是「一秒能看出水纹挪了一格」的节奏，又还没到急促 */
  var WAVE_SPEED = 0.75;

  /* 池底照度总系数。白瓷砖 + 强天光时池底会整片顶到 255（一片纯青、砖缝都没了），
     压掉一成半之后暗部层次回来，水纹推着砖缝走也更看得出来。
     只作用于池底，墙和天花板不动 —— 这里要的是「池底没那么炸」 */
  var FLOOR_LIGHT = 0.86;

  /* 每块砖的稳定随机值：同一个格子永远同一个数，换场景换 seed */
  function tileHash(a, b, seed) {
    var h = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(seed | 0, 83492791);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  }

  /* 平滑的二维值噪声（0~1），双线性 + smoothstep：天空的云用它，
     比正弦叠加更像云 */
  function vnoise(x, y, seed) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var tx = x - ix, ty = y - iy;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    var a = tileHash(ix, iy, seed), b = tileHash(ix + 1, iy, seed);
    var c = tileHash(ix, iy + 1, seed), d = tileHash(ix + 1, iy + 1, seed);
    var u0 = a + (b - a) * tx, u1 = c + (d - c) * tx;
    return u0 + (u1 - u0) * ty;
  }

  /* 污渍。以前是「每块砖各自掷一次骰子、随机变暗」—— 那画出来是一颗颗
     孤立的黑砖，看着像噪点不像脏。改成粗格值噪声双线性插值：脏成一片一片
     的形状，边缘还是平滑过渡的。
     cellX / cellY 是噪声格子的边长（米）：墙上把 Y 拉大，脏就顺墙往下淌。 */
  function dirtAt(x, y, seed, cellX, cellY, amount) {
    var fx = x / cellX, fy = y / cellY;
    var ix = Math.floor(fx), iy = Math.floor(fy);
    var tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    var a = tileHash(ix, iy, seed), b = tileHash(ix + 1, iy, seed);
    var c = tileHash(ix, iy + 1, seed), d = tileHash(ix + 1, iy + 1, seed);
    var u0 = a + (b - a) * tx, u1 = c + (d - c) * tx;
    var n = u0 + (u1 - u0) * ty;
    var k = (0.62 - n) / 0.62;           // 噪声低于阈值的地方才脏
    if (k <= 0) return 1;
    if (k > 1) k = 1;
    return 1 - amount * k * k * 0.55;
  }

  /* 网格双线性采样（光照贴图 / 天花板反光贴图共用） */
  function gridAt(g, x, z) {
    var fx = (x - g.x0) * g.invW, fz = (z - g.z0) * g.invD;
    var ax = g.gw - 1.001, az = g.gh - 1.001;
    if (fx < 0) fx = 0; else if (fx > ax) fx = ax;
    if (fz < 0) fz = 0; else if (fz > az) fz = az;
    var ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    var i0 = iz * g.gw + ix, i1 = i0 + 1, i2 = i0 + g.gw, i3 = i2 + 1;
    var a = g.data;
    return (a[i0] * (1 - tx) + a[i1] * tx) * (1 - tz) + (a[i2] * (1 - tx) + a[i3] * tx) * tz;
  }

  function boxBlur(g, passes) {
    var w = g.gw, h = g.gh, a = g.data, tmp = new Float32Array(a.length);
    for (var p = 0; p < passes; p++) {
      var x, y, i;
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          var l = x > 0 ? a[i - 1] : a[i], r = x < w - 1 ? a[i + 1] : a[i];
          tmp[i] = (l + a[i] * 2 + r) * 0.25;
        }
      }
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          var u = y > 0 ? tmp[i - w] : tmp[i], d = y < h - 1 ? tmp[i + w] : tmp[i];
          a[i] = (u + tmp[i] * 2 + d) * 0.25;
        }
      }
    }
    return g;
  }

  /* 0-9 的 3×5 点阵：画在泳道端墙上 */
  var GLYPH = [
    [0x7, 0x5, 0x5, 0x5, 0x7], [0x2, 0x6, 0x2, 0x2, 0x7], [0x7, 0x1, 0x7, 0x4, 0x7],
    [0x7, 0x1, 0x7, 0x1, 0x7], [0x5, 0x5, 0x7, 0x1, 0x1], [0x7, 0x4, 0x7, 0x1, 0x7],
    [0x7, 0x4, 0x7, 0x5, 0x7], [0x7, 0x1, 0x2, 0x2, 0x2], [0x7, 0x5, 0x7, 0x5, 0x7],
    [0x7, 0x5, 0x7, 0x1, 0x7]
  ];
  function glyphBit(d, col, row) {
    if (d < 0 || d > 9) d = 0;
    return (GLYPH[d][row] >> (2 - col)) & 1;
  }

  /* ======================================================================
     把一份场景数据编译成渲染器直接能吃的形式
     （几何、调色板、光照贴图、默认站位、热区）
     ====================================================================== */

  /* ========================================================================
     道具：把场景里的 props 展开成解析基本体
     只有三种形状，都能和射线用一元二次方程直接求交：
       0 竖圆柱     —— 蘑菇立柱、垂下来的水帘、梯子与支撑杆
       1 椭球顶     —— 蘑菇伞的伞面（上半椭球 + 平的伞底圆盘）
       2 平行四边形 —— 滑道面、两侧挡板、平台、横档
     每个基本体在 F 里占固定长度，B 记起始下标；BND 是包围圆柱（逐列预筛用），
     SH 是「伞底下那一圈阴影」的贴地圆盘。
     ======================================================================== */
  function buildProps(list, ctx) {
    var F = [], T = [], B = [], BND = [], SH = [], WET = [];
    var DEPTH = ctx.depth, WATER = ctx.waterY;

    function push(type, v) { T.push(type); B.push(F.length); for (var i = 0; i < v.length; i++) F.push(v[i]); }
    /* wet = 这个基本体有沉在水面以下的部分：它要多跑一趟「透过水看」的搜索 */
    function bnd(cx, cz, r, y0, y1) { BND.push(cx, cz, r, y0, y1); WET.push(y0 < WATER - 0.02 ? 1 : 0); }
    function cyl(x, z, r, y0, y1, mode, c) {
      push(0, [x, z, r, y0, y1, mode, c[0], c[1], c[2]]);
      bnd(x, z, r, y0, y1);
    }
    function dome(x, y, z, rx, ry, rz, mode, c) {
      push(1, [x, y, z, rx, ry, rz, mode, c[0], c[1], c[2]]);
      bnd(x, z, rx > rz ? rx : rz, y - ry, y + ry);
    }
    /* a→b 是长边，a→d 是短边（c = b + d - a）。同时预存 u/v 的投影轴，
       逐像素时只需两次点乘 + 两次比较就能判断是否落在平行四边形内 */
    function quad(a, b, c, d, mode, col) {
      var e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
      var e2x = d[0] - a[0], e2y = d[1] - a[1], e2z = d[2] - a[2];
      var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-9) return;
      nx /= nl; ny /= nl; nz /= nl;
      var uAx = e2y * nz - e2z * ny, uAy = e2z * nx - e2x * nz, uAz = e2x * ny - e2y * nx;
      var vAx = e1y * nz - e1z * ny, vAy = e1z * nx - e1x * nz, vAz = e1x * ny - e1y * nx;
      var du = e1x * uAx + e1y * uAy + e1z * uAz;
      var dv = e2x * vAx + e2y * vAy + e2z * vAz;
      if (du === 0 || dv === 0) return;
      push(2, [a[0], a[1], a[2], nx, ny, nz, uAx, uAy, uAz, 1 / du, vAx, vAy, vAz, 1 / dv,
        mode, col[0], col[1], col[2]]);
      var mx = (a[0] + c[0]) * 0.5, mz = (a[2] + c[2]) * 0.5, rr = 0, i, q;
      for (i = 0; i < 4; i++) {
        q = i === 0 ? a : (i === 1 ? b : (i === 2 ? c : d));
        var ddx = q[0] - mx, ddz = q[2] - mz, dd = ddx * ddx + ddz * ddz;
        if (dd > rr) rr = dd;
      }
      bnd(mx, mz, Math.sqrt(rr) + 0.03,
        Math.min(a[1], b[1], c[1], d[1]), Math.max(a[1], b[1], c[1], d[1]));
    }

    var lx0 = ctx.limX, lz0 = ctx.limZ, i, p, chuteC, sideC, metalC;
    for (i = 0; i < (list || []).length; i++) {
      p = list[i];
      if (!p || !p.type) continue;
      var px = clamp(p.x == null ? 0 : p.x, -lx0, lx0);
      var pz = clamp(p.z == null ? 0 : p.z, -lz0, lz0);

      if (p.type === 'mushroom') {
        var mr = clamp(p.capR == null ? 1.2 : p.capR, 0.5, 2.4);
        var capY = p.capY == null ? 1.95 : p.capY;
        var baseY = p.base === 'deck' ? -0.02 : -DEPTH - 0.05;
        var capC = hexRGB(p.color || '#D9524A');
        var stemC = hexRGB(p.stemColor || '#EDEDE6');
        cyl(px, pz, p.stemR == null ? mr * 0.1 : p.stemR, baseY, capY, 4, stemC);
        dome(px, capY + mr * 0.1, pz, mr, mr * (p.capH == null ? 0.4 : p.capH), mr, 1, capC);
        SH.push(px, pz, mr * 0.98, p.shade == null ? 0.5 : p.shade);
        if (p.curtain) {
          /* 从伞沿垂下来的一圈水帘：几股细柱拼成一个筒（每股要细，粗了像柱子） */
          var rr = mr * 0.56, nb = p.streams == null ? 9 : p.streams, k2;
          for (k2 = 0; k2 < nb; k2++) {
            var aa = k2 / nb * Math.PI * 2 + 0.35;
            cyl(px + Math.cos(aa) * rr, pz + Math.sin(aa) * rr, 0.045,
              baseY - 0.02, capY + 0.03, 2, ctx.waterRGB);
          }
        }
        continue;
      }

      if (p.type === 'slide') {
        var rot = (p.rot || 0) * DEG, ca = Math.cos(rot), sa = Math.sin(rot);
        var L = function (lx, ly, lz) { return [px + lx * ca + lz * sa, ly, pz - lx * sa + lz * ca]; };
        var w2 = (p.w == null ? 0.62 : p.w) * 0.5;
        var hh = p.h == null ? 1.35 : p.h;
        var len = p.len == null ? 2.5 : p.len;
        var z0 = 0.14, z1 = z0 + len, yTop = hh, yBot = Math.max(0.05, WATER + 0.06);
        chuteC = hexRGB(p.color || '#EFB33C');
        sideC = [chuteC[0] * 0.8, chuteC[1] * 0.8, chuteC[2] * 0.84];
        metalC = [0.7, 0.72, 0.75];
        quad(L(-w2, yTop, z0), L(w2, yTop, z0), L(w2, yBot, z1), L(-w2, yBot, z1), 3, chuteC);
        var up = 0.17;
        quad(L(-w2, yTop + up, z0), L(-w2, yTop, z0), L(-w2, yBot, z1), L(-w2, yBot + up, z1), 0, sideC);
        quad(L(w2, yTop + up, z0), L(w2, yTop, z0), L(w2, yBot, z1), L(w2, yBot + up, z1), 0, sideC);
        quad(L(-w2, hh, z0 - 0.66), L(w2, hh, z0 - 0.66), L(w2, hh, z0), L(-w2, hh, z0), 0, chuteC);
        var lx = 0.25, lz = z0 - 0.52, k3;
        var rail1 = L(-lx, 0, lz), rail2 = L(lx, 0, lz);
        cyl(rail1[0], rail1[2], 0.035, -0.02, hh, 4, metalC);
        cyl(rail2[0], rail2[2], 0.035, -0.02, hh, 4, metalC);
        for (k3 = 0; k3 < 3; k3++) {
          var ry = 0.34 + k3 * 0.4;
          if (ry > hh - 0.14) break;
          /* 每根横档用一竖一平两片薄板交叉：正面看是竖条、俯视看是平板，
             纯平行四边形的道具没有厚度，这样从各个方向都不会整根消失 */
          quad(L(-lx, ry - 0.03, lz), L(lx, ry - 0.03, lz), L(lx, ry + 0.03, lz), L(-lx, ry + 0.03, lz), 4, metalC);
          quad(L(-lx, ry, lz - 0.035), L(lx, ry, lz - 0.035), L(lx, ry, lz + 0.035), L(-lx, ry, lz + 0.035), 4, metalC);
        }
        var zc = z0 + len * 0.52;
        var yc = yTop + (yBot - yTop) * ((zc - z0) / len) - 0.04;
        var po1 = L(-(w2 - 0.05), 0, zc), po2 = L(w2 - 0.05, 0, zc);
        cyl(po1[0], po1[2], 0.035, -0.02, yc, 4, metalC);
        cyl(po2[0], po2[2], 0.035, -0.02, yc, 4, metalC);
      }
    }

    return {
      n: T.length, shadeN: (SH.length / 4) | 0,
      T: new Uint8Array(T), B: new Int32Array(B),
      F: new Float32Array(F), BND: new Float32Array(BND), SH: new Float32Array(SH),
      W: new Uint8Array(WET)
    };
  }

  POOLCORE.poolBottom = POOL_BOTTOM;      // 投稿表单要用它把水位换算成水深

  POOLCORE.compile = function (scene) {
    var room = scene.room || {};
    var halfW = (room.w || 25) * 0.5;
    var halfD = (room.d || 14) * 0.5;
    var roomH = room.h || 4.8;

    var pool = scene.pool || {};
    var insetX = pool.insetX == null ? 3 : pool.insetX;
    var insetZ = pool.insetZ == null ? 3.6 : pool.insetZ;
    /* 盆底固定：不写 pool.bottom 的场景全都落在同一个标准盆底上。
       上限放到 14m —— 深水池是另一个池子，盆底可以深到看不见 */
    var depth = clamp(pool.bottom == null ? POOL_BOTTOM : pool.bottom, 0.3, 14);
    var px0 = -halfW + insetX, px1 = halfW - insetX;
    var pz0 = -halfD + insetZ, pz1 = halfD - insetZ;
    if (px1 - px0 < 1.6) { var cx = (px0 + px1) * 0.5; px0 = cx - 0.8; px1 = cx + 0.8; }
    if (pz1 - pz0 < 1.6) { var cz = (pz0 + pz1) * 0.5; pz0 = cz - 0.8; pz1 = cz + 0.8; }

    var water = scene.water || {};
    var waterY = water.level == null ? -0.18 : water.level;
    /* 水位线（水碱那圈印子）可以和水面不在同一个高度：抽干之后印子还在 */
    var stainY = water.stain == null ? waterY : water.stain;
    var clarity = clamp(water.clarity == null ? 0.65 : water.clarity, 0, 1);
    /* 水体吸收：0 = 老行为（水几乎不上色，池底看得清）。>0 打开按通道的吸收，
       红光死得最快、蓝绿穿得深（清澈池水约 0.34 / 0.10 / 0.055 每米），
       于是「越深越黑」而不是「整片糊上一层水色」—— 深水池全靠这个 */
    var absorb = clamp(water.absorb == null ? 0 : water.absorb, 0, 3);
    var aR = 0.34 * absorb, aG = 0.10 * absorb, aB = 0.055 * absorb;
    /* 光网（焦散）是「透过水面打进来的光」，所以它的颜色该跟着那束光走：
       默认偏白青（清水里就是这样），黄昏那种暖光场景可以给个金色 */
    var causticRGB = water.caustic ? hexRGB(water.caustic) : [0.86, 1, 1.04];
    var ripple = clamp(water.ripple == null ? 0.4 : water.ripple, 0, 1.2);
    var flooded = waterY > 0.005;          // 水面漫过池沿 = 大厅进水

    var t = scene.tile || {};
    var size = clamp(t.size == null ? 0.25 : t.size, 0.07, 1.2);
    var hue = ((t.hue == null ? 196 : t.hue) % 360 + 360) % 360;
    var sat = clamp(t.sat == null ? 0.32 : t.sat, 0, 1);
    var lum = clamp(t.light == null ? 0.8 : t.light, 0.2, 0.95);
    var groutFrac = clamp(t.grout == null ? 0.075 : t.grout, 0.02, 0.24);
    /* 脏（成片的水渍）默认关掉：干净到失真的白瓷砖是这套画面的底色。
       想要岁月感就写 scene.dirt: 0.4 之类（0~1） */
    var dirt = clamp(scene.dirt == null ? 0 : scene.dirt, 0, 1);
    /* 逐砖明暗差默认 0 —— 以前是 ±7%，白瓷砖里会混进灰黑色的砖，
       一眼就「假」得不对味。想故意要旧砖感写 tile: { vary: 0.14 } */
    var vary = clamp(t.vary == null ? 0 : t.vary, 0, 0.5);

    var li = scene.light || {};
    var lIntensity = clamp(li.intensity == null ? 1 : li.intensity, 0.05, 2);
    var lHue = li.hue == null ? 38 : li.hue;
    var skylight = clamp(li.skylight == null ? 0.6 : li.skylight, 0, 2);
    var nFix = clamp(Math.round(li.fixtures == null ? 4 : li.fixtures), 0, 8);

    var fg = scene.fog || {};
    var fogRGB = hexRGB(fg.color || '#0B2A33');
    var fogNear = fg.near == null ? 4 : fg.near;
    var fogFar = fg.far == null ? 26 : fg.far;
    var fogDensity = fg.density == null ? 1 : fg.density;

    /* ---- 调色板 ---- */
    var pal = {
      deck: hsl2rgb(hue, sat * 0.5, lum),
      coping: hsl2rgb(hue, sat * 0.72, Math.min(0.95, lum + 0.05)),
      wall: hsl2rgb(hue, sat * 0.4, Math.max(0.3, lum - 0.05)),
      poolTile: hsl2rgb(hue, Math.min(0.9, sat + 0.3), Math.max(0.2, lum - 0.3)),
      /* 水线（泳道线）用黑色：原来是饱和蓝，清水池底上太抢眼。
         只留一点场景色相，免得看着像画面破了个洞 */
      lane: hsl2rgb(hue - 4, Math.min(0.5, sat * 0.35), 0.05),
      /* 砖缝：近黑，只留一点场景色相（蓝池是黑蓝、暖池是黑棕）——
         白瓷砖上要的就是这道清楚的网格 */
      grout: hsl2rgb(hue - 4, Math.min(0.5, sat * 0.4), 0.055),
      scum: hsl2rgb(hue - 22, sat * 0.5, Math.max(0.12, lum - 0.4)),
      ceil: hsl2rgb(hue, sat * 0.18, Math.max(0.28, lum - 0.23)),
      /* 天花板上的砖缝浅一档：那片本来就亮，再压黑会显得脏 */
      ceilLine: hsl2rgb(hue, Math.min(0.4, sat * 0.3), 0.3),
      laneNo: hsl2rgb(hue + 4, Math.min(0.9, sat + 0.5), Math.max(0.1, lum - 0.55))
    };
    /* 砖缝按覆盖率与各底色预混成 5 档：逐像素只查表，不在热循环里建数组 */
    function gtab(base) {
      var out = [base], k;
      for (k = 1; k < 9; k++) {
        var q = k / 8;
        out.push([
          base[0] + (pal.grout[0] - base[0]) * q,
          base[1] + (pal.grout[1] - base[1]) * q,
          base[2] + (pal.grout[2] - base[2]) * q
        ]);
      }
      return out;
    }
    pal.gDeck = gtab(pal.deck);
    pal.gCoping = gtab(pal.coping);
    pal.gPool = gtab(pal.poolTile);
    pal.gWall = gtab(pal.wall);
    pal.gCeil = gtab(pal.ceil);
    pal.gCeilLine = gtab(pal.ceilLine);

    /* ---- 波场：每个波自己一个方向 + 自己的随机相位 + 色散关系定的频率 ----
       依据 GPU Gems 1《Effective Water Simulation from Physical Models》那套
       「正弦/郭士纳波之和」。原文点名了几种失败，前三条正好就是「水在来回晃」的原因：

         · 方向 D 各自随机，**不能成对反平行**。一对反平行的同波长波会叠成
           sin(kx−ωt)+sin(kx+ωt) = 2sin(kx)cos(ωt)，那就是**驻波**：
           波节钉死、原地上下抖，看着就是一池水在往同一个方向来回晃；
         · 相位 φ **每个波独立随机**。φ 全为 0（也就是原来那种
           sin(k·n·x)·cos(ωt)）等于所有波的峰谷都对齐在原点，会叠出规则的
           编织状格子；
         · ω 由**色散关系**给（深水 ω = √(g·k)），不是随便配的。ω 与 k 无关时
           所有波一个速度，整片水像一块板一样整体晃 —— 原文称这条是「不晃」的核心。
       波长按**对数均匀**取（均匀随机会出现整数倍关系、叠出周期性格子）。
       种子由场景定，所以同一个场景每次打开完全一样。 */
    var NSLOW = 3, NMID = 4, NFINE = 4, NCAUS = 4;
    var GRAV = 9.81, TAU = 6.283185307179586;
    var sCx = new Float64Array(NSLOW), sCz = new Float64Array(NSLOW);
    var sK = new Float64Array(NSLOW), sA = new Float64Array(NSLOW), sO = new Float64Array(NSLOW);
    var sPh = new Float64Array(NSLOW), sT = new Float64Array(NSLOW);
    var mCx = new Float64Array(NMID), mCz = new Float64Array(NMID);
    var mK = new Float64Array(NMID), mA = new Float64Array(NMID), mO = new Float64Array(NMID);
    var mPh = new Float64Array(NMID), mT = new Float64Array(NMID);
    var fCx = new Float64Array(NFINE), fCz = new Float64Array(NFINE);
    var fK = new Float64Array(NFINE), fA = new Float64Array(NFINE), fO = new Float64Array(NFINE);
    var fPh = new Float64Array(NFINE), fT = new Float64Array(NFINE);
    /* 池底光网：跟水面同一套做法（各自方向 + 随机相位），但格子粗、频率慢得多 */
    var cCx = new Float64Array(NCAUS), cCz = new Float64Array(NCAUS);
    var cK = new Float64Array(NCAUS), cO = new Float64Array(NCAUS);
    var cPh = new Float64Array(NCAUS), cT = new Float64Array(NCAUS);
    (function () {
      var g = 2.399963229728653;               // 黄金角：方向撒得最匀
      var sd = scene.seed || 1;
      var i, th, h1, h2, h3, ss, sc;
      /* 慢波：波长 4.8~7.1 m（参考视频里那种几秒一轮的宽缓起伏） */
      ss = 0;
      for (i = 0; i < NSLOW; i++) {
        h1 = tileHash(i * 7 + 3, 11, sd + 91);
        h2 = tileHash(i * 5 + 1, 23, sd + 57);
        h3 = tileHash(i * 11 + 9, 31, sd + 137);
        th = i * g + sd * 0.37;
        sCx[i] = Math.cos(th); sCz[i] = Math.sin(th);
        sK[i] = TAU / (4.8 * Math.pow(7.1 / 4.8, h1));    // 对数均匀取波长
        sO[i] = Math.sqrt(GRAV * sK[i]);                  // 色散：周期约 1.8~2.1 s
        sPh[i] = h2 * TAU;                                // 随机相位
        sA[i] = 0.8 + 0.45 * h3;
        ss += sA[i] * sA[i];
      }
      /* 振幅归一：总能量跟老版一致（Σa² ≈ 2.4），起伏幅度不变 */
      sc = Math.sqrt(2.4 / ss);
      for (i = 0; i < NSLOW; i++) sA[i] *= sc;
      /* 中尺度：波长 1.1~2.8 m。**这一层才是「看得见的水」** —— 小池里的水不会
         是几条长涌，而是一片一片的乱序细浪。它同样各自方向 + 随机相位 + 色散频率，
         所以叠出来是「粼粼」的碎波，不会整池朝一个方向来回晃。
         倒影也吃这一层（慢波那层已经压到只轻轻揉一下） */
      ss = 0;
      for (i = 0; i < NMID; i++) {
        h1 = tileHash(i * 15 + 7, 59, sd + 601);
        h2 = tileHash(i * 19 + 3, 67, sd + 647);
        h3 = tileHash(i * 23 + 5, 73, sd + 691);
        th = i * g + sd * 2.31 + 0.6;
        mCx[i] = Math.cos(th); mCz[i] = Math.sin(th);
        mK[i] = TAU / (1.1 * Math.pow(2.8 / 1.1, h1));
        mO[i] = Math.sqrt(GRAV * mK[i]);                  // 周期约 0.8~1.3 s
        mPh[i] = h2 * TAU;
        mA[i] = 0.8 + 0.45 * h3;
        ss += mA[i] * mA[i];
      }
      sc = Math.sqrt(2.4 / ss);
      for (i = 0; i < NMID; i++) mA[i] *= sc;
      /* 细纹：波长 0.42~0.70 m（视频里细碎反光就这么密）。ω 同样由色散给 ——
         物理上短波本来就抖得快，正好落在视频那档「快速明灭」上，不是硬配的 */
      ss = 0;
      for (i = 0; i < NFINE; i++) {
        h1 = tileHash(i * 9 + 5, 37, sd + 183);
        h2 = tileHash(i * 3 + 7, 53, sd + 219);
        h3 = tileHash(i * 13 + 4, 43, sd + 263);
        th = i * g + sd * 1.13 + 1.1;                     // 与慢波错开一轮方向
        fCx[i] = Math.cos(th); fCz[i] = Math.sin(th);
        fK[i] = TAU / (0.42 * Math.pow(0.70 / 0.42, h1));
        fO[i] = Math.sqrt(GRAV * fK[i]);                  // 周期约 0.5~0.7 s
        fPh[i] = h2 * TAU;
        fA[i] = 0.8 + 0.45 * h3;
        ss += fA[i] * fA[i];
      }
      sc = Math.sqrt(2.4 / ss);
      for (i = 0; i < NFINE; i++) fA[i] *= sc;
      /* 光网：各自的方向与相位，频率比水慢一个多数量级。
         以前 ω 取 0.17~0.26（周期 25~35 s），慢到盯着看半分钟也看不出池底
         光斑在动；现在 0.32~0.46（周期约 12~18 s），游动看得出来，
         但仍然是「一大片缓慢明灭」，不会变成哗哗抖动的碎网 */
      for (i = 0; i < NCAUS; i++) {
        th = i * g + sd * 0.71 + 2.2;
        cCx[i] = Math.cos(th); cCz[i] = Math.sin(th);
        cK[i] = 1.7 + 1.3 * tileHash(i * 11 + 2, 71, sd + 307);
        cO[i] = 0.32 + 0.14 * tileHash(i * 13 + 6, 89, sd + 401);
        cPh[i] = tileHash(i * 17 + 8, 97, sd + 431) * TAU;
      }
    })();

    var waterRGB = hexRGB(water.color || '#2FA3C7');
    var lightRGB = hsl2rgb(lHue, 0.2, 0.95);
    /* 天窗外面那层「天空」= 雾色被冲淡 */
    var skyRGB = [mixv(fogRGB[0], 1, 0.62), mixv(fogRGB[1], 1, 0.62), mixv(fogRGB[2], 1, 0.62)];
    /* ---- 天空（程序生成）与太阳 ----
       默认从雾色推：天窗开得越大越亮，夜空就跟着暗下去。场景可以用 sky:{} 覆盖 */
    var sk = scene.sky || {};
    var wash = clamp(0.18 + skylight * 0.5, 0.18, 0.72);
    var skyHor = sk.horizon ? hexRGB(sk.horizon)
      : [mixv(fogRGB[0], 1, wash), mixv(fogRGB[1], 1, wash), mixv(fogRGB[2], 1, wash)];
    var skyTop = sk.top ? hexRGB(sk.top)
      : [mixv(skyHor[0], 0.10, 0.55), mixv(skyHor[1], 0.16, 0.55), mixv(skyHor[2], 0.34, 0.55)];
    var skyCloud = sk.cloud ? hexRGB(sk.cloud)
      : [mixv(skyHor[0], 1, 0.3), mixv(skyHor[1], 1, 0.3), mixv(skyHor[2], 1, 0.3)];
    var skyCloudLit = sk.cloudLit ? hexRGB(sk.cloudLit)
      : [mixv(skyHor[0], 1, 0.78), mixv(skyHor[1], 1, 0.78), mixv(skyHor[2], 1, 0.78)];
    var skySun = sk.sun ? hexRGB(sk.sun) : lightRGB;
    var sunAz = (sk.az == null ? 0 : sk.az) * DEG;
    var sunEl = clamp(sk.el == null ? 58 : sk.el, 2, 88) * DEG;
    var sunCX = Math.cos(sunEl);

    var reflTint = nFix > 0
      ? [mixv(skyRGB[0], lightRGB[0], 0.55), mixv(skyRGB[1], lightRGB[1], 0.55), mixv(skyRGB[2], lightRGB[2], 0.55)]
      : skyRGB;
    var ceilSize = size * 2.6;

    /* ---- 灯具：沿大厅长边在天花板下排一列灯管 ---- */
    var fixtures = [];
    var i;
    for (i = 0; i < nFix; i++) {
      fixtures.push({
        x: nFix === 1 ? 0 : (-halfW * 0.62 + (i + 0.5) / nFix * halfW * 1.24),
        z: 0,
        hw: 0.17,
        hd: Math.min(halfD * 0.78, 5.5)
      });
    }

    /* ---- 天窗：天花板中央一条 ---- */
    var skyRect = { x0: -halfW * 0.3, x1: halfW * 0.3, z0: -halfD * 0.55, z1: halfD * 0.55 };

    /* ---- 地面光照贴图（环境 + 灯管衰减 + 天窗），模糊两次让过渡是软的 ---- */
    var gw = 56, gh = 40, M = 1.2;
    var lightGrid = {
      gw: gw, gh: gh,
      x0: -halfW - M, z0: -halfD - M,
      invW: gw / (halfW * 2 + M * 2), invD: gh / (halfD * 2 + M * 2),
      data: new Float32Array(gw * gh)
    };
    for (var gz = 0; gz < gh; gz++) {
      var wz = lightGrid.z0 + (gz + 0.5) / lightGrid.invD;
      for (var gx = 0; gx < gw; gx++) {
        var wx = lightGrid.x0 + (gx + 0.5) / lightGrid.invW;
        var v = 0.44 + lIntensity * 0.1;
        for (var k = 0; k < fixtures.length; k++) {
          var f = fixtures[k];
          var ddx = wx - f.x, ddz = wz - f.z;
          v += (0.14 * lIntensity * f.hd) / (1 + (ddx * ddx + ddz * ddz) * 0.055);
        }
        if (skylight > 0.02) {
          var ex = 1 - Math.abs(wx) / (halfW * 0.34);
          var ez = 1 - Math.abs(wz) / (halfD * 0.62);
          if (ex > 0 && ez > 0) v += skylight * 0.5 * Math.min(1, ex * 2) * Math.min(1, ez * 2);
        }
        lightGrid.data[gz * gw + gx] = v;
      }
    }
    boxBlur(lightGrid, 2);

    /* ---- 天花板反光贴图：水面照什么回去，就看这张 ---- */
    var cw = 52, ch = 38;
    var glowGrid = {
      gw: cw, gh: ch,
      x0: -halfW - M, z0: -halfD - M,
      invW: cw / (halfW * 2 + M * 2), invD: ch / (halfD * 2 + M * 2),
      data: new Float32Array(cw * ch)
    };
    for (var y2 = 0; y2 < ch; y2++) {
      var zz = glowGrid.z0 + (y2 + 0.5) / glowGrid.invD;
      for (var x2 = 0; x2 < cw; x2++) {
        var xx = glowGrid.x0 + (x2 + 0.5) / glowGrid.invW;
        var gv = 0.16 + skylight * 0.42;
        for (var k2 = 0; k2 < fixtures.length; k2++) {
          var f2 = fixtures[k2];
          var ax = Math.abs(xx - f2.x) - f2.hw, az = Math.abs(zz - f2.z) - f2.hd;
          if (ax < 0.6 && az < 0.6) {
            gv += 1.45 * lIntensity * Math.max(0, 1 - Math.max(ax, 0) / 0.6) * Math.max(0, 1 - Math.max(az, 0) / 6);
          }
        }
        if (skylight > 0.02 &&
          xx > skyRect.x0 - 0.6 && xx < skyRect.x1 + 0.6 && zz > skyRect.z0 - 0.6 && zz < skyRect.z1 + 0.6) {
          gv += skylight * 0.34;
        }
        glowGrid.data[y2 * cw + x2] = gv;
      }
    }
    boxBlur(glowGrid, 1);

    /* ---- 默认站位：站在池子长边外的池沿上，面向池心 ---- */
    var cam = scene.camera || {};
    var camX = cam.x == null ? 0 : clamp(cam.x, -halfW + 0.7, halfW - 0.7);
    var camZ = Math.min(pz1 + 1.7, halfD - 0.7);
    if (camZ < pz1 + 0.55) camZ = pz1 + 0.55;
    if (camX > px0 - 0.2 && camX < px1 + 0.2 && camZ > pz0 - 0.2 && camZ < pz1 + 0.2) {
      camZ = pz1 + 0.9;                     // 兜底：相机绝不能落在池子里
    }
    var pcx = (px0 + px1) * 0.5, pcz = (pz0 + pz1) * 0.5;
    var yaw0 = cam.yaw != null ? cam.yaw * DEG : Math.atan2(pcx - camX, -(pcz - camZ));
    var pitch0 = (cam.pitch == null ? -6 : cam.pitch) * DEG;

    var laneNo = 1 + Math.abs((scene.seed || 1) | 0) % 8;
    var waterDepth = flooded ? (waterY + depth) : Math.max(0, depth + waterY);

    /* ---- 道具（蘑菇伞 / 滑梯）展开成基本体 ---- */
    var props = buildProps(scene.props, {
      depth: depth, waterY: waterY, waterRGB: waterRGB,
      limX: halfW - 0.45, limZ: halfD - 0.45
    });
    var hotspots = [
      { label: '池面', yaw: yaw0, pitch: -14 },
      { label: '灯带与天窗', yaw: yaw0, pitch: 25 },
      { label: '入口', yaw: yaw0 + Math.PI, pitch: -3 },
      { label: '左墙泳道', yaw: yaw0 - Math.PI / 2, pitch: -5 },
      { label: '右墙泳道', yaw: yaw0 + Math.PI / 2, pitch: -5 }
    ];
    for (var hp = 0; hp < (scene.props || []).length; hp++) {
      var pp = scene.props[hp];
      if (!pp || !pp.type) continue;
      var ptx = pp.x == null ? 0 : clamp(pp.x, -halfW + 0.45, halfW - 0.45);
      var ptz = pp.z == null ? 0 : clamp(pp.z, -halfD + 0.45, halfD - 0.45);
      hotspots.push({
        label: pp.type === 'mushroom' ? '蘑菇伞' : (pp.type === 'slide' ? '滑梯' : pp.type),
        yaw: Math.atan2(ptx - camX, -(ptz - camZ)),
        pitch: pp.type === 'mushroom' ? 3 : -4
      });
    }

    return {
      id: scene.id, name: scene.name,
      wave: {
        nS: NSLOW, nM: NMID, nF: NFINE,
        sCx: sCx, sCz: sCz, sK: sK, sA: sA, sO: sO, sPh: sPh, sT: sT,
        mCx: mCx, mCz: mCz, mK: mK, mA: mA, mO: mO, mPh: mPh, mT: mT,
        fCx: fCx, fCz: fCz, fK: fK, fA: fA, fO: fO, fPh: fPh, fT: fT,
        nC: NCAUS, cCx: cCx, cCz: cCz, cK: cK, cO: cO, cPh: cPh, cT: cT
      },
      flags: { flooded: flooded },
      room: { w: halfW * 2, d: halfD * 2, h: roomH, halfW: halfW, halfD: halfD },
      /* laneLongX / laneBase：泳道线的方向与零点在场景里是死的，
         编译时算好，免得逐像素再判一次方向、再减一次 */
      pool: {
        x0: px0, x1: px1, z0: pz0, z1: pz1, depth: depth,
        laneLongX: (px1 - px0) >= (pz1 - pz0),
        laneBase: (px1 - px0) >= (pz1 - pz0) ? pz0 : px0
      },
      sky: {
        top: skyTop, hor: skyHor, cloud: skyCloud, cloudLit: skyCloudLit, sun: skySun,
        bright: clamp(sk.bright == null ? (0.12 + skylight * 0.95 + lIntensity * 0.22) : sk.bright, 0.08, 2.4),
        cover: clamp(sk.cover == null ? 0.42 : sk.cover, 0, 0.95),
        sunPow: clamp(sk.sunPow == null ? 1.5 : sk.sunPow, 0, 3),
        seed: (scene.seed || 7) + 101
      },
      water: {
        y: waterY, stainY: stainY, rgb: waterRGB, clarity: clarity, ripple: ripple, depth: waterDepth,
        absorb: absorb, aR: aR, aG: aG, aB: aB, caustic: causticRGB,
        /* 水面那层「大块柔光」的强度：跟着场景有多少天光 / 灯走。
           夜里几乎没有，户外正午最亮 —— 不然夜景会糊上一层白。
           场景可以写 water.sheen 直接覆盖（深水池要把它压掉，水才是黑玻璃） */
        sheen: clamp(water.sheen == null ? (0.24 + skylight * 0.4 + lIntensity * 0.26)
          : water.sheen, 0, 1.2)
      },
      tile: {
        size: size, invSize: 1 / size, groutFrac: groutFrac, dirt: dirt, vary: vary,
        ceilSize: ceilSize, invCeil: 1 / ceilSize
      },
      light: {
        intensity: lIntensity, skylight: skylight, fixtures: fixtures,
        rgb: lightRGB, sky: skyRGB, reflTint: reflTint, skyRect: skyRect,
        /* 太阳方向（单位向量）与强度：方向光、天空、水面倒影共用同一个 */
        sunX: Math.sin(sunAz) * sunCX, sunY: Math.sin(sunEl), sunZ: -Math.cos(sunAz) * sunCX,
        sunI: clamp(sk.sunI == null ? (skylight * 0.85 + lIntensity * 0.3) : sk.sunI, 0, 2)
      },
      fog: { rgb: fogRGB, near: fogNear, far: fogFar, density: fogDensity },
      pal: pal,
      lightGrid: lightGrid,
      glowGrid: glowGrid,
      props: props,
      camera: {
        x: camX, z: camZ,
        height: cam.height == null ? 1.66 : cam.height,
        yaw: yaw0, pitch: pitch0
      },
      /* 热区按几何推出来，所有场景通用；有道具再补上道具那一项 */
      hotspots: hotspots,
      laneNo: laneNo,
      seed: scene.seed || 1,
      metrics: {
        roomW: halfW * 2, roomD: halfD * 2, roomH: roomH,
        poolW: px1 - px0, poolD: pz1 - pz0, depth: depth,
        waterDepth: waterDepth, fixtures: nFix, skylight: skylight,
        lanes: Math.max(1, Math.round(Math.max(px1 - px0, pz1 - pz0) / 2.2))
      }
    };
  };

  /* ======================================================================
     渲染器
     ====================================================================== */

  POOLCORE.createRenderer = function (canvas, scene, options) {
    options = options || {};
    if (!canvas || !canvas.getContext) return null;

    var ctx;
    try { ctx = canvas.getContext('2d', { alpha: false }); } catch (e) { ctx = null; }
    if (!ctx) return null;

    var S = POOLCORE.compile(scene);
    var WV = S.wave;                         // 波表（换场景时在 setScene 里一起换）
    var quality = clamp(options.quality || 540, 180, 900);   // 内部渲染高度（px）

    /* 场景里的道具（可能一个都没有，那就整条路径都不进）。
       这里只声明、下面取 S.props 的值 —— 声明与初始化要分开写，
       否则后面那句 `var x = 0` 会把刚取到的值覆盖掉 */
    var prType, prBase, prF, prBnd, prN, propSH, propShadeN, hasProps, prWet;
    prType = S.props.T; prBase = S.props.B; prF = S.props.F; prWet = S.props.W;
    prBnd = S.props.BND; propSH = S.props.SH;
    prN = S.props.n; propShadeN = S.props.shadeN; hasProps = prN > 0;

    var W = 0, H = 0, imgData = null, data = null;
    /* 逐像素写缓冲区时用 32 位一次写完（比四次 8 位写快，也少一半内存流量）。
       浏览器所在平台都是小端，但这里仍然留一个运行时判断，不赌。 */
    var data32 = null;
    var LITTLE_ENDIAN = (function () {
      var b = new Uint8Array(4);
      new Uint32Array(b.buffer)[0] = 1;
      return b[0] === 1;
    })();

    /* 开机自检：putImageData 的「脏矩形」写法在 Safari 里出过问题。
       空闲动画只重画下半屏、正好走这条路；一旦它静默失效，表现就是
       「拖拽（整幅写入）在动、一松手（脏矩形写入）就不动」。
       这里拿一张 8x8 小画布试写一次再读回来，不对就永远整幅写入 ——
       多几毫秒的拷贝，换画面不会停住。 */
    var dirtyOK = (function () {
      try {
        var D = root.document;
        if (!D || !D.createElement) return true;
        var c2 = D.createElement('canvas');
        c2.width = 8; c2.height = 8;
        var g2 = c2.getContext('2d');
        if (!g2 || !g2.getImageData) return true;
        var im = g2.createImageData(8, 8), i;
        for (i = 0; i < 64; i++) { im.data[i * 4] = (i * 7) & 255; im.data[i * 4 + 3] = 255; }
        g2.putImageData(im, 0, 0, 0, 3, 8, 4);       // 只写 y=3..6 那几行
        var back = g2.getImageData(0, 3, 8, 1).data;
        return back[0] === ((24 * 7) & 255);          // 期望第 24 号像素：168
      } catch (e) { return false; }
    })();

    /* 行表 / 列表：按帧复用，不在像素循环里分配内存 */
    var rowDY = new Float32Array(1200), rowTF = new Float32Array(1200), rowTW = new Float32Array(1200),
      rowTB = new Float32Array(1200), rowTC = new Float32Array(1200), rowWK = new Float32Array(1200),
      rowRT = new Float32Array(1200);
    var colDX = new Float32Array(2400), colDZ = new Float32Array(2400), colLH = new Float32Array(2400),
      colTW = new Float32Array(2400), colWU = new Float32Array(2400), colOUT = new Float32Array(2400),
      colWX = new Float32Array(2400), colWZ = new Float32Array(2400), colRT = new Float32Array(2400);
    var colWID = new Uint8Array(2400), colEXA = new Uint8Array(2400);
    var FOG = new Float32Array(320), FRES = new Float32Array(320);
    /* 逐帧的雾色：水上用场景雾色，水下换成水的颜色（雾的浓淡也在帧里改） */
    var FOG_RGB = new Float32Array(3);
    var uwMode = 0;                      // 本帧是不是水下（fogMix 要用）
    var poolSoft = 0;                    // 隔着水面看池底时的高频衰减（0 = 清楚，1 = 糊）
    var wallSoft = 0;                    // 水下看池壁时砖缝的对比度衰减
    var uwW = 0;                         // 本像素的水流缓动量（-1..1）
    /* 水体按通道的透过率表（每 0.25m 一档）与「池底还照得到多少光」 */
    var TWR = new Float32Array(320), TWG = new Float32Array(320), TWB = new Float32Array(320);
    var botLitR = 1, botLitG = 1, botLitB = 1;

    /* 道具：每列预筛出「射线可能碰到的基本体」，逐像素只在候选里精确求交。
       注意：这几个变量在上面已经从 S.props 取过值了，这里不能再写初始化，
       否则会把它覆盖回 0 / null（var 的初始化语句是后执行的） */
    var CAND_MAX = 24;
    var candIdx = new Int32Array(2400 * 24), candN = new Int32Array(2400);
    var propTmin = new Float32Array(2400), wetTmin = new Float32Array(2400);

    var stats = { ms: 0, px: 0, frames: 0 };
    var destroyed = false;

    /* 逐像素状态：着色函数写 or/og/ob，putPixel 落到缓冲区 */
    var or = 0, og = 0, ob = 0;
    var tt = 0;                              // 水面动画时间
    /* 驻波的「时间项」：sin(波·n·x)·cos(ωt) 里的 cos(ωt) 整帧是常数，
       每帧只算一次、按波存进 S.wave.sT/fT —— 于是每个水面像素省下 10 次
       查表正弦。注意现在每个波的频率都不一样（ω 由波长定） */
    var exposure = 1;                        // 光照强度（用户在查看器里拉的）
    var camX = 0, camZ = 0, camY = 1.66;     // 每帧写入，着色函数要用
    var rowReflT = 0;                        // 本行的水面镜面到天花板的距离（t 参数）
    var laneC = [0, 0, 0];                   // 泳道线混色的临时三通道（避免逐像素建数组）
    var pid = 0;

    function putPixel() {
      /* 光照强度：整幅统一缩放，而且压在图之前做 ——
         高光本来会被截断到 1，先乘再截能把过曝的部分救回来，
         所以调暗不是「整幅变灰」，是「有层次地暗下去」 */
      var er = or * exposure, eg = og * exposure, eb = ob * exposure;
      var r = er > 1 ? 255 : (er > 0 ? (er * 255 + 0.5) | 0 : 0);
      var g = eg > 1 ? 255 : (eg > 0 ? (eg * 255 + 0.5) | 0 : 0);
      var b = eb > 1 ? 255 : (eb > 0 ? (eb * 255 + 0.5) | 0 : 0);
      if (data32) data32[pid] = 0xFF000000 | (b << 16) | (g << 8) | r;
      else {
        var i4 = pid << 2;
        data[i4] = r; data[i4 + 1] = g; data[i4 + 2] = b; data[i4 + 3] = 255;
      }
      pid++;
    }

    function ensure(w, h) {
      w = Math.max(64, w | 0);
      h = Math.max(36, h | 0);
      if (w === W && h === H) return;
      W = w; H = h;
      canvas.width = W;
      canvas.height = H;
      imgData = ctx.createImageData(W, H);
      data = imgData.data;
      data32 = LITTLE_ENDIAN ? new Uint32Array(data.buffer) : null;
      if (rowDY.length < H) {
        rowDY = new Float32Array(H); rowTF = new Float32Array(H); rowTW = new Float32Array(H);
        rowTB = new Float32Array(H); rowTC = new Float32Array(H); rowWK = new Float32Array(H);
        rowRT = new Float32Array(H);
      }
      if (colDX.length < W) {
        colDX = new Float32Array(W); colDZ = new Float32Array(W); colLH = new Float32Array(W);
        colTW = new Float32Array(W); colWU = new Float32Array(W); colOUT = new Float32Array(W);
        colWX = new Float32Array(W); colWZ = new Float32Array(W); colRT = new Float32Array(W);
        colWID = new Uint8Array(W); colEXA = new Uint8Array(W);
      }
    }

    /* cssW/cssH：画布在页面上的尺寸；cap：这次要用的内部高度上限 */
    function resize(cssW, cssH, cap) {
      var ch = clamp(Math.round(cap || quality), 150, 900);
      var aspect = (cssW > 0 && cssH > 0) ? cssW / cssH : 16 / 9;
      var w = Math.round(ch * aspect);
      if (w > 2200) { w = 2200; ch = Math.round(w / aspect); }
      ensure(w, ch);
      return { w: W, h: H };
    }

    function setQuality(q) { quality = clamp(Math.round(q), 180, 900); }
    function setScene(s) { S = POOLCORE.compile(s); WV = S.wave; }
    function destroy() { destroyed = true; imgData = null; data = null; data32 = null; }

    /* 云场预表：天空是平滑的，没必要每个像素都重算两层值噪声。
       每帧建一次（72×24），逐像素只做一次双线性 —— 全屏天空的开销掉到 1/3 */
    var CLW = 104, CLH = 34, cloudTab = new Float32Array(CLW * CLH);
    /* 注意：必须放在 CLW/CLH/cloudTab 的声明「之后」调用 ——
       var 只是提升声明不提升赋值，写在前面的话循环条件会拿到 undefined，
       表就是空的（云会整片消失，而且不报错） */
    function buildCloud() {
      var sd = S.sky.seed, j, i, cv, cu;
      for (j = 0; j < CLH; j++) {
        cv = (j + 0.5) / CLH * 9.5;
        for (i = 0; i < CLW; i++) {
          cu = (i + 0.5) / CLW * 6.4 - 3.2;
          /* 三层：两层细的 + 一层更粗的（粗的那层给云团大小，最省钱也最像） */
          cloudTab[j * CLW + i] = vnoise(cu, cv, sd) * 0.52
            + vnoise(cu * 2.2 + 3.1, cv * 2.6, sd + 17) * 0.26
            + vnoise(cu * 0.62 - 2.4, cv * 0.78 + 5.1, sd + 53) * 0.22;   // 权重和 = 1
        }
      }
    }
    buildCloud();

    /* 天窗洞口权重：这个天花板上的点有多「在洞里」（0 = 屋顶，1 = 洞中央）。
       水面倒影打上来时用同一个判据 —— 洞的位置只有一个定义 */
    function skyAt(x, z) {
      if (S.light.skylight <= 0.02) return 0;
      var r = S.light.skyRect;
      var ex = (x - r.x0) / 0.42, ez = (z - r.z0) / 0.42;
      var fx = (r.x1 - x) / 0.42, fz = (r.z1 - z) / 0.42;
      if (ex > fx) ex = fx;
      if (ez > fz) ez = fz;
      if (ex <= 0 || ez <= 0) return 0;
      if (ex > 1) ex = 1;
      if (ez > 1) ez = 1;
      var w = ex * ez;
      return w * w * (3 - 2 * w);
    }

    /* ==================================================================
       天空：整块都是按方向现算的（没有贴图、没有预烘焙）——
       所以天窗里看到的那块天，和水面倒影里的那块天是同一份东西，
       水上的亮斑因此永远跟着太阳走。结果写进 or/og/ob。
       ================================================================== */
    function shadeSky(dx, dy, dz) {
      var k = S.sky;
      var q = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      var ux = dx * q, uy = dy * q, uz = dz * q;
      /* 和太阳的夹角余弦：太阳盘、光晕、云的金边全由它派生 */
      var cs = ux * S.light.sunX + uy * S.light.sunY + uz * S.light.sunZ;
      if (cs < 0) cs = 0;
      var c2 = cs * cs, c3 = c2 * cs, c6 = c3 * c3, c12 = c6 * c6, c24 = c12 * c12;
      /* 仰角 → 天顶 / 地平线渐变（开方：地平线那圈压薄一点） */
      var t = uy > 0 ? (uy < 1 ? Math.sqrt(uy) : 1) : 0;
      var a1 = 1 - t;
      var r = k.top[0] * t + k.hor[0] * a1;
      var g = k.top[1] * t + k.hor[1] * a1;
      var b = k.top[2] * t + k.hor[2] * a1;
      /* 云：查预表（横向按方位铺、纵向按仰角拉长成一层层横带） */
      var cfx = (ux * 2.35 + uz * 0.85 + 3.2) * (CLW / 6.4) - 0.5;
      var cfy = uy * (CLH / 9.5) - 0.5;
      var ci = Math.floor(cfx), cj = Math.floor(cfy);
      if (ci < 0) ci = 0; else if (ci > CLW - 2) ci = CLW - 2;
      if (cj < 0) cj = 0; else if (cj > CLH - 2) cj = CLH - 2;
      var tf = cfx - ci, tg = cfy - cj;
      if (tf < 0) tf = 0; else if (tf > 1) tf = 1;
      if (tg < 0) tg = 0; else if (tg > 1) tg = 1;
      var cj0 = cj * CLW + ci;
      var n00 = cloudTab[cj0], n10 = cloudTab[cj0 + 1];
      var n01 = cloudTab[cj0 + CLW], n11 = cloudTab[cj0 + CLW + 1];
      var cl = (n00 + (n10 - n00) * tf) * (1 - tg) + (n01 + (n11 - n01) * tf) * tg;
      /* 值噪声本身很「软」（±0.1），直接用会把整片天都糊成半云；
         先拉对比再切，云才有形状 */
      var cq = ((cl - 0.5) * 1.75 + 0.5 - k.cover) / 0.14;
      if (cq > 0) {
        if (cq > 1) cq = 1;
        var cw = cq * cq * (3 - 2 * cq);
        /* 云自己也被太阳点着：朝阳那侧是金边，背光那侧是暗糖色 */
        var lit = c2 * 0.5 + c6 * 0.5;
        var cr = k.cloud[0] + (k.cloudLit[0] - k.cloud[0]) * lit;
        var cg = k.cloud[1] + (k.cloudLit[1] - k.cloud[1]) * lit;
        var cb = k.cloud[2] + (k.cloudLit[2] - k.cloud[2]) * lit;
        r = mixv(r, cr, cw);
        g = mixv(g, cg, cw);
        b = mixv(b, cb, cw);
      }
      /* 太阳：盘子本身很小很亮，外面是一层暖晕（不是一大片白）——
         光晕收得住，天窗里才看得出「那是太阳」，水面上的亮斑也才成形 */
      var disc = cs > 0.9955 ? (cs > 0.9988 ? 1 : (cs - 0.9955) / 0.0033) : 0;
      var hot = (disc * 1.5 + c12 * 0.16 + c24 * 0.34) * k.sunPow;
      var warm = (c3 * 0.26 + c6 * 0.34) * 0.8;      // 附近的天被烤暖，而不是烤白
      var amb = k.bright * (1 + warm);
      or = r * amb + k.sun[0] * hot;
      og = g * amb + k.sun[1] * hot;
      ob = b * amb + k.sun[2] * hot;
    }

    function fogMix(h) {
      var fi = h > 318 ? 318 : (h > 0 ? h | 0 : 0);
      var a = FOG[fi];
      /* 水底不只是「远处有雾」：整幅画都隔着一层水。
         给一个底噪，近处的瓷砖就不会亮得像荧光灯管 */
      if (uwMode) a = a * 0.85 + 0.07;
      if (a <= 0.002) return;
      var f = FOG_RGB;
      or = or * (1 - a) + f[0] * a;
      og = og * (1 - a) + f[1] * a;
      ob = ob * (1 - a) + f[2] * a;
    }

    /* 池沿地面 / 大厅地面（浸水时是水下地面） */
    function shadeDeck(x, z, h, under) {
      var tile = S.tile, pal = S.pal, LI = S.light.intensity;
      var u = x * tile.invSize, v = z * tile.invSize;
      var iu = Math.floor(u), iv = Math.floor(v);
      var fu = u - iu, fv = v - iv;
      var hv = h < 0.5 ? 0.5 : h;
      /* 竖缝（等 x 的线）在屏幕横向的间距，横缝（等 z 的线）取横向与竖直两个
         方向里更扁的那个 —— 掠射地面上横缝几乎是竖着掉下去的 */
      var ih = 1 / hv;                   // 一个倒数顶替三次除法（热循环里很值）
      var pxU = pxUK * ih;
      var pxV = pxVK * ih;
      var pv2 = kFloorVert * ih * ih;
      if (pv2 < pxV) pxV = pv2;
      /* 逐砖明暗 / 脏：大多数场景这两项都是 0，连噪声哈希都不用算 */
      var shade = 1, dt = 0;
      if (tile.vary > 0 || tile.dirt > 0.04) {
        dt = detailFromPx(pxU < pxV ? pxU : pxV);
        if (tile.vary > 0) shade += (tileHash(iu, iv, S.seed) - 0.5) * tile.vary * 2 * dt;
        if (tile.dirt > 0.04) shade *= 1 + (dirtAt(x, z, S.seed + 991, 1.6, 1.6, tile.dirt) - 1) * (0.35 + 0.65 * dt);
      }
      var pool = S.pool, cop = 0.36;
      var coping = x > pool.x0 - cop && x < pool.x1 + cop && z > pool.z0 - cop && z < pool.z1 + cop;
      var gcv = groutCov(fu, fv, tile.groutFrac, pxU, pxV);
      var c = coping ? pal.coping : pal.deck;
      if (gcv > 0) c = gpick(coping ? pal.gCoping : pal.gDeck, gcv);
      var l = gridAt(S.lightGrid, x, z) * LI * 0.95;
      or = c[0] * shade * l;
      og = c[1] * shade * l;
      ob = c[2] * shade * l;
      if (propShadeN > 0) {
        var shd = propShadow(x, z);
        if (shd < 0.999) { or *= shd; og *= shd; ob *= shd; }
      }
      if (under) {
        /* 从水里看地面：偏水色 */
        var w = S.water.rgb;
        or = or * 0.6 + w[0] * 0.4;
        og = og * 0.62 + w[1] * 0.38;
        ob = ob * 0.6 + w[2] * 0.4;
      }
      fogMix(h);
    }

    /* 池底：瓷砖 + 泳道线 + 焦散。caus 由水面算好传进来（0 = 干池） */
    function shadePoolBottom(x, z, h, caus) {
      var tile = S.tile, pal = S.pal, pool = S.pool, LI = S.light.intensity;
      var u = x * tile.invSize, v = z * tile.invSize;
      var iu = Math.floor(u), iv = Math.floor(v);
      var fu = u - iu, fv = v - iv;
      var hv = h < 0.5 ? 0.5 : h;
      var ih = 1 / hv;
      var pxU = pxUK * ih;
      var pxV = pxVK * ih;
      var pv2 = kBotVert * ih * ih;
      if (pv2 < pxV) pxV = pv2;
      var shade = 1, dt = 0;
      if (tile.vary > 0 || tile.dirt > 0.04) {
        dt = detailFromPx(pxU < pxV ? pxU : pxV);
        if (tile.vary > 0) shade += (tileHash(iu, iv, S.seed + 17) - 0.5) * tile.vary * 2 * dt;
        if (tile.dirt > 0.04) shade *= 1 + (dirtAt(x, z, S.seed + 991, 1.6, 1.6, tile.dirt) - 1) * (0.35 + 0.65 * dt);
      }
      var gcv = groutCov(fu, fv, tile.groutFrac, pxU, pxV);
      var c = pal.poolTile;
      /* poolSoft：隔着流动的水看池底时，砖缝和泳道线的对比度会掉下来 ——
         模糊的本质就是高频对比度没了，所以这里直接压对比，比多采一次样便宜得多 */
      if (gcv > 0) {
        var gg = gcv * (1 - poolSoft * 0.8);
        if (gg > 0.002) c = gpick(pal.gPool, gg);
      }
      /* 泳道线：顺着池子长的方向，每 2.2m 一条。
         到最近泳道线的距离用「乘 1/2.2 + 取小数」算，不用 round/取模 */
      var dd = ((pool.laneLongX ? z : x) - pool.laneBase) * INV_LANE;
      var fr = dd + 0.5;
      fr -= fr | 0;                       // 0~1 的相位：0.5 正好落在泳道线中心
      if (fr < 0) fr += 1;                // 池外取样时相位可能为负，归一回去
      if ((fr > 0.5 ? fr - 0.5 : 0.5 - fr) < 0.0591) {   // 0.13/2.2
        /* 泳道线是画在池底的黑线：压到接近实色，水流急的地方再淡下去。
           c 是三通道数组，必须逐通道混 —— mixv 只吃标量，直接传数组会走成
           字符串拼接（"0.19,0.72,0.81NaN"），之后 c[0..2] 取到的是字符
           "0" "." "1"，泳道线就被渲染成 r=0 g=NaN b=255 的纯蓝宽带 */
        var lt = (1 - poolSoft) * 0.85, ln = pal.lane;
        laneC[0] = mixv(c[0], ln[0], lt);
        laneC[1] = mixv(c[1], ln[1], lt);
        laneC[2] = mixv(c[2], ln[2], lt);
        c = laneC;
      }
      /* 焦散（光网）：亮线要亮到几乎过曝，而且偏白青 —— 那是聚起来的光，
         不是池底自己的颜色，所以额外加一层不带池底色的分量 */
      var l = gridAt(S.lightGrid, x, z) * LI * FLOOR_LIGHT * (1 + caus * 0.22);
      /* 深水里池底照不到多少光（按通道：红光先没，剩下一点墨绿） */
      or = c[0] * shade * l * botLitR;
      og = c[1] * shade * l * botLitG;
      ob = c[2] * shade * l * botLitB;
      if (propShadeN > 0) {
        var shp = propShadow(x, z);
        if (shp < 0.999) { or *= shp; og *= shp; ob *= shp; }
      }
      fogMix(h);
    }

    /* 墙面：wallId 0=-X 1=+X 2=-Z 3=+Z；poolWall=1 表示这是池内壁。
       lx/lz 是取光照贴图用的世界坐标 —— 池内壁不在房间四壁上，必须显式传进来 */
    function shadeWall(u, y, h, wallId, poolWall, lx, lz) {
      var tile = S.tile, pal = S.pal, LI = S.light.intensity;
      var tu = u * tile.invSize, ty = y * tile.invSize;
      var iu = Math.floor(tu), iy = Math.floor(ty);
      var fu = tu - iu, fy = ty - iy;
      var hv = h < 0.5 ? 0.5 : h;
      var ih = 1 / hv;
      var pxU = wallU * tilePxK * ih;
      var pxV = pxVWallK * ih;
      var shade = 1, dt = 0;
      if (tile.vary > 0 || tile.dirt > 0.05) {
        dt = detailFromPx(pxU < pxV ? pxU : pxV);
        if (tile.vary > 0) {
          shade += (tileHash(iu, iy * 3 + (poolWall ? 61 : wallId * 29), S.seed + 5) - 0.5) * tile.vary * 2 * dt;
        }
        /* 墙上的脏：噪声格子竖着拉长，看着就是顺墙往下流的水渍 */
        if (tile.dirt > 0.05 && y < 2.6) {
          shade *= 1 + (dirtAt(u, y, S.seed + 7331, 1.5, 3.4, tile.dirt) - 1) * (0.35 + 0.65 * dt);
        }
      }
      /* 水位线以下的那一圈：水泡过的瓷砖是另一种颜色 */
      var below = y < S.water.stainY;
      var c;
      if (poolWall) c = below ? pal.poolTile : pal.wall;
      else if (below) c = pal.poolTile;
      else c = (y < 1.15) ? pal.wall : pal.ceil;
      var gcv = groutCov(fu, fy, tile.groutFrac, pxU, pxV);
      /* wallSoft：隔着流动的水看池壁时，砖缝的对比度会掉下来 ——
         模糊掉的就是这种高频；水流到哪，哪一片的缝就化开 */
      if (gcv > 0) {
        var gw = gcv * (1 - wallSoft * 0.85);
        if (gw > 0.002) c = gpick(c === pal.poolTile ? pal.gPool : (c === pal.ceil ? pal.gCeil : pal.gWall), gw);
      }
      /* 水碱：水位线那道印子 */
      /* 潜到水位以下的墙面隔着水看，按水体吸收压暗（吸收=0 的场景完全不受影响）。
         视线在水里的长度 ≈ 深度 ×（整段距离 / 竖直落差） */
      if (S.water.absorb > 0 && y < S.water.y - 0.01) {
        var drop2 = camY - y;
        var wpath = (S.water.y - y) * (h / (drop2 > 0.4 ? drop2 : 0.4));
        var pi4 = (wpath * 4) | 0;
        if (pi4 > 319) pi4 = 319; else if (pi4 < 0) pi4 = 0;
        or *= TWR[pi4]; og *= TWG[pi4]; ob *= TWB[pi4];
      }
      var dwa = y - S.water.stainY;
      if (dwa > -0.03 && dwa < 0.055) { c = pal.scum; shade *= 1.08; }
      /* 泳道端墙：一条深色带 + 道次数字 */
      if (wallId === 2 && !poolWall) {
        if (y > 1.44 && y < 1.56) c = pal.lane;
        else {
          var du = u - (S.pool.x0 + S.pool.x1) * 0.5 + 0.525;
          var dv = 3.3 - y;
          if (du > 0 && du < 1.05 && dv > 0 && dv < 1.0) {
            if (glyphBit(S.laneNo, (du / 0.35) | 0, (dv / 0.2) | 0)) c = pal.laneNo;
          }
        }
      }
      var l = gridAt(S.lightGrid, lx, lz) * LI * 1.08;
      /* 越靠近天花板越亮（灯在上头），池底以下自然压暗 */
      l *= 0.66 + clamp((y + 2.4) / 3.6, 0, 1) * 0.4;
      /* 太阳的方向光：朝着太阳的那面墙亮一档，背光那面不动（室内没太阳就为 0） */
      if (S.light.sunI > 0.01) {
        var nd = (wallId === 0 ? -S.light.sunX : (wallId === 1 ? S.light.sunX : 0))
          + (wallId === 2 ? -S.light.sunZ : (wallId === 3 ? S.light.sunZ : 0));
        if (nd > 0) l += nd * S.light.sunI * 0.5 * (y > 0 ? 1 : 0.4);
      }
      or = c[0] * shade * l;
      og = c[1] * shade * l;
      ob = c[2] * shade * l;
      fogMix(h);
    }

    /* 天花板：大网格 + 灯管面板 + 天窗 */
    function shadeCeiling(x, z, h) {
      var tile = S.tile, pal = S.pal, LI = S.light.intensity;
      var u = x * tile.invCeil, v = z * tile.invCeil;
      var iu = Math.floor(u), iv = Math.floor(v);
      var fu = u - iu, fv = v - iv;
      var hv = h < 0.5 ? 0.5 : h;
      var ih = 1 / hv;
      var pxU = pxCUK * ih;
      var pxV = pxCVK * ih;
      var pv2 = kCeilVert * ih * ih;
      if (pv2 < pxV) pxV = pv2;
      var shade = 1;
      if (tile.vary > 0) {
        shade += (tileHash(iu * 2 + 1, iv * 2 - 3, S.seed + 41) - 0.5) * tile.vary * 2
          * detailFromPx(pxU < pxV ? pxU : pxV);
      }
      var gcv = groutCov(fu, fv, 0.03, pxU, pxV);
      var c = pal.ceil;
      /* 天花板的缝是 0.03 宽（比地面细），面积比也跟着它自己算 */
      if (gcv > 0) c = gpick(pal.gCeilLine, gcv);
      var cr = c[0], cg = c[1], cb = c[2];
      var l = 0.42 + LI * 0.34;
      /* 灯管面板 */
      var fx = S.light.fixtures;
      for (var k = 0; k < fx.length; k++) {
        var f = fx[k];
        var ax = Math.abs(x - f.x) - f.hw, az = Math.abs(z - f.z) - f.hd;
        if (ax < 0.55 && az < 0.55) {
          var g = Math.max(0, 1 - Math.max(ax, 0) / 0.55) * Math.max(0, 1 - Math.max(az, 0) / 0.55);
          var wgt = Math.min(1, g * 1.6) * LI;
          cr = mixv(cr, S.light.rgb[0], wgt);
          cg = mixv(cg, S.light.rgb[1], wgt);
          cb = mixv(cb, S.light.rgb[2], wgt);
          l += wgt * 1.25;
        }
      }
      /* 天窗：这不是「亮一点的顶」，是一个洞 —— 洞里看见的是天空本身，
         按方向取（自发光，不吃屋里的亮度）；边缘那圈留作屋顶厚度当窗框 */
      var skw = skyAt(x, z);
      if (skw > 0) {
        var roofR = cr * shade * l * 1.12 * (0.5 + 0.5 * skw);
        var roofG = cg * shade * l * 1.12 * (0.5 + 0.5 * skw);
        var roofB = cb * shade * l * 1.12 * (0.5 + 0.5 * skw);
        shadeSky(x - camX, S.room.h - camY, z - camZ);
        or = mixv(roofR, or, skw);
        og = mixv(roofG, og, skw);
        ob = mixv(roofB, ob, skw);
        fogMix(h);
        return;
      }
      or = cr * shade * l * 1.12;
      og = cg * shade * l * 1.12;
      ob = cb * shade * l * 1.12;
      fogMix(h);
    }

    /* 水面。要点是「一张面派生所有效果」：
       以前折射、倒影抖动、细皱褶各用一套互不相干的波，眼睛看到的是叠了三层贴纸，
       所以水是平的、不像一张有起伏的面。现在只有一个波场（三束低频 + 它们的三倍频谐波），
       坡度同时喂给下面每一层 —— 亮暗、形变、皱褶才是同一张面上的东西。

       ① 折射：池底被整张面推着晃（位移量随水深变大），瓷砖的格子会真的游动；
       ② 池底光网：四束波叠加后的过零线，很淡，只当细节；
       ③ 透：水几乎不上色，池底看得清楚（浅池近玻璃，深池才压成一种颜色）；
       ④ 真镜面：把视线按波面法线真的反射一次，再拿它去打天花板取亮。
          倒影被波面揉弯、掠射时自己拉成长条 —— 立体感主要来自这一层；
       ⑤ 大面柔光 + 细皱褶的反光：都取自同一张面，皱褶用谐波那一档；
       ⑥ 菲涅尔 + 很轻的光网白分量收尾。 */
    function shadeWater(x, z, h, tW, tB, dx, dz, lh, dy) {
      var W2 = S.water, rp = W2.ripple, dep = W2.depth;

      /* --- 一个波场，全部效果都从它派生。
             以前折射、倒影抖动、细皱褶各用一套互不相干的波，眼睛看到的是
             「叠了三层贴纸」；同一张面派生出所有东西，才会有立体感 --- */
      /* --- 每个波按**自己的方向 + 自己的相位**投上去 ---
         每个波都是行波 sin(k·n·x − ωt + φ)：方向、波长、相位都是它自己的。
         相位里的时间项（φ−ωt）整帧算好（见 render），逐像素只多做一次加法。
         坡度也顺着它自己的方向 n 累加，所以反光朝各个方向拉、波纹互相穿插 ——
         既不是一排平行条纹，也不是整池水一起原地呼吸 */
      var slx = 0, slz = 0, fxs = 0, fzs = 0, wj;
      /* ---- 距离淡出（水面版的手工 mipmap）----
         波是定义在世界坐标里的：近处看是一段宽缓的曲线，远处同一道波被
         透视压进几个像素里，位移就把池底瓷砖拉成密集的波浪线 —— 这就是
         「近处的水好看、远处的水花掉」的原因。所以像瓷砖那样按距离淡出：
         近处全细节，远处只留慢波（它波长 5~7m，二十米外也有上百像素宽，
         不会花）。整池水因此是同一种质感，而不是近处一种、远处一种 */
      var dist = tW * lh;                        // 到这格水面的距离（米）
      /* 淡出的距离以前是 7~16m / 3~8m：整个池子长 25m，于是半个池子的水面
         被压成「只有慢波」——静止看就是一块不动的瓷砖地（远处的水纹全没了）。
         现在推到 10~26m / 4~13m：房间再大也不会整片死水，而 1mm 级的
         高频抖动仍然只留在近处 */
      var dMid, dFine, dq;
      if (dist < 10) dMid = 1;
      else if (dist > 26) dMid = 0;
      else { dq = (dist - 10) / 16; dMid = dq * dq * (3 - 2 * dq); }
      if (dist < 4) dFine = 1;
      else if (dist > 13) dFine = 0;
      else { dq = (dist - 4) / 9; dFine = dq * dq * (3 - 2 * dq); }
      var wcx = WV.sCx, wcz = WV.sCz, wk = WV.sK, wa = WV.sA, wt = WV.sT;
      for (wj = 0; wj < WV.nS; wj++) {
        var av = fsin((x * wcx[wj] + z * wcz[wj]) * wk[wj] + wt[wj]) * wa[wj];
        slx += av * wcx[wj];
        slz += av * wcz[wj];
      }
      /* 慢波（波长 4.8~7.1 m）压到 0.2 档：轻轻揉一下倒影。
         长波在小池里本来就少，而且几条长波的相速度很接近、容易叠成一张
         整体漂移的大图案 —— 那就是「整片水朝一个方向来回晃」的来源，
         所以不敢给多；但 0.1 时远处的水面几乎是死的，这里给到 0.2 */
      slx *= rp * 0.2; slz *= rp * 0.2;
      /* 中尺度（1.1~2.8 m）：看得见的那层碎波，它来决定水面与倒影的细节。
         淡出到 0 就整段跳过 —— 水面像素大多数离得远，这几条波正是开销大头 */
      if (dMid > 0.003) {
        var msx = 0, msz = 0;
        wcx = WV.mCx; wcz = WV.mCz; wk = WV.mK; wa = WV.mA; wt = WV.mT;
        for (wj = 0; wj < WV.nM; wj++) {
          var mv = fsin((x * wcx[wj] + z * wcz[wj]) * wk[wj] + wt[wj]) * wa[wj];
          msx += mv * wcx[wj];
          msz += mv * wcz[wj];
        }
        slx += msx * rp * 0.26 * dMid; slz += msz * rp * 0.26 * dMid;
      }
      var rough = slx * slx + slz * slz;
      /* 细纹：水面那层细碎反光（⑤ 的 curl）就来自它。它不进镜面法线，
         所以倒影照样干净。同样按距离淡出 + 跳过 */
      if (dFine > 0.003) {
        wcx = WV.fCx; wcz = WV.fCz; wk = WV.fK; wa = WV.fA; wt = WV.fT;
        for (wj = 0; wj < WV.nF; wj++) {
          var fv = fsin((x * wcx[wj] + z * wcz[wj]) * wk[wj] + wt[wj]) * wa[wj];
          fxs += fv * wcx[wj];
          fzs += fv * wcz[wj];
        }
        /* 坡度 0.14：再大 curl 会撞上限、糊成一片均匀的「气泡膜」 */
        fxs *= 0.14 * rp * dFine; fzs *= 0.14 * rp * dFine;
      }

      /* --- ① 折射：池底被整张面推着晃 ---
         位移只能用中慢波（波长 1~7m）。细纹的相位变得太快，逐像素采样
         会把砖缝撕成虚线 —— 想让池底「碎」，交给下面按对比度做的模糊 */
      var tBb = tB > tW ? tB : tW + 0.01;
      /* 位移系数 0.20 → 0.38：池底砖缝被水推着走的幅度大了近一倍，
         静止站在水里也能一眼看出「水在动」。老版 13cm 那次是 0.9 上下，
         0.38 大约 5~6cm —— 还没到「浴帘」那种把瓷砖拉成一片波浪线的程度 */
      var ampS = dep > 1.1 ? 0.38 : dep * 0.36;
      var dux = slx * ampS, duz = slz * ampS;
      var bx = camX + tBb * dx + dux;
      var bz = camZ + tBb * dz + duz;

      /* --- ② 池底光网：很淡的一层，只当细节 --- */
      /* 格子放大一倍、时间放慢一半：参考里的水底光是一大片一大片缓慢明灭的，
         不是一张细碎抖动的网。碎网正是「太像真水」的主要来源 */
      var nn = 0;
      for (wj = 0; wj < WV.nC; wj++) {
        nn += fsin((bx * WV.cCx[wj] + bz * WV.cCz[wj]) * WV.cK[wj] + WV.cT[wj]);
      }
      nn *= 0.83;                      // 四束等权
      var lw = 6 / (1 + h * 0.10);
      var caus = 1 - (nn < 0 ? -nn : nn) * lw;
      caus = caus > 0 ? caus * caus : 0;

      /* 池底：模糊靠「高频对比度掉下来」，不是多采一次样。
         流得急的地方（细纹坡度大）砖缝先化开，水面平的格子间还是清楚的 ——
         于是同一个池底上有「清楚」和「糊」的斑块，而且这些斑块在流动 */
      var wob = (fxs < 0 ? -fxs : fxs) + (fzs < 0 ? -fzs : fzs);
      poolSoft = wob * 3.4;
      if (poolSoft > 0.9) poolSoft = 0.9;
      /* 光网这一档以前压到 0.1（对池底只有 ±2% 的明暗），静止看就是「一块
         不会动的瓷砖」；0.34 大约是 ±7%，成了缓慢游走的一片亮带 ——
         那是隔着水面看时「水在动」最直接的一条线索，又不会亮成白条纹 */
      shadePoolBottom(bx, bz, tBb * lh, caus * 0.34);
      poolSoft = 0;

      /* --- ③ 透：水要像空气。两米深的池底基本原色，
             只有远距离 / 深水才慢慢吃掉一点红光 --- */
      var ur = or, ug = og, ub = ob;
      var path = (tBb - tW) * lh;
      var kR, kG, kB;
      if (S.water.absorb > 0) {
        var pi3 = (path * 4) | 0;
        if (pi3 > 319) pi3 = 319; else if (pi3 < 0) pi3 = 0;
        var kp = 0.62 + 0.38 * W2.clarity;
        kR = kp * TWR[pi3];
        kG = kp * TWG[pi3];
        kB = kp * TWB[pi3];
        if (kR > 1) kR = 1; if (kG > 1) kG = 1; if (kB > 1) kB = 1;
      } else {
        var vis = 1 / (1 + path * 0.045);
        if (vis > 1) vis = 1;
        kR = kG = kB = vis;
      }
      or = mixv(W2.rgb[0] * 0.9, ur, kR);
      og = mixv(W2.rgb[1] * 0.93, ug, kG);
      ob = mixv(W2.rgb[2] * 0.95, ub, kB);

      /* --- ④ 真镜面：把视线按水面法线真的反射一次，再拿它去打天花板。
             倒影会被波面揉弯、掠射时自己就拉成长条 ——
             这一层才是「立体」的关键：亮暗是跟着同一张面的形状走的 --- */
      /* 镜面用的坡度要比折射那套小一档：反射距离有 10~30m，坡度 0.8 就相当于
         把倒影平移十几米，倒影会彻底散掉、只剩波纹。参考视频里水面几乎是平的，
         云影「认得出」、只是边缘在慢慢摇 —— 那个才是镜面感 */
      /* 镜面：参考里的倒影几乎是准的，只有那张大起伏在慢慢揉它，
         所以法线只取慢波的一小部分，细纹完全不参与 */
      /* 对齐视频：法线只取慢波的 0.24 档，细纹完全不参与 —— 视频里水面几乎是
         平的，云影「认得出」、只有那张大起伏在慢慢揉它。细纹一进法线，倒影立刻散掉 */
      var nsx = slx * 0.24, nsz = slz * 0.24;
      var vn = dy - nsx * dx - nsz * dz;             // V·n，n = (-nsx, 1, -nsz)
      var kk = 2 * vn / (nsx * nsx + nsz * nsz + 1);
      var rY = dy - kk;
      var fi = h > 318 ? 318 : (h > 0 ? h | 0 : 0);
      var fres = FRES[fi] * (0.85 + 0.2 * (rough < 1.4 ? rough : 1.4));
      if (fres > 1) fres = 1;
      var tin = S.light.reflTint;
      /* glow 必须在两条分支上都算出来：⑤ 那层柔光还要用它（少一条就是 NaN → 黑斑） */
      var reflR, reflG, reflB, glow;
      if (rY > 1e-4) {
        var tr = (S.room.h - W2.y) / rY;
        var hx = x + tr * (dx + kk * nsx), hz = z + tr * (dz + kk * nsz);
        glow = gridAt(S.glowGrid, hx, hz);
        var lit = glow * glow * 1.8 * W2.sheen;      // 平方：亮处过曝成白，暗处压下去
        if (lit > 1.5) lit = 1.5;
        reflR = tin[0] * lit; reflG = tin[1] * lit; reflB = tin[2] * lit;
        /* 倒影要是打进了天窗，就直接取那个方向的天空 —— 太阳的亮斑因此落在
           水面上太阳那一侧，而不是「天花板上那块亮」。天空是按方向算的，
           所以波纹一推，亮斑自己就散开、拉长。
           注意 shadeSky 会写 or/og/ob，先把自己的水色收好再调它 */
        var sk2 = skyAt(hx, hz);
        if (sk2 > 0.001) {
          var wR = or, wG = og, wB = ob;
          shadeSky(dx + kk * nsx, rY, dz + kk * nsz);
          reflR = mixv(reflR, or, sk2);
          reflG = mixv(reflG, og, sk2);
          reflB = mixv(reflB, ob, sk2);
          or = wR; og = wG; ob = wB;
        }
      } else {
        glow = gridAt(S.glowGrid, x + rowReflT * dx, z + rowReflT * dz);
        var lit2 = glow * glow * 1.8 * W2.sheen;
        if (lit2 > 1.5) lit2 = 1.5;
        reflR = tin[0] * lit2; reflG = tin[1] * lit2; reflB = tin[2] * lit2;
      }
      or = mixv(or, reflR, fres * 0.88);
      og = mixv(og, reflG, fres * 0.88);
      ob = mixv(ob, reflB, fres * 0.88);

      /* --- ⑤ 大面柔光 + 细皱褶的反光，同样取自这张面 --- */
      var fm = 1 - ((slx < 0 ? -slx : slx) + (slz < 0 ? -slz : slz)) * 0.5;
      if (fm < 0) fm = 0;
      var gloss = (0.5 + fres * 1.2) * W2.sheen;
      /* 细皱褶的反光：这一项才是「一个个小波」的样子 —— 每个小波面各自把光
         反进眼睛，所以是一层细密的亮格子。上一版把它压死了（clamp 到 1、
         系数 0.6），整片水面就只剩一层平光 */
      var curl = (fxs * fxs + fzs * fzs) * 30;
      if (curl > 1.2) curl = 1.2;
      var spec = gloss * (fm * (0.2 + glow * 0.8) + curl * (0.22 + glow) * 0.5);
      /* 这层柔光是「贴着水面斜看」才该有的。从池边往下俯视时，
         水应该像空气 —— 池底才是主角，糊一层白雾就什么都看不见了。
         所以按俯角把 spec 压下去：越正对它、越不留 */
      var lookDown = -dy;                    // dy < 0 = 往下看
      if (lookDown < 0) lookDown = 0; else if (lookDown > 1) lookDown = 1;
      var graze = 1 - lookDown;
      spec *= 0.15 + 0.85 * graze * graze;
      or += spec * 0.7; og += spec * 0.72; ob += spec * 0.74;
      /* 光网是「打到池底的光」，所以除了隔着水看的那层，还要再乘池底照度 ——
         九米多的池底照不到光，光网就该一起没了 */
      /* 水面上那层光网白分量：参考里没有这种白条纹，只留一丝 */
      var cw = caus * W2.clarity * (0.015 + kG * 0.02) * botLitG;
      if (cw > 0.002) {
        var cc = W2.caustic;
        or += cw * cc[0]; og += cw * cc[1]; ob += cw * cc[2];
      }
      fogMix(h);
    }

    /* 从水下抬头看水面：斯涅尔窗。
       垂直往上看是一小片「窗口」—— 外面的天光从那里漏进来，很亮；
       视线越斜越暗，超过临界角就全反射，只剩水的颜色。窗口边缘被波纹揉开，
       所以这里用同一套中尺度波给亮度加一点抖动，而不是画一圈硬边 */
    function shadeWaterUnder(x, z, h, dyUp) {
      var W2 = S.water, k = dyUp;              // 0 = 掠射，1 = 正上方
      if (k < 0) k = 0; else if (k > 1) k = 1;

      /* 波纹把这个边界揉开：水面在动，窗口的边缘就不是一条几何直线 */
      var wv = 0;
      if (W2.ripple > 0.05) {
        var wcx = WV.mCx, wcz = WV.mCz, wk2 = WV.mK, wa2 = WV.mA, wt2 = WV.mT, j;
        for (j = 0; j < WV.nM && j < 3; j++) {
          wv += fsin((x * wcx[j] + z * wcz[j]) * wk2[j] + wt2[j]) * wa2[j];
        }
        wv *= W2.ripple * 0.9;
      }

      /* 临界角 48.6°（cos ≈ 0.66）：以内是窗口 —— 外面的光直接透进来；
         以外全是全反射 —— 只剩水的颜色和一点池壁的反光 */
      var e = (k - 0.60 + wv * 0.07) / 0.17;
      if (e < 0) e = 0; else if (e > 1) e = 1;
      var win = e * e * (3 - 2 * e);

      /* 全反射那一圈是面镜子：映的是池壁和池底，也就是一层泡了水的瓷砖。
         所以反射色用池砖色，而不是水色 —— 水色只会把它压成一块黑。
         越掠射（k 越小）映到的是远处被灯照亮的池壁，反而更亮 */
      var rt = S.pal.poolTile;
      var refl = (0.72 + 0.22 * (1 - k)) * (0.88 + 0.24 * wv);
      if (refl < 0.2) refl = 0.2;
      var dr = rt[0] * refl * 0.86, dg = rt[1] * refl, db = rt[2] * refl * 1.02;
      /* 窗口里：被压缩的天光，偏白偏亮 */
      var skyR = 0.86 + 0.08 * wv, skyG = 0.95 + 0.05 * wv, skyB = 1.0;
      or = dr + (skyR - dr) * win;
      og = dg + (skyG - dg) * win;
      ob = db + (skyB - db) * win;
      fogMix(h);
    }

    /* 水下：把「水在流」落到瓷砖上。
       水面以下没有折射面可以借，所以要自己做两件事 ——
       ① 采样点按中尺度波横向错开几厘米（砖缝跟着游）；
       ② 砖缝对比度按同一个缓动量压下去（隔水看，糊）。
       缓存到 uwW 里，同一次命中点的墙和底共用一份。 */
    function uwFlow(x, z) {
      var w = 0, j;
      for (j = 0; j < WV.nM && j < 3; j++) {
        w += fsin((x * WV.mCx[j] + z * WV.mCz[j]) * WV.mK[j] + WV.mT[j]) * WV.mA[j];
      }
      uwW = w * 0.5;
      return uwW;
    }

    /* 水下池底的焦散：和岸上看到的是同一套光网，只是这里直接铺在池底上。
       没有它，水下就是一排静止的瓷砖 —— 光斑流动才是「在水里」最直观的证据 */
    function uwCaustic(x, z, h) {
      var nn = 0, j;
      for (j = 0; j < WV.nC; j++) {
        nn += fsin((x * WV.cCx[j] + z * WV.cCz[j]) * WV.cK[j] + WV.cT[j]);
      }
      nn *= 0.83;
      var lw = 6 / (1 + h * 0.10);
      var c = 1 - (nn < 0 ? -nn : nn) * lw;
      return c > 0 ? c * c : 0;
    }

    /* ==================================================================
      道具求交 / 着色
      ================================================================== */
    /* 近裁剪：t 是「未归一化方向」上的参数，同一个 t 在不同像素对应不同实际距离，
       所以这里只能用一个极小的值来判「在身后 / 相机就在里面」，千万不能写 0.06 之类的数
       —— 那在宽视角下等于十几米的近裁剪面，会把所有道具整个裁掉 */
    var PROP_TN = 1e-4;
    var phX = 0, phY = 0, phZ = 0, phNx = 0, phNy = 1, phNz = 0;
    var phMode = 0, phR = 1, phG = 1, phB = 1;

    /* 命中就返回 t 并把 ph* 写好；没命中、或不如 tMax 近，返回 0 */
    function prHit(p, ox, oy, oz, dx, dy, dz, tMax) {
      var b = prBase[p], tp = prType[p];
      if (tp === 0) {
        /* 竖圆柱：只算侧面（顶底被伞面 / 地面挡着，不测圆盘） */
        var cx = prF[b], cz = prF[b + 1], r = prF[b + 2];
        var ex = ox - cx, ez = oz - cz;
        var a = dx * dx + dz * dz;
        if (a < 1e-9) return 0;
        var hb = ex * dx + ez * dz;
        var hc = ex * ex + ez * ez - r * r;
        var disc = hb * hb - a * hc;
        if (disc < 0) return 0;
        var sq = Math.sqrt(disc);
        var t = (-hb - sq) / a;
        if (t < PROP_TN) t = (-hb + sq) / a;
        if (t < PROP_TN || t >= tMax) return 0;
        var hy = oy + t * dy;
        if (hy < prF[b + 3] || hy > prF[b + 4]) return 0;
        phX = ox + t * dx; phY = hy; phZ = oz + t * dz;
        var ir = 1 / r;
        phNx = (phX - cx) * ir; phNy = 0; phNz = (phZ - cz) * ir;
        phMode = prF[b + 5]; phR = prF[b + 6]; phG = prF[b + 7]; phB = prF[b + 8];
        return t;
      }
      if (tp === 1) {
        /* 椭球顶：上半是伞面，下半当伞底（一个平的椭圆盘） */
        var cx2 = prF[b], cy2 = prF[b + 1], cz2 = prF[b + 2];
        var rx = prF[b + 3], ry = prF[b + 4], rz = prF[b + 5];
        var ex2 = (ox - cx2) / rx, ey2 = (oy - cy2) / ry, ez2 = (oz - cz2) / rz;
        var gx = dx / rx, gy = dy / ry, gz = dz / rz;
        var a2 = gx * gx + gy * gy + gz * gz;
        var b2 = ex2 * gx + ey2 * gy + ez2 * gz;
        var c2 = ex2 * ex2 + ey2 * ey2 + ez2 * ez2 - 1;
        var di2 = b2 * b2 - a2 * c2;
        if (di2 >= 0) {
          var sq2 = Math.sqrt(di2);
          var t2 = (-b2 - sq2) / a2;
          if (t2 < PROP_TN) t2 = (-b2 + sq2) / a2;
          if (t2 >= PROP_TN && t2 < tMax) {
            var hY = oy + t2 * dy - cy2;
            if (hY >= 0) {
              phX = ox + t2 * dx; phY = oy + t2 * dy; phZ = oz + t2 * dz;
              var nx = (phX - cx2) / (rx * rx), ny = hY / (ry * ry), nz = (phZ - cz2) / (rz * rz);
              var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
              phNx = nx / nl; phNy = ny / nl; phNz = nz / nl;
              phMode = prF[b + 6]; phR = prF[b + 7]; phG = prF[b + 8]; phB = prF[b + 9];
              return t2;
            }
          }
        }
        /* 伞底：从下往上打到 y = cy2 的椭圆盘 */
        if (dy > 1e-9) {
          var t3 = (cy2 - oy) / dy;
          if (t3 >= PROP_TN && t3 < tMax) {
            var hx3 = ox + t3 * dx - cx2, hz3 = oz + t3 * dz - cz2;
            var u3 = hx3 / rx, w3 = hz3 / rz;
            if (u3 * u3 + w3 * w3 <= 1) {
              phX = ox + t3 * dx; phY = cy2; phZ = oz + t3 * dz;
              phNx = 0; phNy = -1; phNz = 0;
              phMode = prF[b + 6]; phR = prF[b + 7]; phG = prF[b + 8]; phB = prF[b + 9];
              return t3;
            }
          }
        }
        return 0;
      }
      /* 平行四边形：求交后投影到两条边上看是不是落在 [0,1]² */
      var nx4 = prF[b + 3], ny4 = prF[b + 4], nz4 = prF[b + 5];
      var den = dx * nx4 + dy * ny4 + dz * nz4;
      if (den > -1e-9 && den < 1e-9) return 0;
      var t4 = ((prF[b] - ox) * nx4 + (prF[b + 1] - oy) * ny4 + (prF[b + 2] - oz) * nz4) / den;
      if (t4 < PROP_TN || t4 >= tMax) return 0;
      var qx = ox + t4 * dx - prF[b], qy = oy + t4 * dy - prF[b + 1], qz = oz + t4 * dz - prF[b + 2];
      var uu = (qx * prF[b + 6] + qy * prF[b + 7] + qz * prF[b + 8]) * prF[b + 9];
      if (uu < 0 || uu > 1) return 0;
      var vv = (qx * prF[b + 10] + qy * prF[b + 11] + qz * prF[b + 12]) * prF[b + 13];
      if (vv < 0 || vv > 1) return 0;
      phX = ox + t4 * dx; phY = oy + t4 * dy; phZ = oz + t4 * dz;
      if (nx4 * (ox - phX) + ny4 * (oy - phY) + nz4 * (oz - phZ) < 0) {
        phNx = -nx4; phNy = -ny4; phNz = -nz4;
      } else {
        phNx = nx4; phNy = ny4; phNz = nz4;
      }
      phMode = prF[b + 14]; phR = prF[b + 15]; phG = prF[b + 16]; phB = prF[b + 17];
      return t4;
    }

    /* 道具着色：塑料件。主光从上下来（朝上的面亮），伞底压暗；
       2 = 水帘走水路那套色，1 = 伞面带白点 */
    function shadeProp(hitH, wet) {
      var c0 = phR, c1 = phG, c2 = phB, m = phMode;
      var l = gridAt(S.lightGrid, phX, phZ) * S.light.intensity;
      var lam = 0.5 + 0.5 * phNy;
      var k = (0.5 + 0.62 * l) * (0.62 + 0.42 * lam);
      if (m === 1) {
        if (phNy < -0.35) {
          k *= 0.4;                                        /* 伞底：见不到光 */
        } else {
          var iu = (phNx * 4.2) | 0, iv = (phNz * 4.2) | 0;
          if (S.tile.vary > 0.01 && tileHash(iu, iv, S.seed + 77) > 0.7) { c0 = 0.96; c1 = 0.95; c2 = 0.9; k *= 1.08; }
        }
      } else if (m === 2) {
        var w = S.water.rgb;
        var st = fsin(phY * 8.5 + tt * 3.6) * 0.5 + 0.5;
        c0 = mixv(w[0], 0.95, 0.26 + st * 0.3);
        c1 = mixv(w[1], 0.98, 0.26 + st * 0.3);
        c2 = mixv(w[2], 1, 0.26 + st * 0.3);
        k = 0.82 + st * 0.3;
      } else if (m === 3) {
        k *= 1.06;                                         /* 滑道面：亮一点，下段更湿 */
        if (phY < 0.5) k *= 1 - (0.5 - phY) * 0.35;
      }
      or = c0 * k; og = c1 * k; ob = c2 * k;
      if (wet) {
        /* 沉在水里的那截：压一层水色 + 稍微压暗，近似「透过水看」。
           压太重会和周围的水糊成一片、看着就是被切断了 */
        var wm = S.water.rgb, wt = 0.22 + S.water.clarity * 0.2;
        or = mixv(or, wm[0] * 0.78, wt) * 0.92;
        og = mixv(og, wm[1] * 0.86, wt) * 0.92;
        ob = mixv(ob, wm[2] * 0.9, wt) * 0.92;
      }
      fogMix(hitH);
    }

    /* 伞底下那一圈贴地阴影（池底与地面各乘一次） */
    function propShadow(px, pz) {
      if (propShadeN === 0) return 1;
      for (var i = 0; i < propShadeN; i++) {
        var b = i * 4;
        var sx = px - propSH[b], sz = pz - propSH[b + 1], sr = propSH[b + 2];
        var d2 = sx * sx + sz * sz;
        if (d2 < sr * sr) {
          var f = 1 - d2 / (sr * sr);
          return 1 - propSH[b + 3] * f * f * 0.62;
        }
      }
      return 1;
    }

    /* 一块砖在屏幕上还剩多少像素。远到不足一像素时，砖缝与逐砖噪声都会
       退化成摩尔纹（远看像撒了一层沙），所以按这个值把细节淡掉 ——
       等于给程序纹理手工做一遍 mipmap。tilePxK 每帧按投影与瓷砖尺寸算。 */
    /* 砖在屏幕上还剩几像素 → 细节保留多少（等于给程序纹理手工做 mipmap）。
       两种掉法不一样，别混：
         · 竖直方向看地面 / 天花板（掠射）：砖的屏幕尺寸按 1/距离² 掉；
         · 横向看墙：按 1/距离 掉，还要乘「墙的走向与屏幕横向的夹角余弦」。
       取两者里更扁的那个，低于约一像素就把砖缝和逐砖噪声淡掉 —— 不然远看
       是一层沙（摩尔纹）。 */
    var tilePxK = 1, ceilPxK = 1;
    var kFloorVert = 1, kBotVert = 1, kCeilVert = 1;
    var absRx = 1, absRz = 0, absUy = 1, wallU = 1;
    /* 每帧的「砖格像素尺度」：absRx*tilePxK 这类式子整帧是常数，
       逐像素再乘一次纯属白算 —— 预乘好，热循环里只剩一次乘以 1/h */
    var pxUK = 1, pxVK = 1, pxCUK = 1, pxCVK = 1, pxVWallK = 1;
    /* 预混好的砖缝档位里挑一档（0 = 纯底色，8 = 纯缝色）。
       9 档是为了让「面积平均」那点很小的暗度（0.1 上下）也能取准 */
    function gpick(tab, cov) {
      return tab[cov >= 1 ? 8 : (cov * 8 + 0.5) | 0];
    }

    /* 一个像素落在砖缝里时返回缝的覆盖率（0 = 没落在缝里），给缝做抗锯齿：
       缝在屏幕上不足一像素时，把它**加宽到一像素、颜色按比例变淡** ——
       总「墨量」不变，但不会断成一串点（那在远景里看着像撒了一层沙）。 */
    /* 缝的暗度（已经合成好的一层，直接喂给 gpick）：
       · 缝够宽（≥1 像素）：盒式一维抗锯齿画实线 —— 距缝中心半像素以内吃满；
       · 缝细到亚像素：线会变成一层「点阵」（网格在像素栅格上的摩尔纹，
         黑缝尤其难看），所以不画线，改成整块砖按缝占的面积均匀压暗 ——
         那是面积平均，平得干净。
       两个机制都朝同一个缝色混，所以能合成一个标量。 */
    function groutCov(fu, fv, frac, pxU, pxV) {
      var wU = frac * pxU, wV = frac * pxV;
      var tU = wU >= 1.05 ? 1 : (wU <= 0.55 ? 0 : (wU - 0.55) / 0.5);
      var tV = wV >= 1.05 ? 1 : (wV <= 0.55 ? 0 : (wV - 0.55) / 0.5);
      /* 实线那一半：盒式 AA，再乘上「这一族还清不清」 */
      var line = 0, d, q;
      if (tU > 0) {
        d = (fu - frac * 0.5) * pxU;
        if (d < 0) d = -d;
        q = (wU * 0.5 + 0.5 - d) * tU;
        if (q > line) line = q;
      }
      if (tV > 0) {
        d = (fv - frac * 0.5) * pxV;
        if (d < 0) d = -d;
        q = (wV * 0.5 + 0.5 - d) * tV;
        if (q > line) line = q;
      }
      /* 面积平均那一半：缝占的面积 × 这一族糊掉的程度 */
      var flat = (frac * 2 - frac * frac) * 0.5 * ((1 - tU) + (1 - tV));
      var amt = flat + line * (1 - flat);
      return amt <= 0 ? 0 : (amt > 1 ? 1 : amt);
    }

    function detailFromPx(px) {
      if (px >= 2.2) return 1;
      if (px <= 1.0) return 0;
      var t = (px - 1.0) / 1.2;
      return t * t * (3 - 2 * t);
    }

    /* 每帧写入的反光采样距离（水面镜面打到天花板的高度差 / 下降速率） */
    var rowReflT = 0;

    /* ---------- 一帧 ---------- */
    function render(cam, opts) {
      if (destroyed || !data || W <= 0 || H <= 0) return stats;
      opts = opts || {};
      var t0 = (root.performance && root.performance.now) ? root.performance.now() : Date.now();

      /* 不传就落在场景自己的默认视角上 */
      var yaw = (cam.yaw == null ? S.camera.yaw : cam.yaw) % (Math.PI * 2);
      var pitch = clamp(cam.pitch == null ? S.camera.pitch : cam.pitch, -0.62, 0.62);
      var fov = clamp(cam.fov || 62, 28, 105);
      exposure = cam.light == null ? 1 : clamp(cam.light, 0.25, 1.8);
      var proj = (H * 0.5) / Math.tan(fov * 0.5 * DEG);
      tilePxK = S.tile.size * proj;      // 砖格在 1 米处的屏幕像素数
      ceilPxK = S.tile.ceilSize * proj;

      var cy = Math.sin(pitch), cp = Math.cos(pitch), sy = Math.sin(yaw), cyw = Math.cos(yaw);
      /* F 前 / R 右 / U 上（无 roll，所以 R.y 恒为 0） */
      var Fx = sy * cp, Fy = cy, Fz = -cyw * cp;
      var Rx = cyw, Rz = sy;
      /* 墙面的横向压缩：u 轴是 x 的墙（前后墙）与屏幕横向夹角是 cos(yaw)，
         u 轴是 z 的墙（侧墙）是 sin(yaw)。侧墙几乎侧对着看时砖会被压成
         亚像素，细节淡出要按这个再收一道 */
      absRx = Rx < 0 ? -Rx : Rx;
      absRz = Rz < 0 ? -Rz : Rz;
      var Ux = -sy * cy, Uy = cp, Uz = cyw * cy;

      camX = cam.x == null ? S.camera.x : cam.x;
      camZ = cam.z == null ? S.camera.z : cam.z;
      /* 下限要放到池底：沉到水里时 eye = 池底 + 站高，还是负的。
         以前这里按「岸上离地 0.4m」夹，人一进水整幅画面就被抬回岸上 */
      camY = clamp(cam.height == null ? S.camera.height : cam.height, -S.pool.depth + 0.3, S.room.h - 0.35);
      /* 竖直方向的「每像素看到多少米」：地面/天花板是 1/距离²，
         横向是 1/距离×方向余弦，所以两边的比例系数分开存 */
      absUy = Uy < 0.06 ? 0.06 : Uy;
      kFloorVert = tilePxK * camY / absUy;
      kBotVert = tilePxK * (camY + S.pool.depth) / absUy;
      kCeilVert = ceilPxK * (S.room.h - camY) / absUy;
      pxUK = absRx * tilePxK; pxVK = absRz * tilePxK;
      pxCUK = absRx * ceilPxK; pxCVK = absRz * ceilPxK;
      pxVWallK = absUy * tilePxK;
      /* ω 是物理频率（色散关系 ω=√(g·k)），这里只做整体快慢的缩放 */
      tt = (cam.time || 0) * WAVE_SPEED;
      /* 相位里的时间项 φ − ω·t：整帧算一次，逐像素只多做一次加法 */
      var wj = 0;
      for (wj = 0; wj < WV.nS; wj++) WV.sT[wj] = WV.sPh[wj] - WV.sO[wj] * tt;
      for (wj = 0; wj < WV.nM; wj++) WV.mT[wj] = WV.mPh[wj] - WV.mO[wj] * tt;
      for (wj = 0; wj < WV.nF; wj++) WV.fT[wj] = WV.fPh[wj] - WV.fO[wj] * tt;
      for (wj = 0; wj < WV.nC; wj++) WV.cT[wj] = WV.cPh[wj] - WV.cO[wj] * tt;

      var waterY = S.water.y;
      var roomH = S.room.h, halfW = S.room.halfW, halfD = S.room.halfD;
      var pool = S.pool, flooded = S.flags.flooded;

      /* 眼睛沉到水面以下 = 水下视角。这时候「地板/墙/天花板」整套假设都要反过来：
         地面在头顶、池底成了地板、抬头看到的是水面的背面 */
      var underwater = camY < waterY - 0.015;
      /* 眼睛低于池沿地面 = 人站在池子里（可能是干池）。这时「地板在头顶、
         池底才是地板」这件事同样成立，和在水下是一套几何 */
      var underDeck = camY < -0.02;
      uwMode = underwater ? 1 : 0;

      /* 雾表：按水平距离查，省掉每像素的除法 */
      var fogN = S.fog.near, fogSpan = Math.max(0.5, S.fog.far - S.fog.near), fogD = S.fog.density;
      if (underwater) {
        /* 清水，不是浑水：几米之内几乎不掉对比，只是慢慢染上一层青。
           上一版按「能见度 4.6m 的浓雾」算，池壁直接糊成一片黑 ——
           那是夜里的湖，不是泳池。泳池的水本来就该看得清瓷砖 */
        /* 关键是「雾色要够亮」：清水是往青色里沉，不是往黑里沉。
           近处（几米）几乎不动，远处才慢慢沉下去 —— 这样既有水的厚度，
           又不会像上一版那样把四米外的池壁糊死 */
        fogN = 1.6; fogSpan = 24; fogD = 0.55;
        FOG_RGB[0] = S.water.rgb[0] * 0.40;
        FOG_RGB[1] = S.water.rgb[1] * 0.66;
        FOG_RGB[2] = S.water.rgb[2] * 0.78;
      } else {
        FOG_RGB[0] = S.fog.rgb[0]; FOG_RGB[1] = S.fog.rgb[1]; FOG_RGB[2] = S.fog.rgb[2];
      }
      for (var fi1 = 0; fi1 < 320; fi1++) {
        var a1 = (fi1 - fogN) / fogSpan;
        if (a1 < 0) a1 = 0; else if (a1 > 1) a1 = 1;
        FOG[fi1] = a1 * a1 * (3 - 2 * a1) * fogD * 0.92;      // smoothstep：近处不糊，远处化开
      }
      /* 水体吸收表 + 池底照度：光要穿 waterDepth 米才到池底（回程算在视线那层），
         所以池底只剩 exp(-a·水深) 那点亮度 —— 深池的池底就是这样黑掉的 */
      if (S.water.absorb > 0) {
        for (var fi3 = 0; fi3 < 320; fi3++) {
          var pm = fi3 * 0.25;
          TWR[fi3] = Math.exp(-S.water.aR * pm);
          TWG[fi3] = Math.exp(-S.water.aG * pm);
          TWB[fi3] = Math.exp(-S.water.aB * pm);
        }
        var wd = S.water.depth;
        botLitR = wd > 0 ? Math.exp(-S.water.aR * wd) : 1;
        botLitG = wd > 0 ? Math.exp(-S.water.aG * wd) : 1;
        botLitB = wd > 0 ? Math.exp(-S.water.aB * wd) : 1;
      }

      /* 水面菲涅尔表：视线越平，反射越强 */
      var camW = Math.max(0.05, camY - waterY);
      for (var fi2 = 0; fi2 < 320; fi2++) {
        var sa = camW / Math.sqrt(fi2 * fi2 + camW * camW);
        var fp = 1 - sa;
        FRES[fi2] = fp * fp * fp * 0.92;
      }

      /* ---- 行表 ---- */
      for (var py = 0; py < H; py++) {
        var ay = (1 - 2 * (py + 0.5) / H) * (H * 0.5);
        var dy = Fy * proj + Uy * ay;
        rowDY[py] = dy;
        if (dy < -1e-5) {
          var invNeg = 1 / -dy;
          /* 水下：地板（y=0）在头顶上方、水面也在头顶上方，
             往下看能撞到的只有池底 —— 这两项必须作废，否则会算出负距离 */
          rowTF[py] = (underwater || underDeck) ? 1e9 : camY * invNeg;
          rowTW[py] = underwater ? 1e9 : (camY - waterY) * invNeg;
          rowTB[py] = (camY + pool.depth) * invNeg;
          rowTC[py] = 1e9;
          rowWK[py] = invNeg;
          rowRT[py] = (roomH - waterY) * invNeg;      // 水面的镜像会打到天花板上的这个距离
        } else if (dy > 1e-5) {
          var invUp = 1 / dy;
          rowTF[py] = 1e9; rowTW[py] = 1e9; rowTB[py] = 1e9;
          rowTC[py] = (roomH - camY) * invUp;
          rowWK[py] = invUp;
          rowRT[py] = 1e9;
        } else {
          rowDY[py] = 0; rowTF[py] = 1e9; rowTW[py] = 1e9; rowTB[py] = 1e9; rowTC[py] = 1e9; rowWK[py] = 1e9;
          rowRT[py] = 1e9;
        }
      }

      /* ---- 列表 ---- */
      var invW2 = 1 / (W * 0.5);
      for (var px = 0; px < W; px++) {
        /* 横轴必须和纵轴用同一个像素尺度：ax 归一化到 [-1,1] 再乘 W/2。
           这里曾经多写了一个 2 倍，等于把画面水平拉伸两倍、光轴还偏到了
           1/4 宽处 —— 房间会看着被压扁，转动时像被扭曲 */
        var ax = ((px + 0.5) * invW2 - 1) * (W * 0.5);
        var dx = Fx * proj + Rx * ax;
        var dz = Fz * proj + Rz * ax;
        colDX[px] = dx; colDZ[px] = dz;
        var lh = Math.sqrt(dx * dx + dz * dz);
        if (lh < 1e-6) lh = 1e-6;
        colLH[px] = lh;
        var txw = dx > 1e-9 ? (halfW - camX) / dx : (dx < -1e-9 ? (-halfW - camX) / dx : 1e9);
        var tzw = dz > 1e-9 ? (halfD - camZ) / dz : (dz < -1e-9 ? (-halfD - camZ) / dz : 1e9);
        if (txw < tzw) {
          colTW[px] = txw;
          colWID[px] = dx > 0 ? 1 : 0;
          colWU[px] = camZ + txw * dz;
        } else {
          colTW[px] = tzw;
          colWID[px] = dz > 0 ? 3 : 2;
          colWU[px] = camX + tzw * dx;
        }
        /* 池子矩形在 XZ 平面上的进出距离 */
        var txim, txax, tzim, tzax;
        if (dx > 1e-9) { txim = (pool.x0 - camX) / dx; txax = (pool.x1 - camX) / dx; }
        else if (dx < -1e-9) { txim = (pool.x1 - camX) / dx; txax = (pool.x0 - camX) / dx; }
        else { txim = (camX > pool.x0 && camX < pool.x1) ? -1e9 : 1e9; txax = -txim; }
        if (dz > 1e-9) { tzim = (pool.z0 - camZ) / dz; tzax = (pool.z1 - camZ) / dz; }
        else if (dz < -1e-9) { tzim = (pool.z1 - camZ) / dz; tzax = (pool.z0 - camZ) / dz; }
        else { tzim = (camZ > pool.z0 && camZ < pool.z1) ? -1e9 : 1e9; tzax = -tzim; }
        colOUT[px] = txax < tzax ? txax : tzax;
        colEXA[px] = txax < tzax ? 0 : 1;                 // 0：从 x 面出去，1：从 z 面出去
        colWX[px] = camX + colTW[px] * dx;              // 墙面命中点的世界坐标（取光用）
        colWZ[px] = camZ + colTW[px] * dz;
      }

      /* ---- 道具：逐列预筛（包围圆柱），把可能命中的基本体列成短表 ---- */
      if (hasProps) {
        for (var pxq = 0; pxq < W; pxq++) {
          var dxq = colDX[pxq], dzq = colDZ[pxq];
          var aq = dxq * dxq + dzq * dzq;
          var tmin = 1e9, wtmin = 1e9, cn = 0, base = pxq * CAND_MAX;
          if (aq > 1e-9) {
            for (var pq = 0; pq < prN; pq++) {
              var qb = pq * 5;
              var exq = camX - prBnd[qb], ezq = camZ - prBnd[qb + 1], rbq = prBnd[qb + 2];
              var bq = exq * dxq + ezq * dzq;
              var cq = exq * exq + ezq * ezq - rbq * rbq;
              var dsq = bq * bq - aq * cq;
              if (dsq < 0) continue;
              var tq = (-bq - Math.sqrt(dsq)) / aq;
              if (tq < 0) tq = 0;
              /* 高位置 1 表示「有沉在水下的部分」，逐像素时要单独走一趟 */
              if (prWet[pq]) {
                if (tq < wtmin) wtmin = tq;
                if (cn < CAND_MAX) candIdx[base + cn++] = pq | 256;
              } else {
                if (tq < tmin) tmin = tq;
                if (cn < CAND_MAX) candIdx[base + cn++] = pq;
              }
            }
          }
          candN[pxq] = cn;
          propTmin[pxq] = tmin;
          wetTmin[pxq] = wtmin;
        }
      }

      /* ---- 逐行逐列 ---- */
      /* opts.rows = [y0, y1]：只重画这一段（水面动画时用，天花板与墙不重画） */
      var y0 = 0, y1 = H;
      if (opts.rows && opts.rows.length === 2) {
        y0 = clamp(opts.rows[0] | 0, 0, H);
        y1 = clamp(opts.rows[1] | 0, 0, H);
        if (y1 <= y0) { y0 = 0; y1 = H; }
      }
      pid = y0 * W;
      /* 顺手记下「这一帧哪些行真的画了水」：空闲动画只重画这一段，
         比一律重画下半屏省一半以上，帧率就能提上去（行循环外每行判一次，不贵） */
      var wTop = -1, wBot = -1;
      for (var y3 = y0; y3 < y1; y3++) {
        var dy2 = rowDY[y3];
        var desc = dy2 < -1e-5, asc = dy2 > 1e-5;
        /* 掠射压缩：射线越接近水平，地面的一像素横跨的世界距离越长（砖被压扁），
           细节淡出要按这个再收一次，否则近水平的地面在远处化成一片沙 */
        var tF2 = rowTF[y3], tW2 = rowTW[y3], tB2 = rowTB[y3], tC2 = rowTC[y3], invNegDy2 = rowWK[y3];
        rowReflT = rowRT[y3];
        var rowWet = false;
        for (var x3 = 0; x3 < W; x3++) {
          var dx2 = colDX[x3], dz2 = colDZ[x3], lh2 = colLH[x3];
          var pPropT = 0, pPropI = -1;
          var tWall = colTW[x3];
          var yWall = camY + tWall * dy2;
          var wallOK = yWall >= -0.001 && yWall <= roomH;

          /* 道具：先定一个「这一像素最终会画到的那个面的距离」当上界，
             只有比上界更近的道具才算命中 —— 于是不需要再和各个分支比距离。
             分两趟：先找水面之上的；没找到、且是往下看的射线，再找沉在水下的那截 */
          if (hasProps && candN[x3] > 0) {
            var cbp = x3 * CAND_MAX, cnp = candN[x3], kp, pp2, htp;
            var tSurf = desc ? (flooded ? tW2 : tF2) : (asc ? tC2 : tWall);
            if (wallOK && tWall < tSurf) tSurf = tWall;
            if (propTmin[x3] < tSurf) {
              for (kp = 0; kp < cnp; kp++) {
                pp2 = candIdx[cbp + kp];
                if (pp2 > 255) continue;
                htp = prHit(pp2, camX, camY, camZ, dx2, dy2, dz2, tSurf);
                if (htp > 0) { pPropT = htp; pPropI = pp2; tSurf = htp; }
              }
            }
            if (pPropI < 0 && desc && wetTmin[x3] < 1e8) {
              var tWet = tB2;
              if (wallOK && tWall < tWet) tWet = tWall;
              if (wetTmin[x3] < tWet) {
                for (kp = 0; kp < cnp; kp++) {
                  pp2 = candIdx[cbp + kp];
                  if (pp2 < 256) continue;
                  htp = prHit(pp2 & 255, camX, camY, camZ, dx2, dy2, dz2, tWet);
                  if (htp > 0) { pPropT = htp; pPropI = pp2 & 255; tWet = htp; }
                }
              }
            }
            if (pPropI >= 0) {
              shadeProp(pPropT * lh2, phY < waterY ? 1 : 0);
              putPixel(); continue;
            }
          }

          if (desc) {
            if (underwater || underDeck) {
              /* 站在池子里往下看：地板（可能还有水面）都在头顶，
                 能撞到的只有池底和池内壁。
                 谁先算谁 —— 先出池子就是撞壁，否则就是池底 */
              var tExitD = colOUT[x3];
              if (tExitD < tB2) {
                var wxD = camX + tExitD * dx2, wzD = camZ + tExitD * dz2;
                var uOffD = 0;
                if (underwater) {
                  uwFlow(wxD, wzD);
                  uOffD = uwW * 0.12;
                  wallSoft = uwW < 0 ? -uwW * 1.1 : uwW * 1.1;
                  if (wallSoft > 0.85) wallSoft = 0.85;
                }
                shadeWall((colEXA[x3] === 0 ? wzD : wxD) + uOffD,
                  camY + tExitD * dy2, tExitD * lh2, 0, 1, wxD, wzD);
                wallSoft = 0;
              } else {
                var bxD = camX + tB2 * dx2, bzD = camZ + tB2 * dz2;
                var causD = 0;
                if (underwater) {
                  uwFlow(bxD, bzD);
                  bxD += uwW * 0.12; bzD += uwW * 0.12;
                  poolSoft = uwW < 0 ? -uwW * 1.1 : uwW * 1.1;
                  if (poolSoft > 0.85) poolSoft = 0.85;
                  causD = uwCaustic(bxD, bzD, tB2 * lh2) * 0.75;
                }
                shadePoolBottom(bxD, bzD, tB2 * lh2, causD);
                poolSoft = 0;
              }
              putPixel();
              continue;
            }
            var tFirst = flooded ? tW2 : tF2;
            if (wallOK && tWall < tFirst) {
              wallU = colWID[x3] < 2 ? absRz : absRx;
              shadeWall(colWU[x3], yWall, tWall * lh2, colWID[x3], 0, colWX[x3], colWZ[x3]);
              putPixel();
              continue;
            }
            var fX = camX + tFirst * dx2, fZ = camZ + tFirst * dz2;
            var inPool = fX > pool.x0 && fX < pool.x1 && fZ > pool.z0 && fZ < pool.z1;
            if (flooded) {
              /* 大厅进水：水面就是第一个面，池子上方那块底下更深 */
              var tBf = inPool ? tB2 : tF2;
              shadeWater(fX, fZ, tFirst * lh2, tFirst, tBf, dx2, dz2, lh2, dy2);
              rowWet = true;
              putPixel();
              continue;
            }
            if (!inPool) {
              shadeDeck(fX, fZ, tFirst * lh2, 0);
              putPixel();
              continue;
            }
            /* 池沿上有个洞：接着往下，可能是水面 / 池底 / 池内壁 */
            var tOut = colOUT[x3];
            if (tOut < tF2) tOut = tF2;
            var tBot = tB2;
            var hitWall = false, bX = 0, bZ = 0;
            if (tBot <= tW2) {
              /* 水面已经沉到池底下面 = 干池，直接看池底 */
              bX = camX + tBot * dx2; bZ = camZ + tBot * dz2;
              if (!(bX > pool.x0 && bX < pool.x1 && bZ > pool.z0 && bZ < pool.z1)) hitWall = true;
            } else {
              var sX = camX + tW2 * dx2, sZ = camZ + tW2 * dz2;
              if (sX > pool.x0 && sX < pool.x1 && sZ > pool.z0 && sZ < pool.z1) {
                shadeWater(sX, sZ, tW2 * lh2, tW2, tW2 + S.water.depth * invNegDy2, dx2, dz2, lh2, dy2);
                rowWet = true;
                putPixel();
                continue;
              }
              hitWall = true;
            }
            if (hitWall) {
              /* 水面（或池底）之前先出了池子 → 撞的是池内壁 */
              var uOut = colEXA[x3] === 0 ? (camZ + tOut * dz2) : (camX + tOut * dx2);
              /* y 必须是真实高度（池内壁在水位线以下是负的）。以前这里把它
                 夹成 0.02，于是整面池内壁的砖行坐标恒定 —— 只有横向变化，
                 画出来是一道道竖条纹，而且水位线那圈印子也一起没了 */
              var yOut = camY + tOut * dy2;
              wallU = colEXA[x3] === 0 ? absRz : absRx;
              shadeWall(uOut, yOut, tOut * lh2, 0, 1,
                camX + tOut * dx2, camZ + tOut * dz2);
            } else {
              shadePoolBottom(bX, bZ, tBot * lh2, 0);
            }
            putPixel();
            continue;
          }

          if (asc) {
            if (underwater) {
              /* 抬头：头顶是水面（而不是天花板），先从池壁里出去就是池壁 */
              var tS = (waterY - camY) / dy2;
              var tExitA = colOUT[x3];
              if (tExitA < tS) {
                var wxA = camX + tExitA * dx2, wzA = camZ + tExitA * dz2;
                uwFlow(wxA, wzA);
                wallSoft = uwW < 0 ? -uwW * 1.1 : uwW * 1.1;
                if (wallSoft > 0.85) wallSoft = 0.85;
                shadeWall((colEXA[x3] === 0 ? wzA : wxA) + uwW * 0.12,
                  camY + tExitA * dy2, tExitA * lh2, 0, 1, wxA, wzA);
                wallSoft = 0;
              } else {
                /* dy2 是未归一化的方向分量（量级几百），这里要的是「抬头多少」
                   —— 用竖直分量占整条射线的比例，才是 0~1 的入射角余弦 */
                shadeWaterUnder(camX + tS * dx2, camZ + tS * dz2, tS * lh2,
                  dy2 / Math.sqrt(dy2 * dy2 + lh2 * lh2));
                rowWet = true;
              }
              putPixel();
              continue;
            }
            if (underDeck) {
              /* 干池里抬头：池口是开的，能直接看到大厅天花板。
                 但射线要是先从池壁穿出去（出池点还在池沿以下），那就是撞壁 */
              var tExitK = colOUT[x3];
              var yExitK = camY + tExitK * dy2;
              if (yExitK < -0.005 && tExitK < tC2) {
                shadeWall(colEXA[x3] === 0 ? (camZ + tExitK * dz2) : (camX + tExitK * dx2),
                  yExitK, tExitK * lh2, 0, 1,
                  camX + tExitK * dx2, camZ + tExitK * dz2);
              } else {
                shadeCeiling(camX + tC2 * dx2, camZ + tC2 * dz2, tC2 * lh2);
              }
              putPixel();
              continue;
            }
            if (wallOK && tWall < tC2) {
              wallU = colWID[x3] < 2 ? absRz : absRx;
              shadeWall(colWU[x3], yWall, tWall * lh2, colWID[x3], 0, colWX[x3], colWZ[x3]);
            } else {
              shadeCeiling(camX + tC2 * dx2, camZ + tC2 * dz2, tC2 * lh2);
            }
            putPixel();
            continue;
          }

          /* 正好水平：只可能是墙 */
          if (underwater || underDeck) {
            var tExitH = colOUT[x3];
            var wxH = camX + tExitH * dx2, wzH = camZ + tExitH * dz2;
            if (underwater) {
              uwFlow(wxH, wzH);
              wallSoft = uwW < 0 ? -uwW * 1.1 : uwW * 1.1;
              if (wallSoft > 0.85) wallSoft = 0.85;
            }
            shadeWall((colEXA[x3] === 0 ? wzH : wxH) + (underwater ? uwW * 0.12 : 0),
              camY + tExitH * dy2, tExitH * lh2, 0, 1, wxH, wzH);
            wallSoft = 0;
            putPixel();
            continue;
          }
          wallU = colWID[x3] < 2 ? absRz : absRx;
          shadeWall(colWU[x3], camY, tWall * lh2, colWID[x3], 0, colWX[x3], colWZ[x3]);
          putPixel();
        }
        if (rowWet) { if (wTop < 0) wTop = y3; wBot = y3; }
      }

      stats.wy0 = wTop;
      stats.wy1 = wBot;
      if (y0 === 0 && y1 === H) ctx.putImageData(imgData, 0, 0);
      else if (dirtyOK) {
        try { ctx.putImageData(imgData, 0, 0, 0, y0, W, y1 - y0); }
        catch (e) { dirtyOK = false; ctx.putImageData(imgData, 0, 0); }
      } else {
        ctx.putImageData(imgData, 0, 0);              // 脏矩形不可用：整幅写入，别让画面停住
      }
      var t1 = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
      stats.ms = t1 - t0;
      stats.px = W * (y1 - y0);
      stats.frames++;
      return stats;
    }

    return {
      render: render,
      resize: resize,
      setQuality: setQuality,
      setScene: setScene,
      destroy: destroy,
      stats: stats,
      scene: function () { return S; },
      size: function () { return { w: W, h: H }; }
    };
  };

  /* 投稿预览这类静态场景的确定性时间：同一 seed 永远是同一帧水纹 */
  POOLCORE.frameTime = function (seed) { return 6 + (Math.abs(seed | 0) % 37) * 0.31; };

  /* 给界面层用的一点点色彩工具（投稿页按色相推水色） */
  POOLCORE.util = {
    clamp: clamp,
    hexRGB: hexRGB,
    hsl2rgb: hsl2rgb,
    rgb2hex: function (rgb) {
      function h(v) {
        var s = Math.round(clamp(v, 0, 1) * 255).toString(16);
        return s.length < 2 ? '0' + s : s;
      }
      return '#' + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
    }
  };

})(window);
