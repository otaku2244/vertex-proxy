# vertex-proxy

Minimal **OpenAI-compatible proxy for Google Vertex AI**, single-file Node.js, zero dependencies.

把 Vertex AI 的 `endpoints/openapi/chat/completions` 包装成标准 `/v1/chat/completions`，
供任何 OpenAI 兼容客户端（Operit / Serein / Cherry Studio / LibreChat …）直接接入。

## 特性

| 能力 | 说明 |
|---|---|
| Bearer 鉴权 | 客户端必须带 `Authorization: Bearer $PROXY_TOKEN` |
| ADC 自动续期 | 读取 `application_default_credentials.json`（`authorized_user`），用 refresh_token 换 access_token，缓存并提前 5 分钟刷新 |
| SSE 透传 | 上游响应体原样 pipe，流式不中断 |
| 429/503 退避重试 | truncated exponential backoff + jitter，最多 3 次；上游给 `Retry-After` 时优先服从 |
| 访问日志 | 每请求一行，落 journal，不含 prompt 内容 |
| 客户端断连中止 | 客户端断开即 abort 上游请求，避免白烧 token |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `18230` | 监听端口 |
| `GCP_PROJECT` | 必填 | GCP 项目 ID |
| `GCP_LOCATION` | `global` | `global` 走全球池（官方推荐）；也可填 `us-central1` 等单区域 |
| `PROXY_TOKEN` | 空 | 为空则不鉴权（不建议） |
| `ADC_PATH` | `$HOME/.config/gcloud/application_default_credentials.json` | ADC 路径 |
| `RETRY_MAX` | `3` | 额外重试次数（总尝试 = RETRY_MAX + 1） |
| `RETRY_BASE_MS` | `800` | 指数退避基数 |
| `RETRY_CAP_MS` | `8000` | 单次退避上限 |
| `UPSTREAM_OVERRIDE` | 空 | 仅用于自测：把上游指向本地 mock |

## 部署

1. 机器上先有 ADC（`gcloud auth application-default login`，或用你自己的方式生成 `authorized_user` 凭据落到 ADC_PATH）：

```bash
gcloud auth application-default login
```

2. 把 `server.js` 放到 `/opt/vertex-proxy/`，按 `vertex-proxy.service.example` 改好项目 ID 与 token，装到 `/etc/systemd/system/vertex-proxy.service`。

3. 启动：

```bash
systemctl daemon-reload
systemctl enable --now vertex-proxy
```

4. 验证：

```bash
curl -s localhost:18230/health
curl -s -H "Authorization: Bearer $PROXY_TOKEN" localhost:18230/v1/models
curl -s -H "Authorization: Bearer $PROXY_TOKEN" -H 'content-type: application/json' \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"say ok"}]}' \
  localhost:18230/v1/chat/completions
```

## 日志

```bash
journalctl -u vertex-proxy -f
journalctl -u vertex-proxy --since -1h | grep -E 'RETRY|UPSTREAM_FAIL|ACCESS'
```

单行格式：

```
[ACCESS] 2026-10-20T13:15:29Z m=POST p=/v1/chat/completions model=google/gemini-4-argon status=200 ms=2003 up_ms=1998 try=1 note=
[RETRY]  2026-10-20T13:15:44Z model=google/mock attempt=1 status=429 wait_ms=1000 retry_after=1 body={...}
```

`try` = 本请求总共尝试次数，`up_ms` = 上游耗时，`note` = 失败原因摘要（4xx/5xx 时带响应体）。

## 关于 429

Vertex AI 的 Gemini **没有 RPM 配额**，限的是**组织级 TPM 阈值**（按滚动 30 天消费分层，Standard PayGo）：

| 模型家族 | Tier1 $10–250 | Tier2 $250–2k | Tier3 $2k–50k | Tier4 >$50k |
|---|---|---|---|---|
| Flash / Flash-Lite | 2,000,000 | 4,000,000 | 10,000,000 | 50,000,000 |
| Pro 与 Argon | 500,000 | 1,000,000 | 2,000,000 | 10,000,000 |

阈值不是硬上限，是**优先放行的额度**：池子有余量时超额请求照常服务，高峰期先削突发。
所以 `Resource exhausted. Please try again later.` 通常是共享容量争抢或秒级尖峰，不是账号异常。

官方建议：用 `global` 端点、指数退避重试、平滑流量（别在同一秒并发多个大请求）、必要时提 QIR 或买 Provisioned Throughput。

参考：<https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429>

## 安全

- 不要把 `application_default_credentials.json`、真实 `PROXY_TOKEN` 提交进仓库或打进镜像。
- 这是单用户代理，没有多租户隔离、没有速率限制、没有 prompt 审计，**不要直接暴露到公网**。需要的话前面挂 nginx 加 TLS + IP 白名单。

## License

MIT
