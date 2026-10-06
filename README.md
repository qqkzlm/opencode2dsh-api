# OpenCode2DSH 本地 API 服务

基于已安装的 `@opencode2dsh/dsh-plugin`，在本地暴露 OpenAI 兼容 HTTP 接口，供 Cherry Studio、NextChat、代码工具等外部程序调用。

## 接口

```text
Base URL: http://127.0.0.1:8791/v1
API Key: public
```

支持：

```text
GET /health
GET /v1/models
GET /v1/models/{id}
POST /v1/chat/completions
POST /v1/chat/completions（stream=true）
```

只监听本机 `127.0.0.1`，不会对外暴露。

## 文件

```text
opencode2dsh-api-server.mjs  本地 OpenAI 兼容服务
run-opencode2dsh-api.ps1     独立服务启动脚本（单实例保护 + 日志）
```

## 手动启动

```powershell
node opencode2dsh-api-server.mjs
```

## 开机自启

已通过 Windows 计划任务实现：

```text
任务名：OpenCode2DSH-API
触发：用户登录自动启动
```

手动管理：

```powershell
schtasks /Run /TN OpenCode2DSH-API
schtasks /Query /TN OpenCode2DSH-API /FO LIST /V
schtasks /Delete /TN OpenCode2DSH-API /F
```

## 调用示例

```powershell
curl http://127.0.0.1:8791/v1/models `
  -H "Authorization: Bearer public"
```

```powershell
curl http://127.0.0.1:8791/v1/chat/completions `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer public" } `
  -Body '{"model":"big-pickle","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

## 环境变量

```text
OPENCODE2DSH_API_HOST=127.0.0.1
OPENCODE2DSH_API_PORT=8791
OPENCODE2DSH_API_KEY=public
OPENCODE2DSH_REFRESH_SECONDS=300
OPENCODE2DSH_REQUEST_TIMEOUT_MS=120000
```

## 说明

底层是 OpenCode 官方免费通道，仍受 OpenCode 官方频率和区域限制。接口本身不保存聊天记录，每次请求独立。
