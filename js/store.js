/* ==========================================================================
   池核 · POOLCORE — 本地存储
   --------------------------------------------------------------------------
   收藏、投稿、设置都只写进浏览器本地（键前缀 poolcore:）。
   部分浏览器在 file:// 下会禁用 localStorage，所以这里 try/catch 降级到内存，
   并对外暴露 available，让界面能如实告诉用户「这次的收藏不会留到下次」。
   ========================================================================== */

(function (root) {
  'use strict';

  var POOLCORE = root.POOLCORE = root.POOLCORE || {};
  var PREFIX = 'poolcore:';
  var mem = {};

  var available = (function () {
    try {
      var k = PREFIX + '__probe';
      root.localStorage.setItem(k, '1');
      root.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function rawGet(key) {
    if (available) {
      try { return root.localStorage.getItem(PREFIX + key); } catch (e) { /* 落到内存 */ }
    }
    return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
  }

  function rawSet(key, val) {
    if (available) {
      try { root.localStorage.setItem(PREFIX + key, val); return true; } catch (e) { /* 落到内存 */ }
    }
    mem[key] = val;
    return false;
  }

  function rawDel(key) {
    if (available) { try { root.localStorage.removeItem(PREFIX + key); } catch (e) {} }
    delete mem[key];
  }

  function getJSON(key, def) {
    var s = rawGet(key);
    if (s == null) return def;
    try {
      var v = JSON.parse(s);
      return v == null ? def : v;
    } catch (e) {
      return def;
    }
  }

  function setJSON(key, val) {
    return rawSet(key, JSON.stringify(val));
  }

  /* ---------------- 收藏 ---------------- */

  function favoriteIds() {
    var a = getJSON('favorites', []);
    return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
  }

  function isFav(id) { return favoriteIds().indexOf(id) >= 0; }

  function setFav(id, on) {
    var list = favoriteIds().filter(function (x) { return x !== id; });
    if (on) list.unshift(id);
    setJSON('favorites', list);
    return list;
  }

  function toggleFav(id) { return setFav(id, !isFav(id)); }

  function favScenes() {
    var ids = favoriteIds();
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var s = POOLCORE.sceneById(ids[i]) || findSubmission(ids[i]);
      if (s) out.push(s);
    }
    return out;
  }

  /* ---------------- 投稿 ---------------- */

  function submissions() {
    var a = getJSON('submissions', []);
    return Object.prototype.toString.call(a) === '[object Array]' ? a : [];
  }

  function findSubmission(id) {
    var a = submissions();
    for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
    return null;
  }

  function addSubmission(scene) {
    var a = submissions().filter(function (s) { return s.id !== scene.id; });
    a.unshift(scene);
    if (a.length > 30) a = a.slice(0, 30);      // 本地存储有限，留最近 30 个
    setJSON('submissions', a);
    return a;
  }

  function removeSubmission(id) {
    var a = submissions().filter(function (s) { return s.id !== id; });
    setJSON('submissions', a);
    setFav(id, false);
    return a;
  }

  /* ---------------- 设置 ---------------- */

  var DEFAULT_SETTINGS = { volume: 0.8, quality: 540, muted: false, animate: true, light: 1 };

  function settings() {
    var s = getJSON('settings', {});
    var out = {};
    for (var k in DEFAULT_SETTINGS) {
      out[k] = (s && s[k] != null) ? s[k] : DEFAULT_SETTINGS[k];
    }
    return out;
  }

  /* 当前光照强度（0.3~1.5，没存过就是 1）。
     查看器里拉的滑条存的就是它，画廊缩略图与首页主视觉也照这个来，
     免得「查看器里压暗了、缩略图还是亮的」 */
  function lightLevel() {
    var v = settings().light;
    if (v == null) return 1;
    return v < 0.3 ? 0.3 : (v > 1.5 ? 1.5 : v);
  }

  function saveSettings(patch) {
    var s = settings();
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    setJSON('settings', s);
    return s;
  }

  /* ---------------- 导出 ---------------- */

  function favoritesText() {
    var list = favScenes();
    var lines = [];
    lines.push('池核 · POOLCORE 收藏清单');
    lines.push('共 ' + list.length + ' 个场景');
    lines.push('');
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      lines.push((i + 1) + '. ' + s.name + '  [' + POOLCORE.categoryLabel(s.category) + ']');
      if (s.tags && s.tags.length) lines.push('   标签：' + s.tags.join(' / '));
      if (s.desc) lines.push('   ' + s.desc);
    }
    lines.push('');
    lines.push('--- 原始数据 ---');
    lines.push(JSON.stringify(list.map(function (s) { return s.id; }), null, 2));
    return lines.join('\n');
  }

  function download(filename, text, mime) {
    try {
      var blob = new root.Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var url = root.URL.createObjectURL(blob);
      var a = root.document.createElement('a');
      a.href = url;
      a.download = filename;
      root.document.body.appendChild(a);
      a.click();
      root.document.body.removeChild(a);
      root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 4000);
      return true;
    } catch (e) {
      return false;
    }
  }

  POOLCORE.store = {
    available: available,
    get: rawGet,
    set: rawSet,
    remove: rawDel,
    getJSON: getJSON,
    setJSON: setJSON,
    favoriteIds: favoriteIds,
    isFav: isFav,
    setFav: setFav,
    toggleFav: toggleFav,
    favScenes: favScenes,
    submissions: submissions,
    findSubmission: findSubmission,
    addSubmission: addSubmission,
    removeSubmission: removeSubmission,
    settings: settings,
    saveSettings: saveSettings,
    lightLevel: lightLevel,
    favoritesText: favoritesText,
    download: download
  };

})(window);
