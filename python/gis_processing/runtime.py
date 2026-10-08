"""Engine execution and newline-delimited JSON progress events."""

import codecs
import json
import os
import re
import shutil
import subprocess


def emit(event, **values):
    print(json.dumps({'event': event, **values}, ensure_ascii=False), flush=True)


def executable(value, label):
    found = shutil.which(value) if value else None
    if not found:
        raise ValueError(f'缺少 {label} 引擎，请在设置中配置可执行文件')
    return found


def run(args, progress=False):
    emit('log', message='执行: ' + ' '.join(map(str, args)))
    env = dict(os.environ, GDAL_CACHEMAX='256', PYTHONUNBUFFERED='1')
    process = subprocess.Popen(
        list(map(str, args)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env
    )
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    pending = ''
    progress_tail = ''
    last_percent = -1
    while True:
        chunk = os.read(process.stdout.fileno(), 4096)
        if not chunk:
            break
        text = decoder.decode(chunk)
        pending += text
        progress_tail = (progress_tail + text)[-4096:]
        if progress:
            if 'Generating Overview Tiles' in text:
                emit('stage', message='生成低层级瓦片')
                last_percent = -1
                progress_tail = text
            for match in re.finditer(r'(?<!\d)(\d{1,3})(?=\.{3}| - done|%)', progress_tail):
                value = int(match.group(1))
                if 0 <= value <= 100 and value > last_percent:
                    last_percent = value
                    emit('progress', percent=value, label='引擎阶段进度')
        lines = re.split(r'[\r\n]', pending)
        pending = lines.pop()
        for line in lines:
            if line.strip():
                emit('log', message=line.strip()[:4000])
        if len(pending) > 8000:
            emit('log', message=pending[:4000])
            pending = pending[-4000:]
    if pending.strip():
        emit('log', message=pending.strip()[:4000])
    process.stdout.close()
    code = process.wait()
    if code:
        raise RuntimeError(f'转换引擎退出码 {code}，请查看日志')
