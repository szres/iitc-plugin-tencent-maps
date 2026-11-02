// ==UserScript==
// @id             iitc-plugin-tencent-maps@tabris@szres
// @name           IITC plugin: Tencent Maps base layers (腾讯地图底图)
// @category       Map Tiles
// @version        0.6.3.20261103
// @namespace      tabris@szres
// @author         tabris@szres
// @description    Adds Tencent Maps (raster: street / dark / silver / satellite / hybrid / terrain, plus a canvas vector renderer) and Esri World Imagery as base layers. 为 IITC 添加腾讯地图底图：栅格版（标准/深色/浅灰/大字/卫星/地形）与矢量渲染版（字号任意放大仍清晰），以及 Esri 卫星。
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
// 0.6.3  修复 z11 以上沿海城市成片陆地仍显示为海：
//        · 根因：海洋（196610）原来是「只要瓦片里出现一个海洋多边形，就 fillRect 铺满整张瓦片」。
//          这个写法在 z≤10 成立（那时 196610 就是覆盖整瓦片的矩形），但 z≥11 的 196610
//          是真实的局部海洋多边形（实测香港瓦片只占 9%~64%），铺满后凡是含海的瓦片全变海，
//          而 z≥11 又没有陆地图层（196612）来覆盖 → 沿海陆地整片消失。
//          放大到出现「不含海洋多边形的瓦片」时才显示陆地，正是「放大后才加载出陆地」。
//        · 解法：改为按多边形填充海洋（fillPolys(ocean, T.ocean)），与陆地/绿地/水域一致。
//          z≤10 的整瓦片矩形填出来仍是铺满，行为不变。
//        · 已验证：无头 Chrome + 真实 Leaflet，z11/z12 香港海陆分明，tileerror=0。
// 0.6.2  修复矢量图层整层空白（合并 0.6.0 时引入的致命 bug）：
//        · _setZoomTransform 覆写时漏传了 level 参数，父类收到的是 (center, zoom)，
//          于是 level 位置成了 LatLng、level.origin 为 undefined，
//          父类里 level.origin.multiplyBy(...) 抛 TypeError，addTo 直接中断 → 整层白屏。
//          v0.2.2 实验分支里这行是对的（call(this, level, ...)），合并时弄丢了。
//        · 已用无头 Chrome + 真实 Leaflet 复现并验证修复：z10 走栅格 8/9 张全部加载，
//          z12 走 canvas 8 张全部渲染，tileerror=0。
// 0.6.1  修复矢量图层在 z10 及以下把陆地画成海洋：
//        · 根因：腾讯矢量接口低层级（≤z10）的海洋是「铺满整块的底色」（196610 只有 1 个
//          覆盖全瓦片的矩形），靠陆地多边形 196612 覆盖出来，而那份陆地图层在低层级
//          有整片缺失（实测深圳东部 22.56,114.30 只命中海洋、无陆地），于是成片陆地变海。
//          z11 起改为「真实海洋多边形 + 背景即陆地」，数据完整，所以放大后反而正常。
//        · 解法：新增 VEC_RASTER_BELOW（默认 11），低于该层级直接返回腾讯栅格瓦片，
//          高层级仍用 canvas 自绘。栅格 styleid 跟随主题（浅色 0 / 深色 3）。
// 0.6.0  合并栅格版与矢量版为同一个插件：
//        · 栅格图层（标准/大字/深色/突出地铁图/浅灰/卫星/卫星路网/地形）+ Esri 卫星，全部保留
//        · 新增矢量渲染图层（浅色/深色）：拉腾讯 JSON 矢量瓦片用 canvas 自绘，字号任意放大不糊
//        · 矢量模块的图层 id 语义、注记避让、路名拼合等均从实验分支并入
// 0.5.3  图层「腾讯地图（深色·大字）」更名为「腾讯地图（突出地铁图）」
// 0.5.2  适配 IITC Community-plugins 目录规范：精简 @description、补齐 updateURL/downloadURL
// 0.5.1  大字画质：image-rendering:auto + SVG 反锐化掩模 + BIG_* 开关
// 0.5.0  新增「大字」图层；瓦片尺寸重构为统一 scale 推导
// 0.4.0  修复高清模式下 Esri 图层 maxNativeZoom 被算成 NaN 导致请求空白瓦片
// 0.3.3  新增浅灰/地形/Esri 卫星，高清瓦片支持
// 0.1.0  初版：腾讯矢量 + 卫星，内置 GCJ-02 纠偏
//
// //////////////////////////////////////////////////////////////////////
// 瓦片接口说明（2026-09 依据 map.qq.com 官方前端代码 + 逐瓦片实测确认）
//
// 一、栅格瓦片
//   矢量底图:  https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid={style}&version={ver}
//   卫星/地形: https://p{s}.map.gtimg.com/sateTiles|demTiles/{z}/{x>>4}/{y>>4}/{x}_{y}.jpg|png
//   - 腾讯使用 TMS 纵坐标: y = 2^z - y_slippy - 1
//   - 子域规则: s = (x + y) % 4
//   - styleid: 0=标准 2=路网标注(透明) 3=深色 4=浅灰 8=淡雅 9=白灰
//   - 各层级固定 256×256，无 @2x 接口（15 种参数写法实测全部被忽略）
//   - 矢量瓦片是 JPEG，styleid=3 是 PNG 无损，所以深色版放大更耐看
//   - 卫星原生 z18、地形原生 z15
//
// 二、矢量瓦片（JSON，非 MVT）
//   https://rt{s}.map.gtimg.com/vector?z={z}&x={x}&y={y}&styleid=0&version={ver}
//   - 同样 TMS 纵坐标，z6~z18 有数据
//   - 返回 {"ret":0,"features":[[layerId,[x0,y0,dx1,dy1,...],"文字"]]}
//   - 坐标是 0..256 的瓦片内坐标；几何为增量编码（首点绝对，其后每两点为相对增量）
//   - 响应头 access-control-allow-origin: *，页面内可直接 XHR
//   - 图层 id 语义为逆向推断（非官方），见下方 setupVectorLayers 内注释
//
// 三、坐标系
//   腾讯全部图层为 GCJ-02，与 Ingress 的 WGS-84 差几百米。栅格图层靠官方插件
//   fix-china-map-offset 纠偏（本插件标记 needFixChinaOffset）；矢量图层是自定义
//   GridLayer，拿不到那个 patch，所以内部自己调它的 wgs_gcj。
// //////////////////////////////////////////////////////////////////////

