# IITC 腾讯地图底图插件

为 [IITC-CE](https://github.com/IITC-CE/ingress-intel-total-conversion)（Ingress Intel Total Conversion）
添加腾讯地图与 Esri 卫星底图的用户脚本插件。

**IITC plugin: Tencent Maps base layers** — adds Tencent Maps (street / dark / silver / satellite /
satellite+roads / terrain) and Esri World Imagery as base layers, using Tencent's current
`rt*.map.gtimg.com/tile` vector tile API.

## 安装

1. 先安装用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开安装链接：

   <https://raw.githubusercontent.com/szres/iitc-plugin-tencent-maps/main/iitc-plugin-tencent-maps.user.js>

3. 打开 <https://intel.ingress.com/>，在右上角图层选择器里即可看到「腾讯地图」系列底图

## 提供的图层

| 图层 | 说明 | 瓦片尺寸 | 原生最高层级 |
| --- | --- | --- | --- |
| 腾讯地图 | 标准矢量底图（styleid=0） | 跟随屏幕 | z18 |
| 腾讯地图（大字） | 标准底图，**字号 ×2** | 512px | z18 |
| 腾讯地图（深色） | 深色底图（styleid=3），配合 IITC 暗色主题 | 跟随屏幕 | z18 |
| 腾讯地图（突出地铁图） | 深色底图（styleid=3）+ **字号 ×2**，轨道线路更醒目 | 512px | z18 |
| 腾讯地图（浅灰） | 浅灰底图（styleid=4） | 跟随屏幕 | z18 |
| 腾讯卫星 | 卫星影像（sateTiles） | 跟随屏幕 | z18 |
| 腾讯卫星（路网） | 卫星影像 + 透明路网标注（styleid=2 叠加） | 跟随屏幕 | z18 |
| 腾讯地形 | 地形图（demTiles） | 跟随屏幕 | z15 |
| Esri 卫星 | Esri World Imagery，WGS84 对齐、无需密钥 | 跟随屏幕 | z19 |

## 觉得字太小？用「大字」图层

腾讯各层级瓦片都是 256×256，所以**字号观感完全由渲染尺寸（tileSize）决定**：

| 渲染方式 | tileSize | 请求层级 | 字号 | 清晰度 | 用途 |
| --- | --- | --- | --- | --- | --- |
| 高清 | 128px | z+1 | **×0.5** | 最锐利 | 高分屏默认 |
| 原生 | 256px | z | ×1 | 正常 | `HD_TILES = false` |
| 大字 | 512px | z-1 | **×2** | 略糊 | 「大字」图层 |

注意高清模式是「把下一层级的瓦片缩小一半来显示」，所以瓦片更锐利了，但**字会变成一半大**。
在 Windows 125%/150% 缩放或 Retina 屏上觉得字小，这是根因。两种解法：

1. 直接选图层里的 **「腾讯地图（大字）」** —— 字号是标准版 2 倍，不受 `HD_TILES` 影响
2. 或把脚本顶部的 `self.HD_TILES` 改成 `false`，恢复 256px 原生字号

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
self.HD_TILES = 'auto';  // 'auto' | true | false（false = 原生 256px，字号 1:1）
self.AUTO_SELECT = null; // 'street' | 'streetBig' | 'dark' | 'darkBig' | 'silver'
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
