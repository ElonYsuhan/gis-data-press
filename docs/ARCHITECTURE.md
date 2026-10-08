# GeoPress 开发与维护

## 模块职责

- `src/app/`：应用级 Provider、工作空间状态与页面协调。
- `src/pages/`：服务发布、数据处理、设置及工作空间对话框。
- `src/features/`：资源下载、任务列表、预览与分辨率换算。
- `src/components/`：通用界面组件；`AppDialog` 封装 Naive UI 的焦点与弹窗生命周期。
- `src/services/`：浏览器 / Electron 共用的管理 API 客户端。
- `src/styles/`：按职责划分的布局样式，保留导入顺序；Naive UI 负责控件样式。
- `electron/`：桌面窗口、IPC 桥接、浏览器入口、后台连接；不承载 GIS 业务。
- `server/`：独立后台服务、目录发布、下载和任务协调。
- `server/domain/`：不依赖 Electron 的参数校验。
- `server/infrastructure/`：可执行文件查找和 JSON worker 进程通信。
- `shared/`：前后端共享的类型与协议。
- `python/gis_processing/`：元信息、分块预处理、引擎执行、成果提交。
- `python/worker.py`：标准输入 / 输出 JSON 协议入口。

## 开发规范

Vue 使用 Composition API、`script setup` 和 TypeScript。新控件使用 Naive UI，按组件显式导入，主题和中文语言在 `AppProviders` 中设置。页面不要直接访问文件系统或启动进程；这些操作通过管理 API 调用后台。

Prettier 统一两空格、单引号、不加分号以及多行模板属性。ESLint 检查 Vue、TypeScript 和 Node 脚本；条件分支使用大括号。Python 使用 Ruff 四空格格式与导入检查。不要将多条语句或复杂业务分支压缩在同一行。

加工流程必须保留输入、空输出目录检查、取消子进程、临时成果隔离和最终提交校验。格式重构不改变数据路径或用户状态格式。既有状态仍位于 `~/Library/Application Support/gis-data-press`。

## 本地检查

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements-dev.txt
npm run format
npm run python:format
npm run check
npm run python:check
npm run build
```

修改 Python 加工模块后，打包前执行 `.venv/bin/python scripts/bundle-worker.py` 更新捆绑引擎。`npm run package` 构建桌面目录包。CI 校验格式、Lint、类型、测试和构建，不依赖用户数据。

## 后续单文件成果

TIFF 融合、瓦片生成及 SQLite 写入应作为后台加工步骤实现，格式协议进入 `shared`，数据库访问进入 `server/infrastructure`。页面只配置任务、观察进度和发起取消。此轮重构保留当前目录输出；单文件加工是后续功能，不混入格式迁移。

## 单文件栅格加工流程

新建影像、地形任务默认 `outputFormat: package`；旧任务缺省值仍走目录模式，OSGB 保持 3D Tiles 目录。

- `shared/contracts.ts`：`inputs` 有序输入、`fusionPolicy`、逐文件 `heightOffsets`、成果格式；`input` 保留兼容和首个输入检查。
- `python/gis_processing/fusion.py`：统一采样网格、按块读取 WarpedVRT，后面的有效值覆盖前面的有效值。`precision` 将粗像元排在前面，`order` 使用显式输入顺序。高程校正为用户确认的米制加法，不代替正高到椭球高的转换。
- `<成果文件>.sources/master.tif` 是融合后的 COG；`master.vrt` 引用它；`sources.json` 记录数据顺序、空间参考、无效值及规则。保留原始 TIFF，新增数据可与此 COG 再融合输出新版本。
- `packages.py`：影像通过有限批次并行计算、单连接批量写入 SQLite，不落中间 PNG。影像存储行号符合 MBTiles TMS，HTTP 接口转换回 XYZ。CTB 地形保留其 geographic/TMS 行号和 gzip 字节。
- `terrain.py`：CTB 直接读取母数据。地形引擎目前仍输出内部临时瓦片目录；打包完成后清理该目录。
- `package_pipeline.py`：指纹含输入路径/大小/修改时间、参数、处理版本和引擎配置。相同指纹重试复用已完成的母数据；影像按已提交的瓦片恢复，地形按完整切片阶段恢复，打包按已有记录恢复。输入或参数改变必须使用新成果文件名。所有验证通过后原子提交新文件，不覆盖已有成果。
- `server/tile-packages.ts`：最多缓存 8 个只读 SQLite 连接，文件被替换时重新打开。Nginx 代理到本地包读取服务，客户端仍用标准 `layer.json` 或 XYZ URL。旧目录发布继续使用 Nginx alias。

### 地形包 v1

扩展名 `.terrain.sqlite`。容器是 GeoPress 自定义 SQLite，内部瓦片是 Cesium 标准 Quantized Mesh，不能宣称其为标准 MBTiles 地形。

`metadata(name TEXT PRIMARY KEY, value TEXT)` 保存 `format=quantized-mesh-1.0`、`geopress:container=quantized-mesh-sqlite-v1`、`layer.json`、`bounds`、`minzoom`、`maxzoom`、`geopress:manifest` 和 `geopress:complete`。

`tiles(zoom_level, tile_column, tile_row, tile_data)` 使用坐标联合主键，`tile_data` 原样保存 CTB 内容。影像包使用同一 MBTiles 标准表结构，额外恢复表 `completed` 和 `geopress:*` 元数据不会改变标准读取方式。

### 当前质量和恢复边界

只支持用户已确认的米制 WGS84 椭球高，未集成大地水准面模型的自动垂直基准转换。按像元间距排序只是默认启发式，需要用户按测量质量选择手动顺序；没有自动系统高差估计或羽化接缝。统一网格保证同一个母数据的边界采样来源一致。

目前新增数据输出新版本，仍重新生成完整融合母数据和成果包；尚未实现仅重建覆盖范围、边界邻域和上层瓦片的增量算法。母数据阶段中断需要重做融合；CTB 切片中断需重跑该阶段。影像切片恢复以 SQLite 已提交的批次为准。不要把“恢复阶段”与“任意进度无损续跑”混淆。
