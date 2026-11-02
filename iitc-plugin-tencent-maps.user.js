// ==UserScript==
// @id             iitc-plugin-tencent-maps@tabris@szres
// @name           IITC plugin: Tencent Maps base layers (腾讯地图底图)
// @category       Map Tiles
// @version        0.4.0.20261103
// @namespace      tabris@szres
// @author         tabris@szres
// @description    Adds Tencent Maps and Esri World Imagery base layers to IITC: street / dark / silver / satellite / satellite+roads / terrain / Esri satellite, using the current rt*.map.gtimg.com tile API. 为 IITC 添加腾讯地图与 Esri 卫星底图：标准、深色、浅灰、卫星、卫星（路网）、地形、Esri 卫星。使用腾讯地图当前官方瓦片接口 rt*.map.gtimg.com/tile。
// @match          https://intel.ingress.com/*
// @match          https://intel-x.ingress.com/*
// @match          https://www.ingress.com/intel*
// @grant          none
// @license        MIT
// @homepageURL    https://github.com/szres/iitc-plugin-tencent-maps
// @supportURL     https://github.com/szres/iitc-plugin-tencent-maps/issues
// @downloadURL    https://raw.githubusercontent.com/szres/iitc-plugin-tencent-maps/main/iitc-plugin-tencent-maps.user.js
// @updateURL      https://raw.githubusercontent.com/szres/iitc-plugin-tencent-maps/main/iitc-plugin-tencent-maps.user.js
// ==/UserScript==

/* global L, map -- eslint */

// —— 版本历史 ——
// 0.4.0  修复高清模式下 Esri 图层 maxNativeZoom 被算成 NaN 导致放大后请求空白瓦片；
//        图层选择器增加旧版 IITC 兼容与暗色主题标记；AUTO_SELECT 改用 layerChooser.show；
//        元数据清理（去掉与 @match 重复的 @include、@namespace 改为作者自己的仓库）。
// 0.3.3  新增浅灰/地形/Esri 卫星，高清瓦片支持。
// 0.1.0  初版：腾讯矢量 + 卫星，内置 GCJ-02 纠偏。

