# IITC 腾讯地图底图插件

为 [IITC-CE](https://github.com/IITC-CE/ingress-intel-total-conversion)（Ingress Intel Total Conversion）
添加腾讯地图与 Esri 卫星底图的用户脚本插件。

一个插件里同时提供**两套渲染方式**：

- **矢量渲染**（推荐）：拉腾讯的 JSON 矢量瓦片，用 canvas 自己画。字号由插件决定，
  放大后依然清晰，不受腾讯 256px 栅格瓦片的限制。
- **栅格瓦片**：直接贴腾讯的现成瓦片，加载快、观感与腾讯原版一致，但字号大小固定。

**IITC plugin: Tencent Maps base layers** — adds Tencent Maps as base layers, both as a
canvas vector renderer and as regular raster tiles, plus Esri World Imagery.

## 安装

1. 先安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开安装链接：

   <https://raw.githubusercontent.com/szres/iitc-plugin-tencent-maps/main/iitc-plugin-tencent-maps.user.js>

3. 打开 <https://intel.ingress.com/>，在右上角图层选择器里即可看到「腾讯地图」系列底图

## 提供的图层

| 图层 | 渲染方式 | 说明 | 原生最高层级 |
| --- | --- | --- | --- |
| **腾讯地图（矢量）** | canvas 矢量 | 推荐。道路分级、水域、绿地、注记、路牌，字号任意放大仍清晰 | z18 |
| **腾讯地图（矢量·深色）** | canvas 矢量 | 同上，深色配色，配合 IITC 暗色主题 | z18 |
| 腾讯地图 | 栅格 | 标准底图（styleid=0） | z18 |
| 腾讯地图（大字） | 栅格 | 标准底图，**字号 ×2** | z18 |
| 腾讯地图（深色） | 栅格 | 深色底图（styleid=3） | z18 |
| 腾讯地图（突出地铁图） | 栅格 | 深色底图 + **字号 ×2**，轨道线路更醒目 | z18 |
| 腾讯地图（浅灰） | 栅格 | 浅灰底图（styleid=4） | z18 |
| 腾讯卫星 | 栅格 | 卫星影像（sateTiles） | z18 |
| 腾讯卫星（路网） | 栅格 | 卫星影像 + 透明路网标注（styleid=2 叠加） | z18 |
| 腾讯地形 | 栅格 | 地形图（demTiles） | z15 |
| Esri 卫星 | 栅格 | Esri World Imagery，WGS84 对齐、无需密钥 | z19 |

## 矢量渲染版说明

数据源是腾讯的 JSON 矢量瓦片（非标准 MVT）：

```
https://rt{s}.map.gtimg.com/vector?z={z}&x={x}&y={y}&styleid=0&version={ver}
```

返回 `{"ret":0,"features":[[layerId,[x0,y0,dx1,dy1,...],"文字"]]}`，坐标是 0..256 的瓦片内坐标，
几何为增量编码（首点绝对，其后每两点为相对增量）。

图层语义是**逆向推断**的（用已知坐标做点在多边形内判定 + 逐图层渲染比对），非官方文档：

| 图层 id | 含义 |
| --- | --- |
| `131xxx` | 道路（id 与缩放级别绑定，按几何长度自动分三级） |
| `196610` / `196612` | 海洋底 / 陆地 |
| `196618` / `196614` | 面状水域 / 绿地公园 |
| `196774` / `196775` | 线状水系（河道） |
| `196622` 等 | 底层地块 |
| `655xx` / `666xx` | POI 注记 |
| `65944` / `65945` | 地铁线路标注（仅文字） |
| `262xxx` | 真路牌（G4/S3300/X001）与路名字（单汉字逐字排列） |

**已知限制**：地铁只有标注文字，线路几何不在该接口里；建筑轮廓没有独立图层，统一按地块处理。

## 觉得字太小？用「大字」图层

腾讯栅格瓦片各层级都是 256×256，所以**字号观感完全由渲染尺寸（tileSize）决定**：

| 渲染方式 | tileSize | 请求层级 | 字号 | 清晰度 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 高清 | 128px | z+1 | **×0.5** | 最锐利 | 高分屏默认 |
| 原生 | 256px | z | ×1 | 正常 | `HD_TILES = false` |
| 大字 | 512px | z-1 | **×2** | 略糊 | 「大字」图层 |

注意高清模式是「把下一层级的瓦片缩小一半来显示」，所以瓦片更锐利了，但**字会变成一半大**。
在 Windows 125%/150% 缩放或 Retina 屏上觉得字小，这是根因。三种解法：

1. 直接用 **「腾讯地图（矢量）」** —— 字号由插件绘制，放大也不糊（推荐）
2. 选 **「腾讯地图（大字）」** —— 栅格版，字号 2 倍，不受 `HD_TILES` 影响
3. 或把脚本顶部的 `self.HD_TILES` 改成 `false`，恢复 256px 原生字号

### 大字版为什么必然会糊一点

实测腾讯**只提供 256×256 瓦片**：`scale` / `scl` / `size` / `dpi` / `hd` / `pixelRatio` /
`fmt=png` / `@2x` 路径等 15 种写法全部被服务器忽略，返回的都是同一张图（字节数完全一致）。
所以「视野不变 + 字大 2 倍」只能靠把 256px 源放大 2 倍，锐度有物理上限。

插件做了三件事尽量补救：

| 措施 | 作用 |
| --- | --- |
| `image-rendering: auto` | 覆盖 Safari 下 IITC 设的 `-webkit-optimize-contrast`（最近邻放大，锯齿主因） |
| SVG 反锐化掩模 | 3×3 卷积（中心 1.6 / 四邻 −0.15）抵消双线性放大的发虚，字边缘更实 |
| 深色版用 PNG 源 | `styleid=3` 返回的是 **PNG 无损**，比 JPEG 的 `styleid=0` 更经得起放大 |

可调开关（脚本顶部）：

```js
self.BIG_SCALE = 2;            // 放大倍数，必须是 2 的幂（0.5/1/2/4）
self.BIG_RENDER = 'smooth';    // 'smooth' 平滑无锯齿 | 'crisp' 边缘硬但锯齿明显
self.BIG_SHARPEN = true;       // 反锐化掩模，嫌耗性能可关
```

如果更看重锐利度而不是字号，把 `HD_TILES` 设为 `false` 用标准图层会更清楚——
在 256px 源的限制下，「字大」和「锐利」只能二选一。

## 关于坐标偏移（重要）

腾讯地图瓦片使用 **GCJ-02（火星坐标系）**，与 Ingress 的 WGS-84 存在约几百米偏移。
本插件所有腾讯图层均已标记 `needFixChinaOffset: true`，请**同时安装 IITC-CE 官方插件
`fix-china-map-offset`**，由它统一做纠偏：

- 仓库：<https://github.com/IITC-CE/ingress-intel-total-conversion>
- 插件名：`Fix maps offsets in China`

Esri 卫星图层为 WGS-84 对齐，已标记 `needFixChinaOffset: false`，不会被纠偏，对点更准。

## 高清瓦片

插件默认开启高清瓦片（`HD_TILES = 'auto'`）：在高分屏（`devicePixelRatio > 1.05`，
即 Windows 125%/150% 缩放、Retina 屏等）上自动请求 z+1 级瓦片并按半尺寸渲染，
瓦片请求数约为 4 倍，边缘更锐利——但字号只有一半（见上一节）。

想改行为，编辑脚本顶部：

```js
// 矢量渲染
self.ENABLE_VECTOR = true;      // false = 只注册栅格图层
self.VEC_PIXEL_RATIO = 2;       // canvas 分辨率倍数，降低可省性能
self.VEC_CACHE_LIMIT = 240;     // 要素缓存条数上限
self.VEC_UPDATE_WHEN_IDLE = true; // 拖动/缩放动画期间不取数不绘制

// 栅格
self.HD_TILES = 'auto';  // 'auto' | true | false（false = 原生 256px，字号 1:1）
self.BIG_SCALE = 2;      // 大字图层的放大倍数

// 自动选中（null = 不自动切换）
self.AUTO_SELECT = null; // 'vector' | 'vectorDark'
                         // | 'street' | 'streetBig' | 'dark' | 'darkBig' | 'silver'
                         // | 'satellite' | 'hybrid' | 'esri' | 'terrain'
self.TILE_VERSION = 2232;
```

## 技术说明

矢量瓦片接口（2026-09 依据 map.qq.com 前端代码与实测确认）：

```
https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={y}&styleid={style}&version={ver}
```

- 腾讯使用 **TMS 纵坐标**（原点在左下角）：`y = 2^z - y_slippy - 1`
- 子域选择：`s = (x + y) % 4`
- `styleid`：`0` 标准、`2` 路网标注（透明底）、`3` 深色、`4` 浅灰、`8` 淡雅、`9` 白灰
- 各层级瓦片均为 **256×256**，所以放大/缩小渲染不需要额外的 `@2x` 接口

卫星 / 地形为 16×16 分目录结构：

```
https://p{s}.map.gtimg.com/sateTiles/{z}/{x>>4}/{y>>4}/{x}_{y}.jpg
https://p{s}.map.gtimg.com/demTiles/{z}/{x>>4}/{y>>4}/{x}_{y}.png
```

渲染尺寸由 `scale` 统一推导，三个参数必须联动，否则会请求到不存在的层级：

```js
URL z = clamp(地图缩放, minNativeZoom, maxNativeZoom) + zoomOffset
maxNativeZoom = nativeMax - zoomOffset
minNativeZoom = nativeMin - zoomOffset
```

图层只需声明真实的 `nativeMin` / `nativeMax`，其余自动算。

## 已知限制

- 直连腾讯地图公开瓦片接口，**未使用开发者密钥**。接口若变更，插件可能失效。
- 腾讯卫星 z19 起返回「此区域无卫星图」占位图，地形 z15 以上无原生数据，均由 Leaflet 放大补齐。
- 非标准样式（styleid≠0）的瓦片 URL 带会话级缓存指纹（`_t` 参数），用于规避 CDN 偶发返回
  错误样式并被长缓存的问题；代价是每个会话会产生一批新的缓存条目。

## 免责声明

本项目仅用于个人学习与 Ingress 社区工具集成。地图数据版权归腾讯地图 / Esri 所有，
使用前请自行确认符合相应服务条款。作者不对因使用本插件产生的任何问题负责。

## License

[MIT](LICENSE) © 2026 tabris@szres
