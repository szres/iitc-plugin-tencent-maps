// ==UserScript==
// @id             iitc-plugin-tencent-maps-vectormap@tabris@szres
// @name           IITC plugin: Tencent Maps vector renderer (腾讯矢量底图·实验)
// @category       Map Tiles
// @version        0.2.0.20261103
// @namespace      tabris@szres
// @author         tabris@szres
// @description    Experimental: draws Tencent's JSON vector tiles on canvas so labels stay crisp at any size. 实验性：直接渲染腾讯矢量瓦片，字号可任意放大且始终清晰。
// @match          https://intel.ingress.com/*
// @match          https://intel-x.ingress.com/*
// @match          https://www.ingress.com/intel*
// @grant          none
// @license        MIT
// @homepageURL    https://github.com/szres/iitc-plugin-tencent-maps
// @supportURL     https://github.com/szres/iitc-plugin-tencent-maps/issues
// @downloadURL    https://raw.githubusercontent.com/szres/iitc-plugin-tencent-maps/feat/vectormap/iitc-plugin-tencent-maps-vectormap.user.js
// @updateURL      https://raw.githubusercontent.com/szres/iitc-plugin-tencent-maps/feat/vectormap/iitc-plugin-tencent-maps-vectormap.user.js
// ==/UserScript==

/* global L, map -- eslint */

