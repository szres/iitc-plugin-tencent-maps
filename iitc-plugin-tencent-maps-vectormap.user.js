// ==UserScript==
// @id             iitc-plugin-tencent-maps-vectormap@tabris@szres
// @name           IITC plugin: Tencent Maps vector renderer (腾讯矢量底图·实验)
// @category       Map Tiles
// @version        0.1.2.20261103
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
// 为什么值得做：栅格瓦片只有 256×256，且没有任何 @2x 接口，「大字」只能靠放大 2 倍，
// 必然发虚。矢量数据是几何 + 文字，字号由我们自己决定，放大后依然锐利。
//
// 接口（2026-11 实测）：
//   https://rt{s}.map.gtimg.com/vector?z={z}&x={x}&y={y}&styleid=0&version={ver}
//   - TMS 纵坐标（y = 2^z - y_slippy - 1），与栅格瓦片一致
//   - 返回 JSON：{"ret":0,"features":[[layerId,[x0,y0,dx1,dy1,...],"文字"]]}
//   - 坐标是 0..256 的瓦片内坐标（允许负值和 >256，表示被裁切的几何）
//   - 几何是增量编码：首点绝对坐标，其后每两个数是相对上一点的 dx/dy
//   - 带文字的面要素第三个元素就是文本（POI 名 / 路牌）
//   - 响应头 access-control-allow-origin: * ，页面内可直接 XHR
//   - 层级 z6~z18 有数据
//
// 已知图层 id（北京 z16 实测推断，非官方文档）：
//   131094 / 131099 / 131103 / 131336 / 131505  道路（按 id 大小分等级）
//   196614 / 196622 / 196775                    建筑 / 面要素
//   655xx / 666xx                               POI 注记（带文字）
//   262xxx                                      路牌（G1 / S50 之类）
//
// 注意：这是实验代码，图层语义是从几何形状反推的，不是官方定义，
//       配色和等级只求「看起来像」，不追求与腾讯原版一致。
//
// 性能说明（0.1.1 修）：
//   初版拖动很卡，原因是三个：①平移动画期间每帧都在新建 canvas + XHR + 解码 + 绘制；
//   ②要素缓存无上限，长时间浏览内存一直涨；③低层级瓦片要素极多（z6 单瓦片 3800+ 个），
//   全都画了。现在分别用 updateWhenIdle / CACHE_LIMIT / 按层级取舍 + 注记预算 解决。

