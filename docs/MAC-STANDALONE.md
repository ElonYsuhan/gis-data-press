# macOS 独立应用包

当前制品面向 Apple Silicon（arm64），在当前 macOS 26 系统验证。Intel Mac 不适用。此包内的 CTB 使用 macOS 26 部署目标，不能将其宣称为旧版 macOS 通用包。

解压可携带 ZIP，得到一个 `GeoPress.app`，复制到目标电脑后双击启动。Python、Node、GDAL、CTB、OSGB 转换器、Nginx 及非系统动态库均随 `.app` 提供，不需要在使用电脑安装 Homebrew、Docker、Python 或开发工具。

内置内容：

- Electron / Node 桌面与后台运行时。
- PyInstaller Python worker、rasterio、numpy 及相关 Python 模块。
- GDAL 原生影像目录切片、DEM 重投影工具与 GDAL/PROJ 数据。
- Quantized Mesh 分支 CTB 地形转换器。
- OSGB → 3D Tiles 转换器、OpenSceneGraph 场景/序列化/纹理插件。
- Nginx 发布服务。
- 原生库许可及构建来源记录（`Contents/Resources/engines/licenses`）。

应用默认选择内置工具；有效的用户自定义工具配置仍可使用，失效的旧配置回退到内置工具。发布目录、成果和用户配置在应用外保存；复制应用不会自动复制另一台电脑的 GIS 数据。

## 验证

`python3 scripts/check-native-mac.py resources/engines` 校验所有 Mach-O 文件的 arm64 架构与非系统依赖路径，打包前自动运行。

`node scripts/check-standalone-mac.mjs` 将 `.app` 复制到另一处带空格的路径，仅保留系统 PATH，清除 Python、GDAL、PROJ、OSG 和动态库环境覆盖，在隔离测试用户数据目录验证：读取元数据、影像 MBTiles 和目录切片、DEM 单文件和目录地形、OSGB 模型转换、Nginx 发布读取。

此测试不替代另一台实体 Mac 的验收，且不意味着 Windows 包已完成。在线检索、下载与在线底图仍需要网络。

## 重建（开发电脑）

1. 准备 CMake、Rust、GDAL、OpenSceneGraph 和项目 `.venv`。
2. `python3 scripts/build-converters-mac.py` 编译固定上游版本及 macOS 兼容补丁，收集原生动态库、插件与投影数据。
3. `.venv/bin/python scripts/bundle-worker.py`，`python3 scripts/bundle-nginx.py`。
4. `npm run build`。
5. `npx electron-builder --mac --dir -c.electronDist=node_modules/electron/dist`。
6. 运行上述验证，再用系统 `ditto` 生成可携带 ZIP。

当前没有 Apple Developer ID 证书，尚未完成 Apple 公证。分发到其他电脑时，系统安全策略可能要求用户允许打开；这与缺少运行依赖是不同问题。
