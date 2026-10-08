# GeoPress 0.1

GeoPress 是 Electron + TypeScript + Python 桌面 GIS 加工与静态目录发布工具。应用更名后继续使用原有用户数据目录，沿用已保存的设置、资源索引和发布后台状态。

数据始终位于用户指定的目录。软件仅保存映射配置、最多 200 项资源索引样本、任务参数和日志，不复制原始数据，不建立内部数据仓库。

## 已实现

- 图片 / 图标、glTF / GLB、XYZ 影像、Quantized Mesh 地形、显式 3D Tiles 目录登记与发布。
- 独立 Nginx 实例：启停、配置检查、平滑重载、CORS、Range、MIME、访问日志。
- 目录变化监听 + 30 秒周期检查；没有有效资源或入口无效时将映射更新为 HTTP 503。文件丢失时可能先返回 404，监测和重载不是瞬时操作。
- TIFF / VRT 元信息读取；单波段、RGB / RGBA TIFF 转 XYZ PNG，支持窗口读取和可选百分位拉伸。
- DEM → Quantized Mesh：支持本地 CTB Mesh 分支，或已安装的 Docker CTB 镜像；需要 GDAL 的 gdalwarp，且由用户确认椭球高。
- 切片层级支持手动填写，或按源数据水平分辨率换算（米、厘米、千米）。影像采用 256 像素 XYZ 瓦片并按参考纬度修正；地形按 CTB 采样网格估算。自动模式向上取整层级，最多 22 级；更高层级不会增加源数据细节。
- OSGB → 3D Tiles：接入 fanvanzh/3dtiles 命令行参数；需配置兼容本机的外部引擎。选择包含 Data 与 metadata.xml 的整个目录；无 metadata.xml 时填写 WGS84 定位原点。
- 顺序任务队列、实时日志、取消、输出目录防覆盖、加工完成后登记发布。
- Cesium 本地服务预览、图片预览、接入代码复制。
- 启动应用即启动打包后的前端管理服务；关闭窗口退出管理界面并停止前端服务，独立发布后台、Nginx 和加工任务继续运行。

## 开发运行

```sh
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt
npm run dev
```

在 macOS 上，基础外部引擎可安装为：

```sh
brew install nginx gdal
```

Windows 请在「引擎与设置」中配置 Nginx、带 rasterio/numpy 的 Python，以及 GDAL 的 gdal2tiles 可执行入口。当前验证平台为 macOS ARM64；Windows/Linux 安装包和平台差异尚未验收。

如使用 Docker 地形引擎，需要 Docker Desktop / Docker Engine 正在运行，并预先获取：

```sh
docker pull ghcr.io/tum-gis/ctb-quantized-mesh:alpine
```

本地 CTB 未找到时自动检查该镜像；也可把地形引擎设置为 `docker://ctb`。镜像缺失或 Docker 未运行时，该引擎显示未就绪。转换任务不会自行下载镜像。

## 构建与应用打包

```sh
npm run build
npm start
```

macOS 可将本机 Nginx 和 Python worker 打包：

```sh
python3 scripts/bundle-nginx.py
.venv/bin/python -m pip install pyinstaller
.venv/bin/pyinstaller --noconfirm --clean --onedir --name gis-worker --distpath resources/engines/python --workpath .test-artifacts/pyinstaller --specpath .test-artifacts --collect-all rasterio python/worker.py
npm run package
```

生成 `release/mac-arm64/GeoPress.app`。打包的 worker 包含 Python、Rasterio 与 NumPy，不需要另装 Python；影像切片仍需要外部 GDAL。地形和 OSGB 引擎按设置使用外部工具。构建默认不执行 Apple 公证，其他机器的安装分发需后续签名验收。

## 发布目录

```text
imagery/                   terrain/                 city/                 icons/
  0/0/0.png                  layer.json               tileset.json           marker.svg
  1/...                      0/0/0.terrain             ...                    ...
```

- XYZ 影像默认 EPSG:3857、北向起算 y；已有 TMS 目录不能直接当 XYZ 发布。软件生成的影像附带 gis-manifest.json，记录范围与层级。
- 地形要求 layer.json 声明 quantized-mesh-1.0、tiles、available；会检查最多 20 个瓦片的压缩编码，混合压缩数据需要预先统一。
- 3D Tiles 校验入口和显式层级的本地资源引用，不接受目录外引用、符号链接或 implicit tiling；第一版不做完整格式标准认证。
- 图片/模型索引按扩展名识别；索引不等于图像解码或 glTF 规范验证，预览能进一步发现资源错误。
- 无效目录仍保留映射记录，资源恢复后自动恢复有效状态。手动停用的映射不会自动启用。
- 删除映射只删除配置，磁盘文件保留。原始文件与输出目录不得重叠，输出不得覆盖非空目录。
- 发布根目录使用真实路径，默认跳过隐藏文件和符号链接，关闭目录列表。