function wrapper(plugin_info) {
  // ensure plugin framework is there, even if iitc is not yet loaded
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  plugin_info.buildName = 'local';
  plugin_info.dateTimeVersion = '2026-11-03-000000';
  plugin_info.pluginId = 'tencent-maps';

  // use own namespace for plugin
  window.plugin.tencentMaps = function () {};
  var self = window.plugin.tencentMaps;

  // //////////////////////////////////////////////////////////////////////
  // 瓦片接口说明（2026-09 依据 map.qq.com 官方前端代码 + 逐瓦片实测确认）
  //
  // 矢量底图（官方实时接口，即 map.qq.com 当前所用）:
  //   https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid={style}&version={ver}
  //   - 腾讯使用 TMS 纵坐标（原点在左下角）: y = 2^z - y_slippy - 1
  //     （官方 LayerFactory 代码: r = Math.pow(2, l) - r - 1）
  //   - 子域选择规则（官方代码）: s = (x + y) % 4
  //   - styleid: 0=标准  2=路网标注(透明底,叠加在卫星图上)  3=深色
  //              4=浅灰  8=淡雅  9=白灰(含POI)；无效值回退为标准样式
  //   - version: 官方通过 confinfo.map.qq.com 接口动态下发（当前为 2232），
  //     实测服务器对旧版本号同样兼容，无需严格一致
  //   - 官方 minZoom=4、maxZoom=18（z=3 实测可用；更深层级由 Leaflet 放大补齐）
  //
  // 卫星影像 / 地形图（每 16×16 张瓦片一组存放目录）:
  //   https://p{s}.map.gtimg.com/sateTiles/{z}/{x>>4}/{y>>4}/{x}_{y}.jpg
  //   https://p{s}.map.gtimg.com/demTiles/{z}/{x>>4}/{y>>4}/{x}_{y}.png
  //   - 同样为 TMS 纵坐标
  //   - 卫星原生最高 z18（z19 起返回"此区域无卫星图"占位图）
  //   - 地形原生最高 z15
  //
  // 注意：腾讯瓦片为 GCJ-02 火星坐标系，与 Ingress (WGS84) 存在约几百米偏移。
  //       如需纠偏，请同时安装 IITC-CE 官方插件 fix-china-map-offset，
  //       本插件所有腾讯图层均已标记 needFixChinaOffset: true。
  //       （该插件改写的是 _getTiledPixelBounds / _setZoomTransform，不改 getTileUrl，
  //         因此与本插件自定义的 getTileUrl 不冲突。）
  //
  // 免责：本插件直连腾讯地图的公开瓦片接口，未使用开发者密钥。
  //       公开分发前请自行确认是否符合腾讯地图服务条款；接口若变更，插件可能失效。
  // //////////////////////////////////////////////////////////////////////

  self.ATTRIBUTION = '© 腾讯地图';
  self.TILE_VERSION = 2232; // confinfo.map.qq.com 当前下发的矢量瓦片版本号
  self.SESSION_ID = Date.now(); // 会话级缓存指纹（见 _buildUrl 内说明）

  // 高清瓦片开关：
  //   'auto'（默认）—— 高分屏（Windows 显示缩放 125%/150% 等，devicePixelRatio>1.05）
  //                    自动请求 z+1 瓦片并按半尺寸渲染，密度翻倍，文字明显更清晰；
  //   true           —— 无论什么屏幕都强制高清（标准屏也有抗锯齿收益，但瓦片请求数 ×4）；
  //   false          —— 关闭，始终使用 256px 原生瓦片。
  self.HD_TILES = 'auto';

  // 设为 'street' / 'dark' / 'silver' / 'satellite' / 'hybrid' / 'esri' / 'terrain'
  // 可在插件加载后自动切换为默认底图；保持 null 则仅在图层选择器中注册，手动选择。
  self.AUTO_SELECT = null;

  self.setup = function () {
    try {
      // 重要：图层类必须定义在 setup 内部。
      // setup 由 IITC 调用，此时 Leaflet (L) 才保证就绪；
      // 若把 L.TileLayer.extend 放在脚本顶层，油猴注入时序可能先于 IITC 加载，
      // 导致 "L is not defined" 报错、插件静默失效。
      //
      // 高清瓦片设置（腾讯图层与 Esri 图层共用）。
      // 原理：tileSize 128 + zoomOffset 1 → 请求 z+1 级瓦片，但每张仍按 128 CSS px
      // 渲染，于是在 DPR=2 的屏幕上 256px 的原图正好铺满 256 设备像素，做到 1:1 不放大。
      // maxNativeZoom 必须同步 -1，否则 Leaflet 会把 _tileZoom 钳到原生上限后
      // 再加 zoomOffset，从而去请求 z19（腾讯/Esri 都没有，返回占位空白图）。
      function applyHd(options) {
        var dpr = window.devicePixelRatio || 1;
        var hd = (self.HD_TILES === true) ||
                 (self.HD_TILES !== false && dpr > 1.05);
        if (hd) {
          if (typeof options.maxNativeZoom !== 'number') {
            // 兜底：拿不到原生上限就退回普通瓦片，绝不让 NaN 流进 Leaflet
            console.warn('[tencent-maps] maxNativeZoom 缺失，已跳过高清模式');
            return options;
          }
          options.tileSize = 128;
          options.zoomOffset = 1;
          options.maxNativeZoom -= 1;
        }
        return options;
      }

      var TencentTileLayer = L.TileLayer.extend({
        options: {
          subdomains: ['0', '1', '2', '3'],
          minZoom: 3,
          maxNativeZoom: 18,
          needFixChinaOffset: true, // 供 fix-china-map-offset 插件识别
          attribution: '© 腾讯地图'
        },
        initialize: function (options) {
          options = L.extend({
            maxNativeZoom: 18, // 类默认值：显式写出以便高清模式下正确 -1
            maxZoom: (typeof map !== 'undefined' && map.options && map.options.maxZoom) || 21
          }, options);
          L.TileLayer.prototype.initialize.call(this, '', applyHd(options));
        },
        getTileUrl: function (coords) {
          var z = this._getZoomForUrl();
          var x = coords.x;
          var y = (1 << z) - 1 - coords.y; // 2^z - y - 1，转换为腾讯 TMS 纵坐标
          var sub = this.options.subdomains[Math.abs(x + y) % this.options.subdomains.length];
          return this._buildUrl(z, x, y, sub);
        },
        _buildUrl: function () { return ''; }
      });

      // 矢量底图（rt 服务器）
      var TencentVectorLayer = TencentTileLayer.extend({
        _buildUrl: function (z, x, y, sub) {
          var url = 'https://rt' + sub + '.map.gtimg.com/tile'
            + '?z=' + z + '&x=' + x + '&y=' + y
            + '&styleid=' + this.options.styleid
            + '&version=' + self.TILE_VERSION;
          // 非标准样式加会话级缓存指纹：实测腾讯 CDN 曾瞬时把 styleid=3/4 回退成
          // 标准样式返回，而瓦片响应 Cache-Control 长达 2 天，一旦命中会把错误
          // 内容缓存在浏览器里。每个会话使用新指纹即可规避，会话内仍正常复用缓存。
          if (this.options.styleid !== 0) url += '&_t=' + self.SESSION_ID;
          return url;
        }
      });

      // 卫星 / 地形（p 服务器，16×16 分目录）
      var TencentGridLayer = TencentTileLayer.extend({
        _buildUrl: function (z, x, y, sub) {
          return 'https://p' + sub + '.map.gtimg.com/' + this.options.tileDir
            + '/' + z + '/' + (x >> 4) + '/' + (y >> 4)
            + '/' + x + '_' + y + this.options.tileExt;
        }
      });

      // Esri World Imagery 卫星影像：WGS84 对齐（无 GCJ-02 偏移，portal 对点准）、
      // 无需密钥。注意 REST 模板是 z/y/x 顺序，使用 Leaflet 默认 XYZ 纵坐标（无 TMS 变换）。
      var EsriImageryLayer = L.TileLayer.extend({
        options: {
          minZoom: 2,
          maxNativeZoom: 19, // 实测中国城市原生细节到 z19，z20 起为空白占位图
          needFixChinaOffset: false,
          attribution: '© Esri, Maxar, Earthstar Geographics'
        },
        initialize: function (options) {
          options = L.extend({
            // FIX(0.4.0)：这里必须显式给 maxNativeZoom，否则 applyHd 里
            // options.maxNativeZoom 为 undefined，减一得到 NaN 覆盖掉原型上的 19，
            // Leaflet 的 _clampZoom 判断 NaN 恒为 false → 不再钳制层级，
            // 高分屏下会一路请求到 z21/z22，拿到的是"无数据"空白瓦片。
            maxNativeZoom: 19,
            maxZoom: (typeof map !== 'undefined' && map.options && map.options.maxZoom) || 21
          }, options);
          L.TileLayer.prototype.initialize.call(this,
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            applyHd(options));
        }
      });

      function mark(layer) { layer._tencentMaps = true; return layer; }
      function vec(styleid) {
        return mark(new TencentVectorLayer({ styleid: styleid }));
      }
      function grid(dir, ext, maxNative) {
        return mark(new TencentGridLayer({ tileDir: dir, tileExt: ext, maxNativeZoom: maxNative }));
      }

      var satellite = grid('sateTiles', '.jpg', 18);
      // 卫星混合 = 卫星影像 + 透明路网标注层（styleid=2）
      var hybrid = L.layerGroup([
        satellite,
        mark(new TencentVectorLayer({ styleid: 2, attribution: '', maxNativeZoom: 18 }))
      ]);
      mark(hybrid); // 组本身也打标记，便于 AUTO_SELECT 判定"这是自己的图层"

      // [图层, 名称, 是否暗色]——第三项交给 IITC-CE 的图层选择器，
      // 暗色主题下可以自动优先选深色底图（0.4.0 新增）。
      var layers = [
        [vec(0), '腾讯地图', false],
        [vec(3), '腾讯地图（深色）', true],
        [vec(4), '腾讯地图（浅灰）', false],
        [satellite, '腾讯卫星', true],
        [hybrid, '腾讯卫星（路网）', true],
        [new EsriImageryLayer(), 'Esri 卫星', true],
        [grid('demTiles', '.png', 15), '腾讯地形', false]
      ];

      var created = {
        street:    layers[0][0],
        dark:      layers[1][0],
        silver:    layers[2][0],
        satellite: layers[3][0],
        hybrid:    layers[4][0],
        esri:      layers[5][0],
        terrain:   layers[6][0]
      };

      // IITC-CE 的图层选择器全局是 window.layerChooser（旧版 IITC 的 layerControl 已不存在）
      var chooser = window.layerChooser || window.layerControl;
      if (!chooser || typeof chooser.addBaseLayer !== 'function') {
        console.warn('[tencent-maps] 未找到 layerChooser/layerControl，图层无法注册');
        return;
      }
      layers.forEach(function (item) {
        // 旧版 layerControl.addBaseLayer 只有两个参数，多余参数会被忽略，安全
        chooser.addBaseLayer(item[0], item[1], { isDark: item[2] });
      });

      // 可选：自动切换为默认底图。
      // 等到 iitcLoaded 钩子（IITC 添加完自家默认底图之后）再切换，避免被盖住。
      if (self.AUTO_SELECT && created[self.AUTO_SELECT]) {
        var applyAutoSelect = function () {
          try {
            var target = created[self.AUTO_SELECT];
            // 优先用选择器官方 API，它会同步单选状态；手动 map.addLayer 不会。
            if (typeof chooser.show === 'function') {
              chooser.show(target, true);
              return;
            }
            map.eachLayer(function (l) {
              if (l instanceof L.GridLayer && !l._tencentMaps) map.removeLayer(l);
            });
            if (!map.hasLayer(target)) map.addLayer(target);
          } catch (e) {
            console.error('[tencent-maps] auto select failed: ', e);
          }
        };
        if (window.addHook) {
          window.addHook('iitcLoaded', applyAutoSelect);
        } else {
          applyAutoSelect();
        }
      }
    } catch (e) {
      console.error('[tencent-maps] setup failed: ', e);
    }
  };

  // —— 启动逻辑（与 IITC-CE 官方插件 basemap-gaode 相同的模式）——
  var setup = function () {
    if (typeof self.setup === 'function') self.setup();
  };
  setup.info = plugin_info; // add the script info data to the function as a property
  if (!window.bootPlugins) window.bootPlugins = [];
  window.bootPlugins.push(setup);
  // if IITC has already booted, immediately run the 'setup' function
  if (window.iitcLoaded && typeof setup === 'function') setup();
} // wrapper end

// inject code into site context
var script = document.createElement('script');
var info = {};
if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
  info.script = { version: GM_info.script.version, name: GM_info.script.name, description: GM_info.script.description };
}
script.appendChild(document.createTextNode('(' + wrapper + ')(' + JSON.stringify(info) + ');'));
(document.body || document.head || document.documentElement).appendChild(script);
