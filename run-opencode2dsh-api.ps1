# OpenCode2DSH API 独立服务启动脚本（供开机自启调用）
$ErrorActionPreference = 'Stop'
$ServiceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $ServiceDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir 'opencode2dsh-api.log'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$ServerJs = Join-Path $ServiceDir 'opencode2dsh-api-server.mjs'

# 单实例保护：8791 已在监听则直接退出
try {
  $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:8791/health' -TimeoutSec 3 -UseBasicParsing
  if ($probe.StatusCode -eq 200) {
    Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] already running, skip start"
    exit 0
  }
} catch { }

if (-not (Test-Path -LiteralPath $NodeExe)) { $NodeExe = (Get-Command node).Source }
if (-not (Test-Path -LiteralPath $ServerJs)) { throw "server file not found: $ServerJs" }

$env:OPENCODE2DSH_API_HOST = if ($env:OPENCODE2DSH_API_HOST) { $env:OPENCODE2DSH_API_HOST } else { '127.0.0.1' }
$env:OPENCODE2DSH_API_PORT = if ($env:OPENCODE2DSH_API_PORT) { $env:OPENCODE2DSH_API_PORT } else { '8791' }
$env:OPENCODE2DSH_API_KEY = if ($env:OPENCODE2DSH_API_KEY) { $env:OPENCODE2DSH_API_KEY } else { 'public' }

Add-Content -LiteralPath $LogFile -Value "[$(Get-Date -Format o)] starting on http://$($env:OPENCODE2DSH_API_HOST):$($env:OPENCODE2DSH_API_PORT)/v1"

# 前台常驻运行（计划任务会保持该进程存活）；输出同时写入日志
& $NodeExe $ServerJs 2>&1 | Tee-Object -FilePath $LogFile -Append
