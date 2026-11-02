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

| 图层 | 说明 | 原生最高层级 |
| --- | --- | --- |
| 腾讯地图 | 标准矢量底图（styleid=0） | z18 |
| 腾讯地图（深色） | 深色底图（styleid=3），配合 IITC 暗色主题 | z18 |
| 腾讯地图（浅灰） | 浅灰底图（styleid=4） | z18 |
| 腾讯卫星 | 卫星影像（sateTiles） | z18 |
| 腾讯卫星（路网） | 卫星影像 + 透明路网标注（styleid=2 叠加） | z18 |
| 腾讯地形 | 地形图（demTiles） | z15 |
| Esri 卫星 | Esri World Imagery，WGS84 对齐、无需密钥 | z19 |

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
文字清晰度明显提升，代价是瓦片请求数约为 4 倍。

想改行为，编辑脚本顶部：

```js
self.HD_TILES = 'auto';  // 'auto' | true | false
self.AUTO_SELECT = null; // 'street' | 'dark' | 'silver' | 'satellite' | 'hybrid' | 'esri' | 'terrain'
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

卫星 / 地形为 16×16 分目录结构：

```
https://p{s}.map.gtimg.com/sateTiles/{z}/{x>>4}/{y>>4}/{x}_{y}.jpg
https://p{s}.map.gtimg.com/demTiles/{z}/{x>>4}/{y>>4}/{x}_{y}.png
```

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