function wrapper(plugin_info) {
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  plugin_info.buildName = 'local';
  plugin_info.dateTimeVersion = '2026-11-03-000000';
  plugin_info.pluginId = 'tencent-maps-vectormap';

  window.plugin.tencentVectorMap = function () {};
  var self = window.plugin.tencentVectorMap;

  self.TILE_VERSION = 2232;
  self.TILE_HOST = 'rt';        // rt0..rt3
  self.STYLE_ID = 0;            // 0 标准 / 3 深色（矢量接口同样吃 styleid）
  self.NATIVE_MIN = 6;
  self.NATIVE_MAX = 18;

  // —— 性能相关 ——
  // 每张瓦片是一个独立 canvas，dpr 越大内存和合成开销越高。
  // 2 已经足够清晰（4K 屏也够），3 会明显吃 GPU 显存。
  self.PIXEL_RATIO_MAX = 2;
  // 解码后的要素缓存条数上限。不设上限的话，长时间拖图后内存会一直涨。
  self.CACHE_LIMIT = 240;
  // true：平移/缩放动画结束后才加载新瓦片 —— 拖动时不会卡，但松手后有一小段空白。
  // false：边拖边加载，观感更连续，但每帧都在做 XHR + 解码 + 绘制，低配机器会卡。
  self.UPDATE_WHEN_IDLE = true;

  // —— 外观 ——
  self.THEME = {
    background: '#f7f5f2',
    building: '#e8e4de',
    buildingStroke: '#dcd6cd',
    // 道路按「重要度」分三档，而不是写死 layerId。
    // 原因：腾讯的道路 layerId 是跟缩放级别绑定的 —— z6 主力是 131084，
    // z12 变成 131103，z16 又是 131094。写死 id 只在某一层级有效。
    // 这里改成按「同类要素数量」自动判级：同一层级里数量最少的等级最高（主干道）。
    roadTiers: [
      { width: 5.5, color: '#f6d69a' }, // 主干
      { width: 3.2, color: '#fbe6bd' }, // 次干
      { width: 1.4, color: '#ffffff' }, // 支路
    ],
    label: {
      size: 12,                 // 字号（tileSize=256 时的像素），想要大字就调这里
      color: '#333333',
      halo: '#ffffff',
      haloWidth: 3,
      font: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif',
      minGap: 14,               // 两个注记之间的最小间距，避免糊成一团
    },
    shield: { size: 10, bg: '#2b7a3d', color: '#ffffff', radius: 3 },
  };

  self.setup = function () {
    try {
      // —— 瓦片坐标换算 ——
      function requestUrl(z, x, ySlippy, sub) {
        var yTms = (1 << z) - 1 - ySlippy;
        return 'https://' + self.TILE_HOST + sub + '.map.gtimg.com/vector'
          + '?z=' + z + '&x=' + x + '&y=' + yTms
          + '&styleid=' + self.STYLE_ID + '&version=' + self.TILE_VERSION;
      }

      // —— 解码：[[layerId,[x0,y0,dx,dy,...],"text"], ...] ——
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

      function isArea(layerId) { return layerId >= 196000 && layerId < 197000; }
      function isShield(layerId) { return layerId >= 262000 && layerId < 263000; }
      function isLabel(layerId) { return (layerId >= 65536 && layerId < 67000); }
      function isRoad(layerId) { return layerId >= 131000 && layerId < 132000; }

      // 道路分级：按「同类要素的平均线段长度」判定，长的 = 主干道。
      // 两个坑都试过了：
      //   ①写死 layerId 不行 —— 腾讯的 id 跟缩放级别绑定（z6 主力 131084，z12 是 131103，z16 又变 131094）；
      //   ②按要素数量排也不行 —— 有些层级主网络本身就是最密集的那一类，会被误判成支路。
      // 用几何长度是跟层级无关的，稳。
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
          return stat[b].len / stat[b].n - stat[a].len / stat[a].n; // 平均长度降序
        });
        var tiers = {};
        for (var k = 0; k < ids.length; k++) tiers[ids[k]] = k === 0 ? 0 : k === 1 ? 1 : 2;
        return tiers;
      }

      // —— 绘制一张瓦片 ——
      function drawTile(ctx, size, feats, z, dpr) {
        var T = self.THEME;
        var k = size / 256; // 瓦片内坐标 -> 画布像素

        // 每次都用 setTransform 重置，避免在复用上下文时缩放叠加
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = T.background;
        ctx.fillRect(0, 0, size, size);

        // 1) 面要素（建筑/地块）先铺底
        for (var i = 0; i < feats.length; i++) {
          var f = feats[i];
          if (!isArea(f.layer) || f.pts.length < 3) continue;
          ctx.beginPath();
          ctx.moveTo(f.pts[0][0] * k, f.pts[0][1] * k);
          for (var p = 1; p < f.pts.length; p++) ctx.lineTo(f.pts[p][0] * k, f.pts[p][1] * k);
          ctx.closePath();
          ctx.fillStyle = T.building;
          ctx.fill();
          ctx.strokeStyle = T.buildingStroke;
          ctx.lineWidth = 0.6 * k;
          ctx.stroke();
        }

        // 2) 道路：先画粗的，细的压在上面
        var tiers = roadTiers(feats);
        var roadCount = 0;
        for (var rc = 0; rc < feats.length; rc++) if (isRoad(feats[rc].layer)) roadCount++;
        // 要素特别多的时候（z6 这类低层级）直接丢掉最细一档：那个尺度下画出来就是一团糊，
        // 而且几千条短线段是纯浪费。
        var skipThin = roadCount > 1500;

        for (var tier = 0; tier < T.roadTiers.length; tier++) {
          if (skipThin && tier === 2) continue;
          var st = T.roadTiers[tier];
          ctx.strokeStyle = st.color;
          ctx.lineWidth = st.width * k;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          for (var j = 0; j < feats.length; j++) {
            var rf = feats[j];
            if (!isRoad(rf.layer) || rf.pts.length < 2) continue;
            if (tiers[rf.layer] !== tier) continue;
            ctx.beginPath();
            ctx.moveTo(rf.pts[0][0] * k, rf.pts[0][1] * k);
            for (var q = 1; q < rf.pts.length; q++) ctx.lineTo(rf.pts[q][0] * k, rf.pts[q][1] * k);
            ctx.stroke();
          }
        }

        // 3) 注记
        var L2 = T.label;
        ctx.font = L2.size * k + 'px ' + L2.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var placed = [];
        // 每张瓦片的注记预算：低层级要素密集，不限量会拖慢绘制
        var budget = z >= 13 ? 60 : 25;
        function tooClose(px, py) {
          for (var m = 0; m < placed.length; m++) {
            var dx = placed[m][0] - px;
            var dy = placed[m][1] - py;
            if (dx * dx + dy * dy < L2.minGap * L2.minGap) return true;
          }
          return false;
        }
        for (var t = 0; t < feats.length && budget > 0; t++) {
          var lf = feats[t];
          if (!lf.text || !lf.text.trim() || isShield(lf.layer)) continue;
          if (!isLabel(lf.layer)) continue;
          var px = lf.pts[0][0] * k;
          var py = lf.pts[0][1] * k;
          if (px < 0 || py < 0 || px > size || py > size) continue;
          if (tooClose(px, py)) continue;
          placed.push([px, py]);
          budget--;
          ctx.lineWidth = L2.haloWidth * k;
          ctx.strokeStyle = L2.halo;
          ctx.strokeText(lf.text, px, py);
          ctx.fillStyle = L2.color;
          ctx.fillText(lf.text, px, py);
        }

        // 4) 路牌（G1 / S50 之类）
        var S = T.shield;
        ctx.font = 'bold ' + S.size * k + 'px ' + L2.font;
        for (var s = 0; s < feats.length; s++) {
          var sf = feats[s];
          if (!sf.text || !isShield(sf.layer)) continue;
          var sx = sf.pts[0][0] * k;
          var sy = sf.pts[0][1] * k;
          if (sx < 0 || sy < 0 || sx > size || sy > size) continue;
          var w = ctx.measureText(sf.text).width + 6 * k;
          var h = (S.size + 5) * k;
          var r = S.radius * k;
          ctx.beginPath();
          ctx.moveTo(sx - w / 2 + r, sy - h / 2);
          ctx.arcTo(sx + w / 2, sy - h / 2, sx + w / 2, sy + h / 2, r);
          ctx.arcTo(sx + w / 2, sy + h / 2, sx - w / 2, sy + h / 2, r);
          ctx.arcTo(sx - w / 2, sy + h / 2, sx - w / 2, sy - h / 2, r);
          ctx.arcTo(sx - w / 2, sy - h / 2, sx + w / 2, sy - h / 2, r);
          ctx.closePath();
          ctx.fillStyle = S.bg;
          ctx.fill();
          ctx.fillStyle = S.color;
          ctx.fillText(sf.text, sx, sy);
        }
      }

      // 绘制异常不能往上抛：createTile 抛错会中断 Leaflet 整轮 _update，
      // 表现就是整片地图空白，而且很难定位。这里兜住，最多是这张瓦片难看。
      function safeDraw(ctx, size, feats, z, dpr) {
        try {
          drawTile(ctx, size, feats, z, dpr);
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

      // —— Leaflet 图层：每张瓦片一个 canvas ——
      var TencentVectorLayer = L.GridLayer.extend({
        options: {
          tileSize: 256,
          minZoom: 3,
          maxZoom: (typeof map !== 'undefined' && map.options && map.options.maxZoom) || 21,
          minNativeZoom: self.NATIVE_MIN,
          maxNativeZoom: self.NATIVE_MAX,
          needFixChinaOffset: true,
          attribution: '© 腾讯地图',
          // 拖动时不做任何取数/绘制，松手后才补瓦片 —— 这是"卡"与"不卡"的分水岭
          updateWhenIdle: self.UPDATE_WHEN_IDLE,
          updateInterval: 150,
          keepBuffer: 1,
        },

        createTile: function (coords, done) {
          var size = this.getTileSize().x;
          var dpr = Math.min(window.devicePixelRatio || 1, self.PIXEL_RATIO_MAX);

          var canvas = document.createElement('canvas');
          canvas.width = Math.round(size * dpr);
          canvas.height = Math.round(size * dpr);
          canvas.style.width = size + 'px';
          canvas.style.height = size + 'px';

          var z = coords.z;
          var key = z + '/' + coords.x + '/' + coords.y;

          var hit = cache[key];
          if (hit) {
            // 命中缓存直接重绘。两个坑：
            // ① 必须返回 canvas —— 写成 return paint(...) 会返回 undefined，Leaflet 拿不到瓦片元素；
            // ② done() 必须异步调 —— Leaflet 的 _addTile 是「先 createTile，再把瓦片登记进
            //    this._tiles[key]」，同步调 done() 会让 _tileReady 找不到这条记录而直接 return，
            //    瓦片永远不算 loaded，缩放回来时整片空白。setTimeout(0) 让它排到登记之后。
            safeDraw(canvas.getContext('2d'), size, hit, z, dpr);
            setTimeout(function () { done(null, canvas); }, 0);
            return canvas;
          }

          // 子域沿用栅格瓦片的 (x + y) % 4 规则
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
            safeDraw(canvas.getContext('2d'), size, feats, z, dpr);
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
        // 那个插件只 patch 了 L.TileLayer，自定义 GridLayer 拿不到，所以这里自己来。
        // 这两个方法在每一帧都会被调用，所以按经纬度做一次缓存，别重复算。
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

      var layer = new TencentVectorLayer();
      layer._tencentMaps = true;

      var chooser = window.layerChooser || window.layerControl;
      if (!chooser || typeof chooser.addBaseLayer !== 'function') {
        console.warn('[tencent-vec] 未找到 layerChooser');
        return;
      }
      chooser.addBaseLayer(layer, '腾讯矢量地图（实验）', { isDark: self.STYLE_ID === 3 });

      // 调试入口：控制台里可以改字号后手动触发重绘
      window.plugin.tencentVectorMap.layer = layer;
      window.plugin.tencentVectorMap.redraw = function () {
        cache = {};
        cacheKeys = [];
        layer.redraw();
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