// 实验分支：不走栅格瓦片，而是拉腾讯的 JSON 矢量瓦片自己画。
//
// 接口（2026-11 实测）：
//   https://rt{s}.map.gtimg.com/vector?z={z}&x={x}&y={y}&styleid=0&version={ver}
//   - TMS 纵坐标（y = 2^z - y_slippy - 1），与栅格瓦片一致
//   - 返回 JSON：{"ret":0,"features":[[layerId,[x0,y0,dx1,dy1,...],"文字"]]}
//   - 坐标是 0..256 的瓦片内坐标（允许负值和 >256，表示被裁切的几何）
//   - 几何是增量编码：首点绝对坐标，其后每两个数是相对上一点的 dx/dy
//   - 响应头 access-control-allow-origin: * ，页面内可直接 XHR
//   - 层级 z6~z18 有数据
//
// 图层 id 是通过「已知坐标点做点在多边形内判定 + 逐图层渲染肉眼比对」反推的，
// 不是官方文档。已验证的：
//   196618            面状水域（太湖 / 昆明湖 / 西湖 均命中）
//   196614            绿地、公园（奥森 / 朝阳公园 命中）
//   196774 / 196775   线状水系（河道）
//   196610 / 196612   大范围底图面
//   196622 及其它     底层地块
//   131xxx            道路（id 跟缩放级别绑定，所以按几何长度自动分级，不写死）
//   655xx / 666xx     POI 注记
//   65944 / 65945     地铁线路标注（只有文字，如"6号线"）
//   262xxx            路牌（G1 / S50）
//
// 已知限制：
//   - 地铁只有标注文字，线路几何不在这个接口里，所以只能画线号标签，画不出线路走向
//   - 建筑轮廓没有独立图层，统一按地块处理

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  plugin_info.buildName = 'local';
  plugin_info.dateTimeVersion = '2026-11-03-000000';
  plugin_info.pluginId = 'tencent-maps-vectormap';

  window.plugin.tencentVectorMap = function () {};
  var self = window.plugin.tencentVectorMap;

  self.TILE_VERSION = 2232;
  self.TILE_HOST = 'rt';        // rt0..rt3
  self.STYLE_ID = 0;
  self.NATIVE_MIN = 6;
  self.NATIVE_MAX = 18;

  // —— 性能相关 ——
  self.PIXEL_RATIO_MAX = 2;     // 每张瓦片一个 canvas，2 已足够清晰
  self.CACHE_LIMIT = 240;       // 要素缓存条数上限
  self.UPDATE_WHEN_IDLE = true; // 拖动/缩放动画期间不取数不绘制

  // —— 主题 ——
  // 两套配色，注册成两个图层。dark 同时喂给 IITC 的暗色主题自动切换（isDark）。
  self.THEMES = {
    light: {
      background: '#f6f4f0',
      land: '#f0ece5',
      block: '#e6e2db',
      green: '#cfe4c2',
      water: '#a9d0ee',
      waterLine: '#9cc8e8',
      roadTiers: [
        { width: 5.5, color: '#f6d69a' },
        { width: 3.2, color: '#fbe6bd' },
        { width: 1.3, color: '#ffffff' },
      ],
      label: {
        size: 12,
        color: '#3a3a3a',
        halo: '#ffffff',
        haloWidth: 3,
        font: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif',
        padding: 3,          // 注记之间额外留白
      },
      shield: { size: 10, bg: '#2b7a3d', color: '#ffffff' },
      subway: { size: 10, bg: '#0f7b6c', color: '#ffffff' },
    },
    dark: {
      background: '#191d22',
      land: '#212730',
      block: '#282f38',
      green: '#1e3327',
      water: '#12314a',
      waterLine: '#16405e',
      roadTiers: [
        { width: 5.5, color: '#4c5f74' },
        { width: 3.2, color: '#3c4a59' },
        { width: 1.3, color: '#2f3742' },
      ],
      label: {
        size: 12,
        color: '#ccd6e0',
        halo: '#0e1116',
        haloWidth: 3,
        font: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif',
        padding: 3,
      },
      shield: { size: 10, bg: '#2f6b46', color: '#e8f0e8' },
      subway: { size: 10, bg: '#1a6e60', color: '#d8f0ea' },
    },
  };

  self.setup = function () {
    try {
      function requestUrl(z, x, ySlippy, sub) {
        var yTms = (1 << z) - 1 - ySlippy;
        return 'https://' + self.TILE_HOST + sub + '.map.gtimg.com/vector'
          + '?z=' + z + '&x=' + x + '&y=' + yTms
          + '&styleid=' + self.STYLE_ID + '&version=' + self.TILE_VERSION;
      }

      function decodeFeatures(json) {
        var out = [];
        var list = (json && json.features) || [];
        for (var i = 0; i < list.length; i++) {
          var f = list[i];
          if (!f || !f[1] || f[1].length < 2) continue;
          var raw = f[1];
          var pts = [[raw[0], raw[1]]];
          var x = raw[0];
          var y = raw[1];
          for (var k = 2; k + 1 < raw.length; k += 2) {
            x += raw[k];
            y += raw[k + 1];
            pts.push([x, y]);
          }
          out.push({ layer: f[0], pts: pts, text: typeof f[2] === 'string' ? f[2] : null });
        }
        return out;
      }

      function isRoad(id) { return id >= 131000 && id < 132000; }
      function isArea(id) { return id >= 196000 && id < 197000; }
      function isShield(id) { return id >= 262000 && id < 263000; }
      function isSubwayLabel(id) { return id === 65944 || id === 65945; }
      function isSubwayText(t) { return /号线|地铁|轻轨/.test(t); }

      // 面要素按已验证的图层 id 分类
      function areaKind(id) {
        if (id === 196618) return 'water';
        if (id === 196614) return 'green';
        if (id === 196774 || id === 196775) return 'waterLine';
        if (id === 196610 || id === 196612) return 'land';
        return 'block';
      }

      // 道路分级：按同类要素的平均线段长度，长的 = 主干。
      // 腾讯的 layerId 跟缩放级别绑定（z6 主力 131084，z12 是 131103，z16 又变 131094），
      // 写死 id 只在单一层级有效；按数量排也不行（某些层级主网络本身就最密集）。
      function roadTiers(feats) {
        var stat = {};
        for (var i = 0; i < feats.length; i++) {
          var f = feats[i];
          if (!isRoad(f.layer) || f.pts.length < 2) continue;
          var s = stat[f.layer] || (stat[f.layer] = { n: 0, len: 0 });
          s.n++;
          for (var p = 1; p < f.pts.length; p++) {
            var dx = f.pts[p][0] - f.pts[p - 1][0];
            var dy = f.pts[p][1] - f.pts[p - 1][1];
            s.len += Math.sqrt(dx * dx + dy * dy);
          }
        }
        var ids = Object.keys(stat).map(Number).sort(function (a, b) {
          return stat[b].len / stat[b].n - stat[a].len / stat[a].n;
        });
        var tiers = {};
        for (var k = 0; k < ids.length; k++) tiers[ids[k]] = k === 0 ? 0 : k === 1 ? 1 : 2;
        return tiers;
      }

      function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

      // —— 绘制一张瓦片 ——
      function drawTile(ctx, size, feats, z, dpr, T) {
        var k = size / 256;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = T.background;
        ctx.fillRect(0, 0, size, size);

        // 一次性分桶，后面不再反复全量扫描
        var tiers = roadTiers(feats);
        var roadByTier = [[], [], []];
        var land = [], block = [], green = [], water = [], waterLine = [];
        var labels = [], shields = [];

        for (var i = 0; i < feats.length; i++) {
          var f = feats[i];
          if (isRoad(f.layer)) {
            var t = tiers[f.layer];
            if (t !== undefined && f.pts.length >= 2) roadByTier[t].push(f);
            continue;
          }
          if (isArea(f.layer)) {
            var kind = areaKind(f.layer);
            if (kind === 'waterLine') {
              if (f.pts.length >= 2) waterLine.push(f);
            } else if (f.pts.length >= 3) {
              if (kind === 'water') water.push(f);
              else if (kind === 'green') green.push(f);
              else if (kind === 'land') land.push(f);
              else block.push(f);
            }
            continue;
          }
          if (f.text) {
            if (isShield(f.layer)) shields.push(f);
            else labels.push(f);
          }
        }

        // 批量填充：同色多边形合成一条路径，一次 fill，比逐个 fill 快很多
        function fillPolys(list, color) {
          if (!list.length) return;
          ctx.beginPath();
          for (var a = 0; a < list.length; a++) {
            var P = list[a].pts;
            ctx.moveTo(P[0][0] * k, P[0][1] * k);
            for (var b = 1; b < P.length; b++) ctx.lineTo(P[b][0] * k, P[b][1] * k);
            ctx.closePath();
          }
          ctx.fillStyle = color;
          ctx.fill();
        }

        fillPolys(land, T.land);
        fillPolys(block, T.block);
        fillPolys(green, T.green);
        fillPolys(water, T.water);

        // 河道：线状水系，用描边而不是填充
        if (waterLine.length) {
          ctx.beginPath();
          for (var w = 0; w < waterLine.length; w++) {
            var WP = waterLine[w].pts;
            ctx.moveTo(WP[0][0] * k, WP[0][1] * k);
            for (var wp = 1; wp < WP.length; wp++) ctx.lineTo(WP[wp][0] * k, WP[wp][1] * k);
          }
          ctx.strokeStyle = T.waterLine;
          ctx.lineWidth = 3.2 * k;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }

        // 道路：每档合成一条路径，一次 stroke
        for (var tier = 0; tier < T.roadTiers.length; tier++) {
          var arr = roadByTier[tier];
          if (!arr.length) continue;
          var st = T.roadTiers[tier];
          ctx.beginPath();
          for (var r = 0; r < arr.length; r++) {
            var RP = arr[r].pts;
            ctx.moveTo(RP[0][0] * k, RP[0][1] * k);
            for (var rp = 1; rp < RP.length; rp++) ctx.lineTo(RP[rp][0] * k, RP[rp][1] * k);
          }
          ctx.strokeStyle = st.color;
          ctx.lineWidth = st.width * k;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }

        // —— 注记 ——
        var L = T.label;
        var fs = L.size * k;
        ctx.font = fs + 'px ' + L.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 碰撞检测用矩形列表；比原来的"最小间距"靠谱：
        // 短地名可以紧挨着排，长地名自动让开，不会出现半截压在别人身上。
        var boxes = [];
        function hits(x, y, w, h) {
          for (var q = 0; q < boxes.length; q++) {
            var b = boxes[q];
            if (x - w / 2 < b.x + b.w / 2 + L.padding &&
                x + w / 2 > b.x - b.w / 2 - L.padding &&
                y - h / 2 < b.y + b.h / 2 + L.padding &&
                y + h / 2 > b.y - b.h / 2 - L.padding) return true;
          }
          return false;
        }

        // 短文本优先（通常是最重要的地名），长 POI 名靠后
        labels.sort(function (a, b) { return a.text.length - b.text.length; });

        var budget = z >= 13 ? 70 : 30;
        var textH = fs * 1.1;

        for (var li = 0; li < labels.length && budget > 0; li++) {
          var lf = labels[li];
          var txt = lf.text;
          if (!txt || !txt.trim()) continue;

          var w = ctx.measureText(txt).width;
          if (w > size - 6) continue;           // 一张瓦片放不下就不画，避免被切成两半
          var h = textH;

          // 关键：把文字整体夹进瓦片范围内。
          // 原来直接按锚点画，靠边的注记会被 canvas 边缘切掉后半段。
          var px = clamp(lf.pts[0][0] * k, w / 2 + 2, size - w / 2 - 2);
          var py = clamp(lf.pts[0][1] * k, h / 2 + 2, size - h / 2 - 2);

          if (hits(px, py, w, h)) continue;
          boxes.push({ x: px, y: py, w: w, h: h });
          budget--;

          var isSub = isSubwayText(txt) || isSubwayLabel(lf.layer);
          if (isSub) {
            // 地铁线号画成小胶囊，比纯文字醒目
            var SB = T.subway;
            ctx.font = 'bold ' + SB.size * k + 'px ' + L.font;
            var sw = ctx.measureText(txt).width + 7 * k;
            var sh = (SB.size + 4) * k;
            ctx.fillStyle = SB.bg;
            ctx.beginPath();
            var sx = px - sw / 2, sy = py - sh / 2, rr = sh / 2;
            ctx.moveTo(sx + rr, sy);
            ctx.arcTo(sx + sw, sy, sx + sw, sy + sh, rr);
            ctx.arcTo(sx + sw, sy + sh, sx, sy + sh, rr);
            ctx.arcTo(sx, sy + sh, sx, sy, rr);
            ctx.arcTo(sx, sy, sx + sw, sy, rr);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = SB.color;
            ctx.fillText(txt, px, py);
            ctx.font = fs + 'px ' + L.font;
          } else {
            ctx.lineWidth = L.haloWidth * k;
            ctx.strokeStyle = L.halo;
            ctx.strokeText(txt, px, py);
            ctx.fillStyle = L.color;
            ctx.fillText(txt, px, py);
          }
        }

        // —— 路牌 ——
        var S = T.shield;
        ctx.font = 'bold ' + S.size * k + 'px ' + L.font;
        for (var si = 0; si < shields.length; si++) {
          var sf = shields[si];
          var sTxt = sf.text;
          if (!sTxt) continue;
          var sw2 = ctx.measureText(sTxt).width + 6 * k;
          var sh2 = (S.size + 5) * k;
          var cx = sf.pts[0][0] * k;
          var cy = sf.pts[0][1] * k;
          if (cx < 0 || cy < 0 || cx > size || cy > size) continue;
          var bx = cx - sw2 / 2, by = cy - sh2 / 2, rad = 3 * k;
          ctx.beginPath();
          ctx.moveTo(bx + rad, by);
          ctx.arcTo(bx + sw2, by, bx + sw2, by + sh2, rad);
          ctx.arcTo(bx + sw2, by + sh2, bx, by + sh2, rad);
          ctx.arcTo(bx, by + sh2, bx, by, rad);
          ctx.arcTo(bx, by, bx + sw2, by, rad);
          ctx.closePath();
          ctx.fillStyle = S.bg;
          ctx.fill();
          ctx.fillStyle = S.color;
          ctx.fillText(sTxt, cx, cy);
        }
      }

      // 绘制异常不能往上抛：createTile 抛错会中断 Leaflet 整轮 _update，
      // 表现就是整片地图空白。这里兜住，最坏只是这张瓦片难看。
      function safeDraw(ctx, size, feats, z, dpr, T) {
        try {
          drawTile(ctx, size, feats, z, dpr, T);
        } catch (e) {
          console.error('[tencent-vec] draw failed', e);
        }
      }

      // —— 要素缓存（带条数上限，按插入顺序淘汰）——
      var cache = {};
      var cacheKeys = [];
      function cachePut(key, val) {
        if (!cache[key]) cacheKeys.push(key);
        cache[key] = val;
        while (cacheKeys.length > self.CACHE_LIMIT) {
          delete cache[cacheKeys.shift()];
        }
      }

      var TencentVectorLayer = L.GridLayer.extend({
        options: {
          tileSize: 256,
          minZoom: 3,
          maxZoom: (typeof map !== 'undefined' && map.options && map.options.maxZoom) || 21,
          minNativeZoom: self.NATIVE_MIN,
          maxNativeZoom: self.NATIVE_MAX,
          needFixChinaOffset: true,
          attribution: '© 腾讯地图',
          theme: 'light',
          updateWhenIdle: self.UPDATE_WHEN_IDLE,
          updateInterval: 150,
          keepBuffer: 1,
        },

        createTile: function (coords, done) {
          var size = this.getTileSize().x;
          var dpr = Math.min(window.devicePixelRatio || 1, self.PIXEL_RATIO_MAX);
          var themeName = this.options.theme;
          var T = self.THEMES[themeName] || self.THEMES.light;

          var canvas = document.createElement('canvas');
          canvas.width = Math.round(size * dpr);
          canvas.height = Math.round(size * dpr);
          canvas.style.width = size + 'px';
          canvas.style.height = size + 'px';

          var z = coords.z;
          // 缓存键要带主题，否则浅色/深色会互相污染
          var key = themeName + '/' + z + '/' + coords.x + '/' + coords.y;

          var hit = cache[key];
          if (hit) {
            // 两个坑：
            // ① 必须返回 canvas —— 写成 return paint(...) 会返回 undefined，Leaflet 拿不到瓦片元素；
            // ② done() 必须异步调 —— Leaflet 先 createTile 再把瓦片登记进 this._tiles[key]，
            //    同步调 done() 会让 _tileReady 查不到记录而直接 return，瓦片永远不算 loaded，
            //    缩放回来时整片空白。setTimeout(0) 让它排到登记之后。
            safeDraw(canvas.getContext('2d'), size, hit, z, dpr, T);
            setTimeout(function () { done(null, canvas); }, 0);
            return canvas;
          }

          var sub = (coords.x + coords.y) % 4;
          var xhr = new XMLHttpRequest();
          canvas._xhr = xhr;
          xhr.open('GET', requestUrl(z, coords.x, coords.y, sub), true);
          xhr.timeout = 15000;
          xhr.onload = function () {
            canvas._xhr = null;
            if (xhr.status !== 200) return done(new Error('HTTP ' + xhr.status), canvas);
            var feats;
            try {
              feats = decodeFeatures(JSON.parse(xhr.responseText));
            } catch (e) {
              return done(e, canvas);
            }
            cachePut(key, feats);
            safeDraw(canvas.getContext('2d'), size, feats, z, dpr, T);
            done(null, canvas);
          };
          xhr.onerror = function () { canvas._xhr = null; done(new Error('network'), canvas); };
          xhr.ontimeout = function () { canvas._xhr = null; done(new Error('timeout'), canvas); };
          xhr.send();

          return canvas;
        },

        // 瓦片被移出视野时中断未完成的请求，避免拖动过程中堆积无效 XHR
        _removeTile: function (key) {
          var t = this._tiles[key];
          if (t && t.el && t.el._xhr) {
            try { t.el._xhr.abort(); } catch (e) { /* 忽略 */ }
            t.el._xhr = null;
          }
          return L.GridLayer.prototype._removeTile.call(this, key);
        },

        // 腾讯矢量数据也是 GCJ-02，需要和 fix-china-map-offset 一样的偏移处理。
        // 那个插件只 patch 了 L.TileLayer，自定义 GridLayer 拿不到，所以自己来。
        // 这两个方法每帧都会被调用，按经纬度做一次缓存。
        _fixCenter: function (center) {
          if (!this.options.needFixChinaOffset) return center;
          var fx = window.plugin.fixChinaMapOffset;
          if (!fx || typeof fx.wgs_gcj !== 'function' || typeof fx.isInChina !== 'function') return center;

          var ck = center.lat + ',' + center.lng;
          if (this._gcjKey === ck) return this._gcjCenter;

          var out = center;
          try {
            if (fx.isInChina(center.lat, center.lng)) {
              var g = fx.wgs_gcj(center);
              out = L.latLng(g.lat, g.lng);
            }
          } catch (e) { /* 保持原值 */ }
          this._gcjKey = ck;
          this._gcjCenter = out;
          return out;
        },
        _getTiledPixelBounds: function (center) {
          return L.GridLayer.prototype._getTiledPixelBounds.call(this, this._fixCenter(center));
        },
        _setZoomTransform: function (level, center, zoom) {
          return L.GridLayer.prototype._setZoomTransform.call(this, level, this._fixCenter(center), zoom);
        },
      });

      var chooser = window.layerChooser || window.layerControl;
      if (!chooser || typeof chooser.addBaseLayer !== 'function') {
        console.warn('[tencent-vec] 未找到 layerChooser');
        return;
      }

      var lightLayer = new TencentVectorLayer({ theme: 'light' });
      lightLayer._tencentMaps = true;
      var darkLayer = new TencentVectorLayer({ theme: 'dark' });
      darkLayer._tencentMaps = true;

      chooser.addBaseLayer(lightLayer, '腾讯矢量地图（实验）', { isDark: false });
      chooser.addBaseLayer(darkLayer, '腾讯矢量地图（深色·实验）', { isDark: true });

      // 调试入口
      window.plugin.tencentVectorMap.layers = { light: lightLayer, dark: darkLayer };
      window.plugin.tencentVectorMap.redraw = function () {
        cache = {};
        cacheKeys = [];
        lightLayer.redraw();
        darkLayer.redraw();
      };
    } catch (e) {
      console.error('[tencent-vec] setup failed: ', e);
    }
  };

  var setup = function () {
    if (typeof self.setup === 'function') self.setup();
  };
  setup.info = plugin_info;
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  if (window.iitcLoaded && typeof setup === 'function') setup();
}

var script = document.createElement('script');
var info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  info.script = { version: GM_info.script.version, name: GM_info.script.name, description: GM_info.script.description };
}
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);