## 内网访问

在设置中选择「局域网 · 0.0.0.0」，端口默认 8088。其他机器使用发布机器的内网 IP，例如 `http://192.168.1.20:8088/terrain/china/`。

只暴露资源 HTTP 端口；桌面管理使用 Electron IPC，不开启远程管理 API。服务采用明文 HTTP，面向可信内网。机器需允许对应端口访问。

默认客户端缓存为 0 秒，需要重新验证。允许原地修改资源时保持这个设置；目录监测不能撤回浏览器已缓存的内容。没有额外磁盘代理缓存。

## 检查

```sh
npm test
npm run build
```

核心测试实际启动隔离 Nginx，验证 Range、CORS、gzip 地形 / JSON 响应头、100 个并发资源请求、失效 / 恢复以及目录配置行为。Python 测试验证空间范围、NoData 和防覆盖行为。

100 个本机 HTTP 请求测试不能等同于 100 人地图流畅性保证。真实内网验收需使用目标数据、客户端和服务器评估网络、磁盘吞吐及浏览器帧率。

任务当前不支持应用重启后自动续跑；运行和排队任务在重启时标为中断，需重新配置提交。取消任务会终止进程组；极端强制终止可能在输出父目录遗留 `.gis-work-*` 临时目录，应确认无运行任务后清理。

## 源码

- `server/manager.ts`：配置、索引监测、任务调度、引擎检测。
- `server/nginx.ts`：静态映射配置与 Nginx 生命周期。
- `server/catalog.ts`：资源索引与有效性检查。
- `python/worker.py`：JSON 协议入口；加工实现位于 `python/gis_processing/`。
- `src/pages/` / `src/features/`：Naive UI 页面、业务组件与 Cesium 预览。
- 开发规范、模块边界和检查命令见 [维护文档](docs/ARCHITECTURE.md)。

原型已备份至工程同级的 `gis-data-press-backup-20261006-223447`。

第三方 Nginx 许可保留于 `resources/engines/NGINX-LICENSE.txt`。Nginx 为独立第三方引擎；本项目尚未修改其核心源码。

### 分平台安装包与浏览器管理

安装包按操作系统和 CPU 架构分别生成：Windows x64（NSIS）、macOS arm64/x64（DMG）、Linux x64/arm64（AppImage）。用户安装对应版本即可，运行时自动使用内置 Nginx 和 Python worker，无须选择系统；设置中的引擎路径允许覆盖默认值。

每个发行包必须在目标系统和架构的原生环境构建。先准备 `resources/engines/nginx/nginx`（Windows 为 nginx.exe）及其运行库，以及 `resources/engines/python/gis-worker/` 的 PyInstaller onedir 产物；在 `resources/engines/platform.json` 记录 platform（darwin/win32/linux）和 arch（arm64/x64）。打包钩子会拒绝平台不匹配或缺少引擎的包。分别执行 `npm run dist:mac`、`npm run dist:win`、`npm run dist:linux`。GDAL、CTB 和 OSGB 转换器仍按已有说明配置，不属于已验证的全平台内置组件。目前实际验证的是 macOS arm64；其他平台须在原生机器完成构建与验收。

品牌旁按钮在默认浏览器打开同一管理界面。管理服务使用随机端口，仅监听 127.0.0.1；GIS 数据服务的内网监听设置不影响它。链接带临时访问凭据，重启软件后失效。浏览器的目录选择与打开文件操作调用桌面端，因此桌面程序必须保持运行。管理界面无需启动 Nginx 即可使用。

Logo 源文件为 `public/logo.svg`，桌面各平台图标在 `resources/icons/`。修改源文件后执行 `npm run icons` 重新生成（需要 Chrome；ICNS 生成需要 macOS 的 iconutil）。发行包使用预生成图标，正常打包无须运行该命令。

预览默认底图已改为在线 OpenStreetMap 标准道路地图（无需 Key），网址为 `https://tile.openstreetmap.org/{z}/{x}/{y}.png`，地图显示 OpenStreetMap 署名。它需要网络连接；遵循官方 HTTP 缓存策略，只用于正常交互预览，不提供批量下载或离线缓存功能。公开瓦片服务不保证可用性，不应作为内网百人服务的性能保证。政策：https://operations.osmfoundation.org/policies/tiles/