function wrapper(plugin_info) {
  // ensure plugin framework is there, even if iitc is not yet loaded
  if (typeof window.plugin !== 'function') window.plugin = function () {};

  plugin_info.buildName = 'local';
  plugin_info.dateTimeVersion = '2026-11-03-000000';
  plugin_info.pluginId = 'tencent-maps';

  // use own namespace for plugin
  window.plugin.tencentMaps = function () {};
  var self = window.plugin.tencentMaps;

  // ============ 通用配置 ============
  self.TILE_VERSION = 2232;      // confinfo.map.qq.com 当前下发的瓦片版本号
  self.SESSION_ID = Date.now();  // 会话级缓存指纹（见 _buildUrl 内说明）

  // 设为 null 则不自动切换。可选值：
  //   'vector' / 'vectorDark'                                  矢量渲染（推荐）
  //   'street' / 'streetBig' / 'dark' / 'darkBig' / 'silver'    栅格
  //   'satellite' / 'hybrid' / 'esri' / 'terrain'
  self.AUTO_SELECT = null;

  // ============ 栅格图层配置 ============
  // 高清瓦片开关（影响"标准"图层的字号观感）：
  //   'auto' —— 高分屏（devicePixelRatio>1.05）自动请求 z+1 并按半尺寸渲染：
  //             更锐利，但字号只有一半（这是"高分屏下觉得字小"的根因）
  //   true   —— 强制高清（请求数 ×4）
  //   false  —— 256px 原生，字号 1:1
  self.HD_TILES = 'auto';

  // 「大字」图层画质取向（栅格瓦片只有 256px，放大 2 倍必然损失锐度）
  self.BIG_SCALE = 2;            // 放大倍数，必须是 2 的整数次幂
  self.BIG_RENDER = 'smooth';    // 'smooth' 平滑无锯齿 | 'crisp' 边缘硬但锯齿明显
  self.BIG_SHARPEN = true;       // 叠加轻微反锐化掩模，抵消放大发虚

  // ============ 矢量图层配置 ============
  self.ENABLE_VECTOR = true;     // 关掉则只注册栅格图层
  self.VEC_PIXEL_RATIO = 2;      // 每张瓦片一个 canvas，2 已足够清晰
  self.VEC_CACHE_LIMIT = 240;    // 要素缓存条数上限
  self.VEC_UPDATE_WHEN_IDLE = true; // 拖动/缩放动画期间不取数不绘制
  self.VEC_NATIVE_MIN = 6;
  self.VEC_NATIVE_MAX = 18;

  // 低于该层级改用腾讯栅格瓦片，不自绘。
  // 原因：腾讯矢量接口在 z10 及以下的海陆数据不完整 —— 海洋是「铺满整块的底色」，
  // 靠陆地多边形（196612）覆盖出来，而那份陆地图层在低层级有整片缺失
  // （实测深圳东部 / 香港北部成片被漏掉，于是陆地显示成海）。
  // z11 起改用「真实海洋多边形 + 背景即陆地」的画法，数据是完整的。
  // 设 0 可关闭降级（低层级会重新出现海陆错乱）。
  self.VEC_RASTER_BELOW = 11;

  // 两套配色。dark 同时喂给 IITC 的暗色主题自动切换（isDark）。
  self.VEC_THEMES = {
    light: {
      background: '#f0ece5',
      land: '#f0ece5',
      block: '#e6e2db',
      green: '#cfe4c2',
      ocean: '#a3ccec',
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
        padding: 3,
      },
      shield: { size: 10, bg: '#2b7a3d', color: '#ffffff' },
      subway: { size: 10, bg: '#0f7b6c', color: '#ffffff' },
    },
    dark: {
      background: '#212730',
      land: '#212730',
      block: '#282f38',
      green: '#1e3327',
      ocean: '#0e2a40',
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
      var chooser = window.layerChooser || window.layerControl;
      if (!chooser || typeof chooser.addBaseLayer !== 'function') {
        console.warn('[tencent-maps] 未找到 layerChooser/layerControl，图层无法注册');
        return;
      }

      // 注意：图层类必须在 setup 内部定义。setup 由 IITC 调用，此时 Leaflet (L) 才保证就绪；
      // 若把 L.TileLayer.extend 放在脚本顶层，油猴注入时序可能先于 IITC 加载，
      // 导致 "L is not defined" 报错、插件静默失效。
      var created = {};

      // 矢量版先注册，让它排在图层选择器最前面（它没有栅格的字号问题，是首选底图）。
      // 单独 try：矢量模块出问题不能连累栅格图层。
      if (self.ENABLE_VECTOR) {
        try {
          var vecLayers = setupVectorLayers(chooser);
          for (var vk in vecLayers) created[vk] = vecLayers[vk];
        } catch (e) {
          console.error('[tencent-maps] 矢量图层初始化失败，仅启用栅格图层: ', e);
        }
      }

      var rasterLayers = setupRasterLayers(chooser);
      for (var rk in rasterLayers) created[rk] = rasterLayers[rk];

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

  // =====================================================================
  // 一、栅格图层
  // =====================================================================
  function setupRasterLayers(chooser) {
    // —— 瓦片渲染尺寸（scale）——
    // 实测腾讯各层级瓦片都是 256×256，所以"字看着多大"完全由 tileSize 决定：
    //   scale = 2   → tileSize 512 + zoomOffset -1：请求 z-1 瓦片、按 512px 渲染
    //                 → 字号 ×2，代价是细节降一层（"大字"图层用这个）
    //   scale = 1   → tileSize 256 + zoomOffset  0：原生，字号 1:1
    //   scale = 0.5 → tileSize 128 + zoomOffset +1：请求 z+1 瓦片、按 128px 渲染
    //                 → 更锐利但字号只有一半（高分屏默认走这个）
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

    // 栅格矢量底图（rt 服务器）
    var TencentRasterLayer = TencentTileLayer.extend({
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

    // Esri World Imagery：WGS84 对齐（无 GCJ-02 偏移，portal 对点准）、无需密钥。
    // REST 模板是 z/y/x 顺序，使用 Leaflet 默认 XYZ 纵坐标（无 TMS 变换）。
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
      return mark(new TencentRasterLayer(L.extend({ styleid: styleid }, extra)));
    }
    function grid(dir, ext, nativeMax, extra) {
      return mark(new TencentGridLayer(L.extend({ tileDir: dir, tileExt: ext, nativeMax: nativeMax }, extra)));
    }

    var satellite = grid('sateTiles', '.jpg', 18);
    // 卫星混合 = 卫星影像 + 透明路网标注层（styleid=2）
    var hybrid = L.layerGroup([
      satellite,
      mark(new TencentRasterLayer({ styleid: 2, attribution: '', nativeMax: 18 }))
    ]);
    mark(hybrid); // 组本身也打标记，便于 AUTO_SELECT 判定"这是自己的图层"

    // 每项：[key, 图层, 显示名, 是否暗色]
    // 「大字」版用 scale = BIG_SCALE（默认 2：tileSize 512 + 请求 z-1），
    // 字号是标准版的 2 倍；代价是细节降一层，画质由 BIG_RENDER / BIG_SHARPEN 调节。
    // 卫星/地形没有文字标注，放大只会更糊，所以不提供大字版。
    var layers = [
      ['street',    vec(0),                            '腾讯地图',             false],
      ['streetBig', vec(0, { scale: self.BIG_SCALE }), '腾讯地图（大字）',      false],
      ['dark',      vec(3),                            '腾讯地图（深色）',      true],
      ['darkBig',   vec(3, { scale: self.BIG_SCALE }), '腾讯地图（突出地铁图）', true],
      ['silver',    vec(4),                            '腾讯地图（浅灰）',      false],
      ['satellite', satellite,                         '腾讯卫星',             true],
      ['hybrid',    hybrid,                            '腾讯卫星（路网）',      true],
      ['esri',      new EsriImageryLayer(),            'Esri 卫星',            true],
      ['terrain',   grid('demTiles', '.png', 15),      '腾讯地形',             false]
    ];

    var created = {};
    layers.forEach(function (item) {
      created[item[0]] = item[1];
      // 旧版 layerControl.addBaseLayer 只有两个参数，多余参数会被忽略，安全
      chooser.addBaseLayer(item[1], item[2], { isDark: item[3] });
    });

    // 大字图层的平滑/锐化 CSS 只需要装一次。
    // 放在注册之后、并且单独 try：它只是锦上添花的样式，万一装不上也不能连累图层注册
    // （之前放在注册之前且没兜住，一旦这里抛错，整个 setup 被外层 catch 掉，所有图层都没了）。
    try {
      installBigTileStyle();
    } catch (e) {
      console.warn('[tencent-maps] 大字样式安装失败，已忽略: ', e);
    }
    return created;
  }

  // =====================================================================
  // 二、矢量渲染图层（canvas 自绘，字号任意放大仍清晰）
  // =====================================================================
  function setupVectorLayers(chooser) {
    // —— 瓦片坐标换算 ——
    function requestUrl(z, x, ySlippy, sub) {
      var yTms = (1 << z) - 1 - ySlippy;
      return 'https://rt' + sub + '.map.gtimg.com/vector'
        + '?z=' + z + '&x=' + x + '&y=' + yTms
        + '&styleid=0&version=' + self.TILE_VERSION;
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

    function isRoad(id) { return id >= 131000 && id < 132000; }
    function isArea(id) { return id >= 196000 && id < 197000; }
    function isSubwayLabel(id) { return id === 65944 || id === 65945; }
    function isSubwayText(t) { return /号线|地铁|轻轨/.test(t); }

    // 262xxx 里混着两类东西，靠文本形态区分：
    //   真路牌   G4 / S3300 / X001（262163/4/5/7/176 等）→ 画成色块
    //   路名字   "正" "义" "路"（262173/9、262178~262183 等）→ 逐字排列，拼回路名
    // 注意必须整串都是「字母+数字」，否则 "U479商场" 这类 POI 名会被误判成路牌。
    function isShieldText(t) { return /^[A-Za-z]{1,3}\d+$/.test(t); }
    function isRoadNameChar(f) {
      return f.text && f.layer >= 262000 && f.layer < 263000 && !isShieldText(f.text);
    }

    // 面要素分类（用已知坐标做点在多边形内判定反推，非官方）：
    //   196610 = 覆盖全图的海洋底（离岸点只命中它）
    //   196612 = 陆地（陆地点与 196610 一起命中）
    //   196618 = 面状水域（太湖/昆明湖/西湖 命中）
    //   196614 = 绿地、公园（奥森/朝阳公园 命中）
    //   196774/196775 = 线状水系（河道）
    function areaKind(id) {
      if (id === 196610) return 'ocean';
      if (id === 196612) return 'land';
      if (id === 196618) return 'water';
      if (id === 196614) return 'green';
      if (id === 196774 || id === 196775) return 'waterLine';
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
      var ocean = [], land = [], block = [], green = [], water = [], waterLine = [];
      var labels = [], shields = [], roadNames = [];

      for (var i = 0; i < feats.length; i++) {
        var f = feats[i];

        // 路名：腾讯把名字拆成单字、沿道路逐字排列，连续同图层的要素拼起来才是完整名字
        // （如 正/义/路 三个要素，位置相距约 14 单位）。这里按间距把连续的一串收成一组。
        if (isRoadNameChar(f)) {
          var run = [f];
          var refGap = -1;
          var j = i + 1;
          for (; j < feats.length; j++) {
            var g = feats[j];
            if (!isRoadNameChar(g) || g.layer !== f.layer) break;
            var prev = run[run.length - 1].pts[0];
            var cur = g.pts[0];
            var d = Math.sqrt((cur[0] - prev[0]) * (cur[0] - prev[0]) + (cur[1] - prev[1]) * (cur[1] - prev[1]));
            if (refGap < 0) refGap = d;
            else if (d > refGap * 1.9) break;   // 间距突变，说明是另一条路
            run.push(g);
          }
          if (run.length > 1) {
            var name = '';
            for (var rc = 0; rc < run.length; rc++) name += run[rc].text;
            roadNames.push({ chars: run, text: name });
            i = j - 1;
            continue;
          }
          // 落单的单字当普通注记处理
        }

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
            if (kind === 'ocean') ocean.push(f);
            else if (kind === 'water') water.push(f);
            else if (kind === 'green') green.push(f);
            else if (kind === 'land') land.push(f);
            else block.push(f);
          }
          continue;
        }
        if (f.text) {
          if (isShieldText(f.text)) shields.push(f);
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

      // 海洋必须按多边形填，绝不能「只要出现就整片铺满」。
      // 196610 的形态随层级变化：
      //   z≤10  覆盖整瓦片的矩形（-15..271），铺满 = 按多边形填，两者等价；
      //   z≥11  是真实的局部海洋多边形（实测香港瓦片只占 9%~64%），
      //         若整片铺满，凡是含海的瓦片都会变成全海 —— 沿海城市成片陆地消失，
      //         放大到出现「不含海的瓦片」才恢复正常，正是「放大后才加载出陆地」的原因。
      fillPolys(ocean, T.ocean);
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
      var L2 = T.label;
      var fs = L2.size * k;
      ctx.font = fs + 'px ' + L2.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // 碰撞检测用矩形列表；比"最小间距"靠谱：
      // 短地名可以紧挨着排，长地名自动让开，不会出现半截压在别人身上。
      var boxes = [];
      function hits(x, y, w, h) {
        for (var q = 0; q < boxes.length; q++) {
          var b = boxes[q];
          if (x - w / 2 < b.x + b.w / 2 + L2.padding &&
              x + w / 2 > b.x - b.w / 2 - L2.padding &&
              y - h / 2 < b.y + b.h / 2 + L2.padding &&
              y + h / 2 > b.y - b.h / 2 - L2.padding) return true;
        }
        return false;
      }

      var textH = fs * 1.1;

      // —— 路名 ——
      // 每个字按它自己的坐标画（腾讯就是这么沿道路排的），所以不需要旋转；
      // 但碰撞检测要按整组的包围盒算，否则会出现「正义」画了「路」被挤掉。
      var nameBudget = 20;
      for (var rn = 0; rn < roadNames.length && nameBudget > 0; rn++) {
        var grp = roadNames[rn];
        var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (var ci = 0; ci < grp.chars.length; ci++) {
          var cpt = grp.chars[ci].pts[0];
          var cx0 = cpt[0] * k, cy0 = cpt[1] * k;
          if (cx0 < minX) minX = cx0;
          if (cx0 > maxX) maxX = cx0;
          if (cy0 < minY) minY = cy0;
          if (cy0 > maxY) maxY = cy0;
        }
        var gcx = (minX + maxX) / 2, gcy = (minY + maxY) / 2;
        var gw = (maxX - minX) + fs, gh = (maxY - minY) + textH;
        // 整组都在瓦片外就不画
        if (maxX < -fs || minX > size + fs || maxY < -textH || minY > size + textH) continue;
        if (hits(gcx, gcy, gw, gh)) continue;
        boxes.push({ x: gcx, y: gcy, w: gw, h: gh });
        nameBudget--;

        for (var ci2 = 0; ci2 < grp.chars.length; ci2++) {
          var cch = grp.chars[ci2];
          var cpx2 = cch.pts[0][0] * k;
          var cpy2 = cch.pts[0][1] * k;
          if (cpx2 < -fs || cpx2 > size + fs || cpy2 < -textH || cpy2 > size + textH) continue;
          ctx.lineWidth = L2.haloWidth * k;
          ctx.strokeStyle = L2.halo;
          ctx.strokeText(cch.text, cpx2, cpy2);
          ctx.fillStyle = L2.color;
          ctx.fillText(cch.text, cpx2, cpy2);
        }
      }

      // 短文本优先（通常是最重要的地名），长 POI 名靠后
      labels.sort(function (a, b) { return a.text.length - b.text.length; });

      var budget = z >= 13 ? 70 : 30;
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
          ctx.font = 'bold ' + SB.size * k + 'px ' + L2.font;
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
          ctx.font = fs + 'px ' + L2.font;
        } else {
          ctx.lineWidth = L2.haloWidth * k;
          ctx.strokeStyle = L2.halo;
          ctx.strokeText(txt, px, py);
          ctx.fillStyle = L2.color;
          ctx.fillText(txt, px, py);
        }
      }

      // —— 路牌 ——
      var S = T.shield;
      ctx.font = 'bold ' + S.size * k + 'px ' + L2.font;
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
        console.error('[tencent-maps] vector draw failed', e);
      }
    }

    // —— 要素缓存（带条数上限，按插入顺序淘汰）——
    var cache = {};
    var cacheKeys = [];
    function cachePut(key, val) {
      if (!cache[key]) cacheKeys.push(key);
      cache[key] = val;
      while (cacheKeys.length > self.VEC_CACHE_LIMIT) {
        delete cache[cacheKeys.shift()];
      }
    }

    var CanvasVectorLayer = L.GridLayer.extend({
      options: {
        tileSize: 256,
        minZoom: 3,
        maxZoom: (typeof map !== 'undefined' && map.options && map.options.maxZoom) || 21,
        minNativeZoom: self.VEC_NATIVE_MIN,
        maxNativeZoom: self.VEC_NATIVE_MAX,
        needFixChinaOffset: true,
        attribution: '© 腾讯地图',
        theme: 'light',
        updateWhenIdle: self.VEC_UPDATE_WHEN_IDLE,
        updateInterval: 150,
        keepBuffer: 1,
      },

      createTile: function (coords, done) {
        // 低层级：矢量数据的海陆不可靠（见 VEC_RASTER_BELOW 注释），直接用栅格瓦片。
        // 返回 <img> 而非 canvas —— Leaflet 的 GridLayer 接受任意元素，
        // _initTile 会自己补上 leaflet-tile 类和尺寸样式。
        if (self.VEC_RASTER_BELOW > 0 && coords.z < self.VEC_RASTER_BELOW) {
          return this._createRasterTile(coords, done);
        }

        var size = this.getTileSize().x;
        var dpr = Math.min(window.devicePixelRatio || 1, self.VEC_PIXEL_RATIO);
        var themeName = this.options.theme;
        var T = self.VEC_THEMES[themeName] || self.VEC_THEMES.light;

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

      // 低层级降级用的栅格瓦片。styleid 跟随主题：0 标准 / 3 深色（PNG 无损）。
      _createRasterTile: function (coords, done) {
        var z = coords.z;
        var size = this.getTileSize().x;
        var styleid = this.options.theme === 'dark' ? 3 : 0;
        var sub = (coords.x + coords.y) % 4;
        var yTms = (1 << z) - 1 - coords.y; // 腾讯栅格同样是 TMS 纵坐标
        var img = document.createElement('img');
        img.width = size;
        img.height = size;
        img.alt = '';
        img.draggable = false;
        img.onload = function () { done(null, img); };
        img.onerror = function () { done(new Error('raster tile failed'), img); };
        img.src = 'https://rt' + sub + '.map.gtimg.com/tile'
          + '?z=' + z + '&x=' + coords.x + '&y=' + yTms
          + '&styleid=' + styleid + '&version=' + self.TILE_VERSION;
        return img;
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
        // 注意：三个参数一个都不能少。父类实现是
        //   var scale = map.getZoomScale(zoom, level.zoom),
        //       translate = level.origin.multiplyBy(scale)...
        // 合并 0.6.0 时这里漏传了 level，导致 level 位置收到的是 center（LatLng），
        // level.origin 为 undefined → multiplyBy 抛 TypeError → addTo 中断 → 整层空白。
        return L.GridLayer.prototype._setZoomTransform.call(this, level, this._fixCenter(center), zoom);
      },
    });

    var lightLayer = new CanvasVectorLayer({ theme: 'light' });
    lightLayer._tencentMaps = true;
    var darkLayer = new CanvasVectorLayer({ theme: 'dark' });
    darkLayer._tencentMaps = true;

    // 矢量版放在最前面：它没有栅格版的字号问题，是首选底图
    chooser.addBaseLayer(lightLayer, '腾讯地图（矢量）', { isDark: false });
    chooser.addBaseLayer(darkLayer, '腾讯地图（矢量·深色）', { isDark: true });

    // 调试入口：控制台可改 VEC_THEMES 后调 redraw 重绘
    self.redrawVector = function () {
      cache = {};
      cacheKeys = [];
      lightLayer.redraw();
      darkLayer.redraw();
    };

    return { vector: lightLayer, vectorDark: darkLayer };
  }

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
