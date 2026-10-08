import path from 'node:path'
import type { Settings, JobRequest } from '../../shared/contracts'
export function validateSettings(value: Settings): Settings {
  if (!value || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
    throw new Error('端口必须是 1024–65535 的整数')
  }
  if (!['127.0.0.1', '0.0.0.0'].includes(value.host)) {
    throw new Error('监听地址无效')
  }
  if (
    !Number.isInteger(value.cacheSeconds) ||
    value.cacheSeconds < 0 ||
    value.cacheSeconds > 86400
  ) {
    throw new Error('缓存时间应为 0–86400 秒')
  }
  for (const key of ['nginx', 'python', 'gdal', 'terrain', 'osgb'] as const) {
    if (typeof value[key] !== 'string' || /[\n\r\0]/.test(value[key])) {
      throw new Error('引擎路径无效')
    }
  }
  const taskConcurrency = value.taskConcurrency ?? 2
  const workerBudget = value.workerBudget ?? 4
  if (!Number.isInteger(taskConcurrency) || taskConcurrency < 1 || taskConcurrency > 4) {
    throw new Error('同时运行任务数必须是 1–4')
  }
  if (!Number.isInteger(workerBudget) || workerBudget < 1 || workerBudget > 16) {
    throw new Error('总并行预算必须是 1–16')
  }
  return { ...value, taskConcurrency, workerBudget }
}
export function validateJob(value: JobRequest): JobRequest {
  if (!value || !['imagery', 'terrain', 'osgb'].includes(value.kind)) {
    throw new Error('任务类型无效')
  }
  for (const key of ['input', 'output', 'sourceCrs'] as const) {
    if (typeof value[key] !== 'string' || /[\0\r\n]/.test(value[key])) {
      throw new Error('任务路径或坐标系无效')
    }
  }
  if (!path.isAbsolute(value.input) || !path.isAbsolute(value.output)) {
    throw new Error('输入和输出必须是绝对路径')
  }
  if (
    !Number.isInteger(value.minZoom) ||
    !Number.isInteger(value.maxZoom) ||
    value.minZoom < 0 ||
    value.maxZoom > 22 ||
    value.minZoom > value.maxZoom
  ) {
    throw new Error('层级必须满足 0 ≤ 最小层级 ≤ 最大层级 ≤ 22')
  }
  if (value.kind === 'terrain' && value.minZoom !== 0) {
    throw new Error('Cesium 地形必须从 0 级生成，以保证根瓦片可用')
  }
  if (!Number.isInteger(value.workers) || value.workers < 1 || value.workers > 8) {
    throw new Error('并行进程必须为 1–8')
  }
  if (typeof value.scale !== 'boolean' || !['ellipsoid', 'unknown'].includes(value.verticalDatum)) {
    throw new Error('处理参数无效')
  }
  if ((value.longitude === undefined) !== (value.latitude === undefined)) {
    throw new Error('定位经纬度必须同时填写')
  }
  if (
    value.longitude !== undefined &&
    (!Number.isFinite(value.longitude) ||
      Math.abs(value.longitude) > 180 ||
      !Number.isFinite(value.latitude) ||
      Math.abs(value.latitude!) > 90)
  ) {
    throw new Error('经纬度超出范围')
  }
  const inputs = value.inputs?.length ? value.inputs : [value.input]
  if (
    !Array.isArray(inputs) ||
    inputs.length > 100 ||
    inputs.some(
      (input) => typeof input !== 'string' || !path.isAbsolute(input) || /[\0\r\n]/.test(input),
    )
  ) {
    throw new Error('请选择 1–100 个本地输入文件')
  }
  if (value.outputFormat && !['directory', 'package'].includes(value.outputFormat)) {
    throw new Error('成果格式无效')
  }
  if (value.fusionPolicy && !['precision', 'order'].includes(value.fusionPolicy)) {
    throw new Error('融合策略无效')
  }
  if (inputs.length > 1 && value.outputFormat !== 'package') {
    throw new Error('多输入融合请使用单文件成果格式')
  }
  if (value.kind === 'osgb' && (inputs.length !== 1 || value.outputFormat === 'package')) {
    throw new Error('OSGB 使用单目录输入和 3D Tiles 目录输出')
  }
  if (
    value.outputFormat === 'package' &&
    !value.output.toLowerCase().endsWith(value.kind === 'imagery' ? '.mbtiles' : '.terrain.sqlite')
  ) {
    throw new Error('影像成果使用 .mbtiles，地形成果使用 .terrain.sqlite')
  }
  if (
    value.heightOffsets &&
    (typeof value.heightOffsets !== 'object' ||
      Object.values(value.heightOffsets).some(
        (offset) => !Number.isFinite(offset) || Math.abs(offset) > 10000,
      ))
  ) {
    throw new Error('高程校正值必须是有效的米制数值')
  }
  return { ...value, inputs: [...new Set(inputs)] }
}