### 管理界面与发布后台的生命周期

桌面管理界面、管理网页服务随软件窗口启动和退出。发布后台是独立进程：Nginx、目录监测、失效恢复和处理任务不依赖窗口保持打开。再次启动软件会连接同一个后台；在“服务发布”点击“停止”才会停止 Nginx。发布后台使用本机随机端口和访问凭据与桌面通信，凭据文件仅当前用户可读，不暴露管理网页到内网。

后台正常重启会识别并接管本软件原有的 Nginx 进程。当前未注册开机自启或系统守护服务；电脑关机、重启后应打开软件并启动发布服务。

### 资源下载与本地资源

“资源下载”提供影像、地形、区域边界、3D Tiles、图片和 glTF 六个分类。DataV 区域边界输入地名或行政区代码检索，显示上级区划以区分同名区域；可下载所选区域或下一级边界集合到指定目录。覆盖范围取决于 DataV，目前索引为国家、省、市、区县，不含乡镇和村界。边界坐标及年份应按数据源核实。

其他分类支持 HTTP/HTTPS 单文件直链下载，以及登记已有本地文件或目录。下载流式写入目标目录，成功后才生成最终文件；同名文件不会覆盖，取消时清理临时文件。3D Tiles/glTF 推荐下载完整压缩包并解压，直链下载不递归获取纹理、bin 或瓦片依赖。当前未实现地图瓦片批量采集和登录鉴权下载。

软件只保存路径、来源、类别与下载状态等索引，不复制资源到软件内部。文件不存在时标记失效，移除索引需要确认且不删除文件。下载由后台服务执行，关闭管理窗口继续下载；后台服务重启后的未完成下载会标记中断，需重新提交。加工入口需要实际 TIFF 文件，发布入口需要完整资源目录，压缩包应先解压。

### 处理进度与任务并发

任务中心使用紧凑卡片，展示当前阶段进度、耗时、层级与实际并行数。预处理数据块及 GDAL 进度从引擎实时读取；不返回百分比的阶段显示活动条，百分比代表当前阶段，不是估算的全任务进度。路径和日志折叠显示。

默认同时运行 2 个任务，总并行预算 4；在“引擎与设置 → 任务并发”修改，支持 1–4 个并发任务和 1–16 的总预算。任务启动时取请求并行数与剩余预算的较小值，预算用完时排队。降低配置不会中断已有任务；取消只终止该任务的进程组。

Byte RGB/RGBA 影像无需拉伸或覆盖坐标系时直接读取原始 TIFF，跳过整份 RGBA 临时文件；其他影像仍按窗口转换并显示预处理进度。支持时优先使用 GDAL 原生 raster tile 的并行工作进程及 PNG 快速无损压缩，旧版本回退 gdal2tiles。压缩速度优化可能增加 PNG 文件大小，像素仍为无损编码。默认影像最大层级 15、地形 14；读取元信息后可使用根据源分辨率计算的层级建议。

修改 python/worker.py 后，先用构建环境 Python 执行 scripts/bundle-worker.py 更新内置 worker，再打包 Electron；仅修改 Python 源码不会更新已有冻结可执行文件。

### TIFF 融合与单文件成果

在“数据处理”中选择多个 TIFF / VRT，选择较精细数据优先或手动覆盖顺序，设置层级和新的成果文件路径。影像生成 `.mbtiles`，地形生成 `.terrain.sqlite`。地形输入必须先确认米制 WGS84 椭球高，可填写已经确认的逐文件高差校正值。

成果旁的 `<文件名>.sources` 保留 COG 母数据、VRT、来源和恢复记录；原始输入保留。再次融合时可把 `master.tif` 和新增 TIFF 作为输入，输出新版本。失败或取消后，用相同输入、参数和成果路径继续任务会利用已完成阶段；变更输入或参数请使用新成果文件名。不要删除 `.sources` 中的处理记录后再尝试恢复。

任务完成后点击“发布”，单文件可直接登记。影像服务仍使用 XYZ URL；地形服务提供 Cesium 标准 `layer.json` 和 `.terrain` 请求。地形 SQLite 容器由 GeoPress 定义，客户端通过服务读取。

目前采用完整新版本加工，局部增量重建与自动垂直高程基准转换尚未实现。详见 [维护文档](docs/ARCHITECTURE.md)。
