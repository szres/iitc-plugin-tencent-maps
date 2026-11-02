// ==UserScript==
// @id             iitc-plugin-tencent-maps@tabris@szres
// @name           IITC plugin: Tencent Maps base layers (腾讯地图底图)
// @category       Map Tiles
// @version        0.5.3.20261103
// @namespace      tabris@szres
// @author         tabris@szres
// @description    Adds Tencent Maps (street / dark / silver / satellite / hybrid / terrain) and Esri World Imagery as base layers. 为 IITC 添加腾讯地图与 Esri 卫星底图。
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
// 0.5.3  图层「腾讯地图（深色·大字）」更名为「腾讯地图（突出地铁图）」。
//        注意：仅改显示名，瓦片源没变（仍是 styleid=3 深色底图 + scale=2 放大字号），
//        内部 key 仍为 darkBig（保持 AUTO_SELECT 配置兼容）。
// 0.5.2  适配 IITC Community-plugins 目录规范：精简 @description（目录列表会整段展示），
//        补齐 updateURL/downloadURL（目录构建系统必需）；功能无变化。
// 0.5.1  优化「大字」图层画质：强制 image-rendering:auto 覆盖 Safari 下的最近邻放大
//        （锯齿主因），并叠加轻度反锐化掩模（SVG feConvolveMatrix）抵消放大发虚；
//        新增 BIG_SCALE / BIG_RENDER / BIG_SHARPEN 三个开关，scale 增加 2 的幂校验。
// 0.5.0  新增「腾讯地图（大字）」「腾讯地图（深色·大字）」图层：tileSize 512 + 请求 z-1，
//        字号为标准版的 2 倍；瓦片尺寸逻辑重构为统一的 scale 推导
//        （nativeMin/nativeMax → tileSize / zoomOffset / maxNativeZoom / minNativeZoom），
//        彻底消除 maxNativeZoom 被算成 NaN 的可能。
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

  // 高清瓦片开关（影响"标准"图层的字号观感）：
  //   'auto'（默认）—— 高分屏（Windows 显示缩放 125%/150% 等，devicePixelRatio>1.05）
  //                    自动请求 z+1 瓦片并按半尺寸渲染：像素密度翻倍更锐利，
  //                    但注意字号会变成一半（因为显示的是缩小后的下一层级瓦片）；
  //   true           —— 无论什么屏幕都强制高清（瓦片请求数 ×4）；
  //   false          —— 关闭，使用 256px 原生瓦片，字号 1:1（觉得字小的另一个解法）。
  //
  // 若觉得字太小，最省事的办法是直接选图层里的「腾讯地图（大字）」：
  // 它固定 scale=2（请求 z-1、按 512px 渲染），字号是标准版的 2 倍，不受本开关影响。
  self.HD_TILES = 'auto';

  // ——「大字」图层的画质取向 ——
  // 前提：腾讯只提供 256×256 瓦片（实测 15 种 @2x/scl/size/dpi/png 参数全部被忽略），
  // 所以字号放大 2 倍必然是把 256px 源放大 2 倍，锐度有物理上限。以下三项只能取舍：
  //
  //   BIG_SCALE   放大倍数，必须是 2 的整数次幂。默认 2（字号 ×2）；
  //               4 也能用但 256px 源放大 4 倍会非常糊，不建议。
  //   BIG_RENDER  'smooth'（默认）双线性插值 —— 边缘柔和，没有硬锯齿，但略糊；
  //               'crisp'  最近邻 —— 边缘硬，2× 时锯齿明显（只在你能接受锯齿时用）。
  //   BIG_SHARPEN true（默认）额外叠一层轻微反锐化掩模（SVG 滤镜），
  //               抵消放大后的发虚，让文字边缘更实；嫌耗性能可设 false。
  self.BIG_SCALE = 2;
  self.BIG_RENDER = 'smooth';
  self.BIG_SHARPEN = true;

  // 设为 'street' / 'streetBig' / 'dark' / 'darkBig' / 'silver' /
  //       'satellite' / 'hybrid' / 'esri' / 'terrain'
  // （darkBig 即图层列表里的「腾讯地图（突出地铁图）」，key 沿用旧名以兼容已有配置）
  // 可在插件加载后自动切换为默认底图；保持 null 则仅在图层选择器中注册，手动选择。
  self.AUTO_SELECT = null;

  self.setup = function () {
    try {
      // 重要：图层类必须定义在 setup 内部。
      // setup 由 IITC 调用，此时 Leaflet (L) 才保证就绪；
      // 若把 L.TileLayer.extend 放在脚本顶层，油猴注入时序可能先于 IITC 加载，
      // 导致 "L is not defined" 报错、插件静默失效。
      //
      // —— 瓦片渲染尺寸（scale）——
      // 实测腾讯各层级瓦片都是 256×256，所以"字看着多大"完全由 tileSize 决定：
      //   scale = 2   → tileSize 512 + zoomOffset -1：请求 z-1 瓦片、按 512px 渲染
      //                 → 字号 ×2，代价是细节降一层、边缘略糊（"大字"图层用这个）
      //   scale = 1   → tileSize 256 + zoomOffset  0：原生，字号 1:1
      //   scale = 0.5 → tileSize 128 + zoomOffset +1：请求 z+1 瓦片、按 128px 渲染
      //                 → 像素密度翻倍更锐利，但字号只有一半（高分屏默认走这个，
      //                   这也是"高分屏下觉得字变小了"的根因）
      // 三个参数必须联动，否则会请求到不存在的层级（返回占位空白图）：
      //   URL z = clamp(地图缩放, minNativeZoom, maxNativeZoom) + zoomOffset
      //   → maxNativeZoom = nativeMax - zoomOffset
      //   → minNativeZoom = nativeMin - zoomOffset
      // 所以图层只需声明 nativeMin / nativeMax 两个"真实层级上限"，其余自动推导。
      function resolveScale(explicit) {
        if (typeof explicit === 'number' && explicit > 0) {
          // 只接受 2 的整数次幂：tileSize 与 zoomOffset 必须满足
          // tileSize = 256 * 2^(-zoomOffset)，否则地图几何会整体错位
          var lg = Math.log(explicit) / Math.LN2;
          if (Math.abs(lg - Math.round(lg)) > 1e-6) {
            console.warn('[tencent-maps] scale 必须是 2 的整数次幂（0.5 / 1 / 2 / 4），已回退为 2');
            return 2;
          }
          return explicit;
        }
        var dpr = window.devicePixelRatio || 1;
        var hd = (self.HD_TILES === true) ||
                 (self.HD_TILES !== false && dpr > 1.05);
        return hd ? 0.5 : 1;
      }

      function applyScale(options) {
        var scale = resolveScale(options.scale);
        var zoomOffset = -Math.round(Math.log(scale) / Math.LN2);
        if (typeof options.nativeMax !== 'number' || typeof options.nativeMin !== 'number') {
          // 兜底：拿不到原生层级就按 1:1 处理，绝不让 NaN 流进 Leaflet
          console.warn('[tencent-maps] nativeMax/nativeMin 缺失，已跳过缩放调整');
          return options;
        }
        options.scale = scale;
        options.tileSize = 256 * scale;
        options.zoomOffset = zoomOffset;
        options.maxNativeZoom = options.nativeMax - zoomOffset;
        options.minNativeZoom = Math.max(0, options.nativeMin - zoomOffset);
        // 放大渲染的图层要套用"平滑插值 + 轻微锐化"，见 installBigTileStyle()
        options.bigTile = scale > 1;
        return options;
      }

      // —— 大字图层的画质处理 ——
      // 1) image-rendering: auto
      //    IITC 在 Safari 下给 .leaflet-tile 设了 -webkit-optimize-contrast（最近邻），
      //    2× 放大时会出硬锯齿，这里对大字瓦片强制覆盖回平滑插值。
      // 2) SVG 反锐化掩模
      //    双线性放大后文字边缘会发虚，用 3×3 卷积核（中心 1.6、四邻 -0.15，权重和 = 1）
      //    做轻度锐化，边缘更实但不会产生明显白边。
      function installBigTileStyle() {
        if (document.getElementById('tm-big-tile-style')) return;

        var css = '.leaflet-tile.tm-big-tile{'
          + 'image-rendering:' + (self.BIG_RENDER === 'crisp' ? '-webkit-optimize-contrast' : 'auto')
          + ' !important;}';

        if (self.BIG_SHARPEN) {
          var holder = document.createElement('div');
          holder.setAttribute('aria-hidden', 'true');
          holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
          holder.innerHTML = '<svg width="0" height="0" style="position:absolute">'
            + '<filter id="tm-big-sharpen" x="0" y="0" width="100%" height="100%">'
            + '<feConvolveMatrix order="3" preserveAlpha="true" divisor="1"'
            + ' kernelMatrix="0 -0.15 0 -0.15 1.6 -0.15 0 -0.15 0"/></filter></svg>';
          (document.body || document.documentElement).appendChild(holder);
          css += '.leaflet-tile.tm-big-tile{filter:url(#tm-big-sharpen);}';
        }

        var style = document.createElement('style');
        style.id = 'tm-big-tile-style';
        style.appendChild(document.createTextNode(css));
        (document.head || document.documentElement).appendChild(style);
      }

      var TencentTileLayer = L.TileLayer.extend({
        options: {
          subdomains: ['0', '1', '2', '3'],
          minZoom: 3,
          nativeMin: 3,
          nativeMax: 18,
          scale: null, // null = 跟随 HD_TILES 自动判定；2 = 大字；1 = 原生；0.5 = 高清
          bigTile: false, // 由 applyScale 按 scale 自动设置
          needFixChinaOffset: true, // 供 fix-china-map-offset 插件识别
          attribution: '© 腾讯地图'
        },
        // 给大字瓦片打类名，以便套用上面的 CSS（Leaflet 1.x 的 GridLayer 没有 className 选项）
        createTile: function (coords, done) {
          var tile = L.TileLayer.prototype.createTile.call(this, coords, done);
          if (this.options.bigTile) tile.className += ' tm-big-tile';
          return tile;
        },
        initialize: function (options) {
          options = L.extend({
            nativeMin: 3, // 实测 z=3 可用（官方声明 minZoom=4）
            nativeMax: 18, // 矢量瓦片原生上限
            maxZoom: (typeof map !== 'undefined' && map.options && map.options.maxZoom) || 21
          }, options);
          L.TileLayer.prototype.initialize.call(this, '', applyScale(options));
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
          nativeMin: 2,
          nativeMax: 19, // 实测中国城市原生细节到 z19，z20 起为空白占位图
          needFixChinaOffset: false,
          attribution: '© Esri, Maxar, Earthstar Geographics'
        },
        initialize: function (options) {
          options = L.extend({
            // 必须显式给 nativeMin/nativeMax：早期版本这里漏了上限，
            // 高清模式下 undefined - 1 得到 NaN 覆盖掉原型值，
            // Leaflet 的 _clampZoom 对 NaN 恒不钳制 → 一路请求到 z21/z22 的空白瓦片。
            nativeMin: 2,
            nativeMax: 19,
            maxZoom: (typeof map !== 'undefined' && map.options && map.options.maxZoom) || 21
          }, options);
          L.TileLayer.prototype.initialize.call(this,
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            applyScale(options));
        }
      });

      function mark(layer) { layer._tencentMaps = true; return layer; }
      function vec(styleid, extra) {
        return mark(new TencentVectorLayer(L.extend({ styleid: styleid }, extra)));
      }
      function grid(dir, ext, nativeMax, extra) {
        return mark(new TencentGridLayer(L.extend({ tileDir: dir, tileExt: ext, nativeMax: nativeMax }, extra)));
      }

      var satellite = grid('sateTiles', '.jpg', 18);
      // 卫星混合 = 卫星影像 + 透明路网标注层（styleid=2）
      var hybrid = L.layerGroup([
        satellite,
        mark(new TencentVectorLayer({ styleid: 2, attribution: '', nativeMax: 18 }))
      ]);
      mark(hybrid); // 组本身也打标记，便于 AUTO_SELECT 判定"这是自己的图层"

      // 大字图层的平滑/锐化 CSS 只需要装一次
      installBigTileStyle();

      // 每项：[key, 图层, 显示名, 是否暗色]
      // 「大字」版用 scale = BIG_SCALE（默认 2：tileSize 512 + 请求 z-1），
      // 字号是标准版的 2 倍，适合高分屏/高分屏缩放后觉得字太小的情况；
      // 代价是细节降一层，画质由 BIG_RENDER / BIG_SHARPEN 两个开关调节。
      // 卫星/地形没有文字标注，放大只会更糊，所以不提供大字版。
      var layers = [
        ['street',    vec(0),                       '腾讯地图',             false],
        ['streetBig', vec(0, { scale: self.BIG_SCALE }), '腾讯地图（大字）',      false],
        ['dark',      vec(3),                       '腾讯地图（深色）',      true],
        ['darkBig',   vec(3, { scale: self.BIG_SCALE }), '腾讯地图（突出地铁图）', true],
        ['silver',    vec(4),                       '腾讯地图（浅灰）',      false],
        ['satellite', satellite,                    '腾讯卫星',             true],
        ['hybrid',    hybrid,                       '腾讯卫星（路网）',      true],
        ['esri',      new EsriImageryLayer(),       'Esri 卫星',            true],
        ['terrain',   grid('demTiles', '.png', 15), '腾讯地形',             false]
      ];

      var created = {};
      layers.forEach(function (item) { created[item[0]] = item[1]; });

      // IITC-CE 的图层选择器全局是 window.layerChooser（旧版 IITC 的 layerControl 已不存在）
      var chooser = window.layerChooser || window.layerControl;
      if (!chooser || typeof chooser.addBaseLayer !== 'function') {
        console.warn('[tencent-maps] 未找到 layerChooser/layerControl，图层无法注册');
        return;
      }
      layers.forEach(function (item) {
        // 旧版 layerControl.addBaseLayer 只有两个参数，多余参数会被忽略，安全
        chooser.addBaseLayer(item[1], item[2], { isDark: item[3] });
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
