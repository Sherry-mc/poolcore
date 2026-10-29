/* ==========================================================================
   池核 · POOLCORE — 场景数据
   这里只有数据：渲染器与音景引擎都以一份场景为唯一输入。
   新增一个场景 = 追加一条数据，不需要动渲染代码。
   ========================================================================== */

(function (root) {
  'use strict';

  var POOLCORE = root.POOLCORE = root.POOLCORE || {};

  /* 分类：画廊筛选的唯一定义处 */
  POOLCORE.categories = [
    { id: 'all', label: '全部' },
    { id: 'indoor', label: '室内池' },
    { id: 'outdoor', label: '户外池' },
    { id: 'night', label: '夜池' },
    { id: 'abandoned', label: '废弃池' }
  ];

  POOLCORE.categoryLabel = function (id) {
    for (var i = 0; i < POOLCORE.categories.length; i++) {
      if (POOLCORE.categories[i].id === id) return POOLCORE.categories[i].label;
    }
    return id;
  };

  /* ------------------------------------------------------------------------
     字段说明（缺字段会被渲染器按默认值补齐）
       room   { w, d, h }            大厅尺寸（米）
       pool   { insetX, insetZ, depth }  池子从四边内缩多少、多深
       water  { level, color, clarity, ripple }
              level  水面相对池沿的高度：负=正常水面；>=0=大厅进水
              clarity 0 浊 → 1 清（能看到池底多少）
              ripple 波纹幅度
       tile   { size, hue, sat, light, grout }  瓷砖尺寸 / 色相 / 饱和 / 明度 / 勾缝
       light  { intensity, hue, skylight, fixtures }  灯管强度 / 暖度 / 天窗亮度 / 灯具数量
       fog    { color, near, far, density }
       dirt   0 干净 → 1 脏旧（水渍、缺砖）
       calm   1 热闹 → 5 极静（画廊排序用的“安静程度”）
       camera { height, x, yaw, pitch }   默认站位在池沿，自动朝向池心
       audio  音景预设名
     ------------------------------------------------------------------------ */

  /* 瓷砖默认是「干净到失真」的白：逐砖明暗差 0、不成片水渍。
     想要旧砖感就在某个场景里写 dirt: 0.4 / tile: { vary: 0.14 }。
     池子几何：所有池子共用同一个标准盆底（渲染器里的 POOL_BOTTOM = 2.2m），
     场景只写水位 water.level —— 于是「同一个池子、不同的水量」，
     池底在哪个高度上不随场景变。只有儿童池 / 戏水池是另一个池子，
     用 pool.bottom 把盆底抬高一点，那里才是真的浅。
     注意：写 pool.depth 不再有任何作用（会被忽略）。 */

  POOLCORE.scenes = [

    /* ---------------- 室内 ---------------- */
    {
      id: 'indoor-morning',
      name: '标准池 · 上午',
      category: 'indoor',
      tags: ['瓷砖', '泳道线', '天窗', '回声'],
      desc: '上午十点，天窗把光斜切进水里，池边只有水波拍瓷砖的声音。刚换过水的那种干净。',
      seed: 20261,
      room: { w: 25, d: 14, h: 4.8 },
      pool: { insetX: 3.2, insetZ: 4.0 },
      water: { level: -0.18, color: '#2FA3C7', clarity: 0.72, ripple: 0.42 },
      tile: { size: 0.25, hue: 196, sat: 0.34, light: 0.8, grout: 0.079 },
      light: { intensity: 1.0, hue: 38, skylight: 0.9, fixtures: 5 },
      fog: { color: '#0E3A46', near: 5, far: 30, density: 0.85 },
      calm: 4,
      camera: { height: 1.66, pitch: -7 },
      audio: 'indoor-hall'
    },
    {
      id: 'indoor-lanes',
      name: '泳道训练馆',
      category: 'indoor',
      tags: ['泳道线', '标记', '瓷砖', '空旷'],
      desc: '八条泳道，水面上浮着分道线，尽头墙上写着道次。没有人来游。',
      seed: 1174,
      room: { w: 34, d: 16, h: 4.4 },
      pool: { insetX: 2.6, insetZ: 4.6 },
      water: { level: -0.14, color: '#2C9EC2', clarity: 0.62, ripple: 0.34 },
      tile: { size: 0.2, hue: 202, sat: 0.3, light: 0.84, grout: 0.073 },
      light: { intensity: 1.05, hue: 40, skylight: 0.6, fixtures: 7 },
      fog: { color: '#0D3543', near: 6, far: 36, density: 0.8 },
      calm: 4,
      camera: { height: 1.7, pitch: -5 },
      audio: 'indoor-hall'
    },
    {
      id: 'indoor-deep',
      name: '深水区 · 五米',
      category: 'indoor',
      tags: ['深水', '幽暗', '瓷砖', '嗡鸣'],
      desc: '五米深的池底几乎看不见，只剩一块更深的青。站在边上看下去，水会把人往下压。',
      seed: 9007,
      room: { w: 20, d: 16, h: 6.4 },
      pool: { insetX: 2.6, insetZ: 3.0, bottom: 4.8 },   // 跳水池是另一个池子
      water: { level: -0.2, color: '#17607A', clarity: 0.4, ripple: 0.28 },
      tile: { size: 0.24, hue: 194, sat: 0.42, light: 0.68, grout: 0.092 },
      light: { intensity: 0.82, hue: 34, skylight: 0.35, fixtures: 4 },
      fog: { color: '#08222C', near: 4, far: 24, density: 1.0 },
      calm: 5,
      camera: { height: 1.68, pitch: -12 },
      audio: 'indoor-deep'
    },
    {
      /* 按通道吸水做的「无底池」：红光在水里最先没，蓝绿再穿几米也所剩无几，
         池底哪怕照不到光也没关系 —— 光本来就走不到 9.6m 下面 */
      id: 'indoor-abyss',
      name: '深水池 · 不见底',
      category: 'indoor',
      tags: ['深水', '不见底', '墨绿', '回声'],
      desc: '盆底在九米六下面。光到不了那儿 —— 池底整个黑掉，只剩水面还认得出是水。',
      seed: 41023,
      room: { w: 26, d: 17, h: 7.6 },
      pool: { insetX: 3.4, insetZ: 3.8, bottom: 9.6 },
      water: { level: -0.2, color: '#04141C', clarity: 0.8, ripple: 0.3, absorb: 1.6, sheen: 0.3 },
      tile: { size: 0.25, hue: 192, sat: 0.3, light: 0.46, grout: 0.106 },
      light: { intensity: 0.78, hue: 34, skylight: 0.16, fixtures: 2 },
      fog: { color: '#04121A', near: 5, far: 30, density: 1.1 },
      calm: 6,
      camera: { height: 1.72, pitch: -13 },
      audio: 'indoor-deep'
    },
    {
      id: 'indoor-toddler',
      name: '儿童池 · 浅水',
      category: 'indoor',
      tags: ['浅水', '暖灯', '小瓷砖', '午后'],
      desc: '脚踝深的水，池底铺着小块马赛克。暖色的灯，像是给谁留着的。',
      seed: 3312,
      room: { w: 15, d: 11, h: 3.4 },
      pool: { insetX: 2.4, insetZ: 2.4, bottom: 0.62 },
      water: { level: -0.1, color: '#5BC8C4', clarity: 0.86, ripple: 0.5 },
      tile: { size: 0.14, hue: 186, sat: 0.32, light: 0.86, grout: 0.066 },
      light: { intensity: 1.0, hue: 30, skylight: 0.5, fixtures: 3 },
      fog: { color: '#123B41', near: 4, far: 20, density: 0.7 },
      calm: 3,
      camera: { height: 1.6, pitch: -9 },
      /* 池里那把蘑菇伞（伞底落着最大的一块影），池边一架小滑梯 */
      props: [
        { type: 'mushroom', x: -1.7, z: -0.4, capR: 1.15, capY: 2.02, color: '#D9574E' },
        { type: 'slide', x: 6.0, z: 1.5, rot: -90, h: 1.3, len: 2.4, color: '#E8B23A' }
      ],
      audio: 'indoor-small'
    },
    {
      id: 'indoor-flood',
      name: '半淹的大厅',
      category: 'indoor',
      tags: ['进水', '倒影', '灯管', '超现实'],
      desc: '池子满了以后没人关阀门。水漫过池沿，整间大厅成了一面很浅的镜子。',
      seed: 5150,
      room: { w: 22, d: 15, h: 5.0 },
      pool: { insetX: 3.0, insetZ: 3.4 },
      water: { level: 0.24, color: '#2E9BB8', clarity: 0.66, ripple: 0.3 },
      tile: { size: 0.22, hue: 192, sat: 0.36, light: 0.76, grout: 0.079 },
      light: { intensity: 0.9, hue: 36, skylight: 0.7, fixtures: 5 },
      fog: { color: '#0A2833', near: 5, far: 28, density: 0.95 },
      calm: 5,
      camera: { height: 1.7, pitch: -8 },
      audio: 'flooded'
    },

    /* ---------------- 户外 ---------------- */
    {
      id: 'outdoor-lap',
      name: '户外长池 · 正午',
      category: 'outdoor',
      tags: ['长池', '强光', '晒白', '无风'],
      desc: '五十米长池，中午的水面亮得发白。没人，池边躺椅是空的。',
      seed: 7702,
      room: { w: 46, d: 18, h: 3.6 },
      pool: { insetX: 3.0, insetZ: 4.4 },
      water: { level: -0.2, color: '#3FC6CE', clarity: 0.78, ripple: 0.55 },
      tile: { size: 0.24, hue: 198, sat: 0.3, light: 0.9, grout: 0.073 },
      light: { intensity: 1.25, hue: 48, skylight: 1.5, fixtures: 0 },
      sky: {
        top: '#2F74C0', horizon: '#D6ECF7', cloud: '#F4F8FB', cloudLit: '#FFFFFF',
        sun: '#FFFBE8', az: 28, el: 64, bright: 1.2, cover: 0.52, sunPow: 1.7
      },
      fog: { color: '#1A5563', near: 8, far: 52, density: 0.55 },
      calm: 3,
      camera: { height: 1.68, pitch: -6 },
      audio: 'outdoor-open'
    },
    {
      id: 'outdoor-dusk',
      name: '户外池 · 黄昏',
      category: 'outdoor',
      tags: ['黄昏', '暖光', '水面', '无风'],
      desc: '太阳还压在围栏上，把整个大厅烤成一片暖橘。水面上那条亮痕就是它 —— 再等一会儿，池子就该变成深蓝色了。',
      seed: 4419,
      room: { w: 26, d: 17, h: 3.2 },
      pool: { insetX: 3.0, insetZ: 4.0 },
      /* 水色与光网色都跟着这场落日走：水体是暖琥珀，透进来的光是金色 ——
         冷薄荷青配暖瓷砖会很别扭 */
      water: { level: -0.18, color: '#8A5A22', clarity: 0.58, ripple: 0.36, caustic: '#FFD9A0' },
      tile: { size: 0.25, hue: 34, sat: 0.4, light: 0.64, grout: 0.079 },
      light: { intensity: 0.95, hue: 26, skylight: 1.05, fixtures: 2 },
      /* 天空是现算的：梯度 + 云带 + 太阳盘 + 光晕，配色照黄昏照片来。
         az 是从 -Z 起、朝 +X 转的角度，el 是仰角 —— 太阳必须抬得够高，
         才能从屋顶那个洞里露出来 */
      sky: {
        top: '#7E3A24', horizon: '#FFD98A', cloud: '#6B2A12', cloudLit: '#FFE6B4',
        sun: '#FFF3D2', az: -16, el: 24, bright: 0.98, cover: 0.5, sunPow: 1.0
      },
      fog: { color: '#4A2C22', near: 6, far: 34, density: 0.8 },
      calm: 4,
      camera: { height: 1.66, pitch: -7 },
      audio: 'outdoor-open'
    },
    {
      id: 'outdoor-kiddie',
      name: '戏水池 · 蘑菇伞',
      category: 'outdoor',
      tags: ['浅水', '小池', '正午', '鲜艳'],
      desc: '蘑菇伞底下的那一小块水，脚背深，晒了一上午是温的。',
      seed: 6620,
      room: { w: 16, d: 13, h: 3.0 },
      pool: { insetX: 2.6, insetZ: 2.6, bottom: 0.66 },
      water: { level: -0.1, color: '#63CFC0', clarity: 0.84, ripple: 0.6 },
      tile: { size: 0.16, hue: 178, sat: 0.34, light: 0.88, grout: 0.066 },
      light: { intensity: 1.2, hue: 46, skylight: 1.2, fixtures: 0 },
      fog: { color: '#1E5A5E', near: 5, far: 22, density: 0.5 },
      calm: 3,
      camera: { height: 1.55, pitch: -10 },
      /* 这座戏水池的名字就是它：伞沿一圈水帘垂下来，池边一架滑梯 */
      props: [
        { type: 'mushroom', x: 0.8, z: -0.3, capR: 1.35, capY: 2.05, color: '#E2574C', curtain: true, streams: 7 },
        { type: 'slide', x: -6.0, z: 1.8, rot: 90, h: 1.4, len: 2.6, color: '#F0B53A' }
      ],
      audio: 'indoor-small'
    },

    /* ---------------- 夜池 ---------------- */
    {
      id: 'night-half',
      name: '夜场 · 半池灯',
      category: 'night',
      tags: ['夜里', '灯管', '反光', '嗡鸣'],
      desc: '闭馆后只留了一半的灯。水面黑得发亮，灯管在水里排成另一排。',
      seed: 2318,
      room: { w: 25, d: 14, h: 4.8 },
      pool: { insetX: 3.2, insetZ: 4.0 },
      water: { level: -0.18, color: '#1C7893', clarity: 0.5, ripple: 0.3 },
      tile: { size: 0.25, hue: 194, sat: 0.36, light: 0.62, grout: 0.086 },
      light: { intensity: 0.62, hue: 190, skylight: 0.1, fixtures: 3 },
      /* 夜空：天窗开完就是这一块，别让它亮过屋里的灯 */
      sky: {
        top: '#070C16', horizon: '#141E2B', cloud: '#0C131D', cloudLit: '#2C3A4C',
        sun: '#9FB2C6', az: 0, el: 62, bright: 0.3, cover: 0.55, sunPow: 0.45, sunI: 0
      },
      fog: { color: '#05161E', near: 3, far: 22, density: 1.15 },
      calm: 5,
      camera: { height: 1.66, pitch: -6 },
      audio: 'night-hum'
    },
    {
      id: 'night-open',
      name: '夜里的户外池',
      category: 'night',
      tags: ['夜里', '户外', '少量灯', '安静'],
      desc: '池底灯还亮着，水面是唯一的亮处。远一点的围栏已经完全黑了。',
      seed: 8801,
      room: { w: 27, d: 19, h: 3.2 },
      pool: { insetX: 3.2, insetZ: 4.4 },
      water: { level: -0.18, color: '#1A6E8C', clarity: 0.48, ripple: 0.36 },
      tile: { size: 0.25, hue: 196, sat: 0.32, light: 0.6, grout: 0.079 },
      light: { intensity: 0.5, hue: 186, skylight: 0.28, fixtures: 2 },
      sky: {
        top: '#070C16', horizon: '#16202C', cloud: '#0D141E', cloudLit: '#2E3C4E',
        sun: '#A2B4C8', az: 20, el: 58, bright: 0.34, cover: 0.55, sunPow: 0.45, sunI: 0
      },
      fog: { color: '#04131A', near: 4, far: 26, density: 1.1 },
      calm: 5,
      camera: { height: 1.66, pitch: -6 },
      audio: 'night-hum'
    },

    /* ---------------- 废弃池 ---------------- */
    {
      id: 'abandoned-dry',
      name: '废弃池 · 已排干',
      category: 'abandoned',
      tags: ['抽干', '水渍', '缺砖', '灰尘'],
      desc: '水早排干了，池底只剩一圈深色的水位线和几块翘起来的瓷砖。',
      seed: 1009,
      room: { w: 24, d: 15, h: 4.6 },
      pool: { insetX: 3.0, insetZ: 3.6 },
      water: { level: -2.6, stain: -0.42, color: '#4A6A66', clarity: 0.5, ripple: 0.1 },
      tile: { size: 0.24, hue: 150, sat: 0.18, light: 0.62, grout: 0.119 },
      light: { intensity: 0.74, hue: 44, skylight: 0.5, fixtures: 2 },
      fog: { color: '#33352A', near: 5, far: 28, density: 0.85 },
      calm: 5,
      camera: { height: 1.66, pitch: -14 },
      audio: 'abandoned-drip'
    },
    {
      id: 'abandoned-stain',
      name: '废弃池 · 水位线以下',
      category: 'abandoned',
      tags: ['半干', '水渍', '旧灯', '潮气'],
      desc: '水退到一半就不动了。水位线以上是白的，以下是另一种颜色。',
      seed: 3377,
      room: { w: 22, d: 14, h: 4.4 },
      pool: { insetX: 2.8, insetZ: 3.4 },
      water: { level: -0.95, stain: -0.3, color: '#3E6E6A', clarity: 0.34, ripple: 0.14 },
      tile: { size: 0.26, hue: 158, sat: 0.2, light: 0.66, grout: 0.112 },
      light: { intensity: 0.76, hue: 40, skylight: 0.34, fixtures: 3 },
      fog: { color: '#2C332A', near: 5, far: 26, density: 0.9 },
      calm: 5,
      camera: { height: 1.66, pitch: -12 },
      audio: 'abandoned-drip'
    }
  ];

  /* ---------------- 查询 ---------------- */

  var byId = {};
  for (var i = 0; i < POOLCORE.scenes.length; i++) {
    byId[POOLCORE.scenes[i].id] = POOLCORE.scenes[i];
  }

  POOLCORE.sceneById = function (id) { return byId[id] || null; };

  POOLCORE.allTags = function () {
    var seen = {}, out = [];
    for (var i = 0; i < POOLCORE.scenes.length; i++) {
      var t = POOLCORE.scenes[i].tags || [];
      for (var k = 0; k < t.length; k++) {
        if (!seen[t[k]]) { seen[t[k]] = 1; out.push(t[k]); }
      }
    }
    return out;
  };

  /* 画廊排序用：默认顺序保持数据里的编排 */
  POOLCORE.sortScenes = function (list, mode) {
    var copy = list.slice();
    if (mode === 'name') {
      copy.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    } else if (mode === 'calm') {
      copy.sort(function (a, b) { return (b.calm || 3) - (a.calm || 3); });
    }
    return copy;
  };

})(window);
