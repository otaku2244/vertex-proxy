# Vertex AI OpenAI 兼容代理

把 Google Vertex AI 上的 Gemini 模型，包装成标准 OpenAI 接口。让只支持 OpenAI 协议的客户端（Operit、Cherry Studio、NextChat、LobeChat、Dify 等）能够直接调用 GCP 额度。

零第三方依赖，只用一个 Node 文件，约 120 行。

---

## 为什么需要这个

在 GCP 上直接给客户端配 Vertex AI，会连续撞上三堵墙：

1. **拿不到服务账号密钥。** 2024 年 5 月 3 日之后创建的 GCP 组织，默认强制执行组织策略 `iam.disableServiceAccountKeyCreation`，控制台里的「创建密钥」按钮是灰的，也没有任何自助关闭入口。
2. **Vertex 不收 API Key。** 它的推理端点只接受 OAuth2 access token。凭据页里创建的普通 API Key 对它无效，`API 限制` 下拉里甚至不会出现 Vertex 相关选项。
3. **access token 一小时就过期。** 客户端没法自己续期，手动粘贴的话，手机一锁屏、浏览器一切后台，Cloud Shell 会话重置，token 立刻失效。

这个代理解决的就是第三点：把续期这件事挪到服务端。客户端只需要一个永不变的地址和一个自己定的密码。

---

## 架构

```
客户端 (OpenAI 协议 + Bearer <PROXY_TOKEN>)
        │
        ▼
本服务 (Node, 监听 18230)
    ├─ 校验 PROXY_TOKEN
    ├─ 用 refresh_token 换 access token（55 分钟缓存一次）
    └─ 转发到 Google 官方端点
        │
        ▼
https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi/chat/completions
```

关键点：请求最终打到的是 **Google 官方域名**，走官方计费。本服务只做协议翻译和凭证注入，不改写请求内容。

---

## 前置条件

- 一台能访问 Google 的 Linux 服务器（香港、新加坡、日本等区域延迟较低）
- Node.js 18 及以上（推荐 22）
- GCP 项目已启用 `aiplatform.googleapis.com`（控制台里可能显示为 **Agent Platform API**）
- 该项目已绑定有效的 Cloud Billing 账号
- 一次交互式 OAuth 授权（只需做一次，之后长期有效）

---

## 部署

### 1. 在服务器上安装 gcloud

```bash
mkdir -p /opt && cd /opt
curl -sSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz -o gc.tgz
tar -xzf gc.tgz && rm gc.tgz
/opt/google-cloud-sdk/bin/gcloud --version
```

### 2. 生成 ADC 凭证

```bash
/opt/google-cloud-sdk/bin/gcloud auth application-default login --no-launch-browser
```

终端会打印一个 `accounts.google.com` 的授权链接。在任意浏览器打开、登录、授权，把页面给出的验证码粘回终端。

成功后凭证写入：

```
~/.config/gcloud/application_default_credentials.json
```

文件类型是 `authorized_user`，内含 `client_id`、`client_secret`、`refresh_token`。**这个文件等同于长期密码，权限保持 600，不要外传。**

### 3. 配置并部署

```bash
export VPS_HOST=your.server.ip
export VPS_PASS=your-root-password
export GCP_PROJECT=your-gcp-project-id
export PROXY_TOKEN=$(openssl rand -hex 16)
export GCP_LOCATION=global

python3 scripts/deploy.py
```

脚本会渲染 systemd 配置、上传代码、启动服务，最后做一次端到端调用验证。

### 4. 客户端配置

| 字段 | 值 |
|---|---|
| 供应商 | OpenAI 兼容（不是 Responses） |
| Base URL | `http://<你的服务器>:18230/v1` |
| API 密钥 | 上面生成的 `PROXY_TOKEN` |
| 模型 | 点「拉取模型列表」，或手填下表中的 ID |

---

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `GCP_PROJECT` | 是 | — | 拥有 Vertex 额度的项目 ID |
| `PROXY_TOKEN` | 否 | 空 | 客户端需携带的 Bearer token，留空则不鉴权（不建议） |
| `GCP_LOCATION` | 否 | `global` | 区域，`global` 支持新模型 |
| `PORT` | 否 | `18230` | 监听端口 |
| `ADC_PATH` | 否 | `~/.config/gcloud/application_default_credentials.json` | 凭证路径 |
| `RETRY_MAX` | 否 | `3` | 429/503 的额外重试次数（总尝试 = 该值 + 1） |
| `RETRY_BASE_MS` | 否 | `800` | 指数退避基数，第 n 次等待约 `base × 2^(n-1)` |
| `RETRY_CAP_MS` | 否 | `8000` | 单次退避上限；上游返回 `Retry-After` 时优先服从它 |
| `RETRY_BUDGET_MS` | 否 | `25000` | 重试总预算，从请求开始计时；超出即停止重试、直接返回 429/503 |
| `TTFB_STREAM_MS` | 否 | `45000` | 流式请求的首字节超时（首字节 = 首个 token） |
| `TTFB_NONSTREAM_MS` | 否 | `120000` | 非流式请求的首字节超时（首字节 = 全文生成完，必须给足） |
| `UPSTREAM_OVERRIDE` | 否 | 空 | 仅自测用，把上游指向本地 mock，生产留空 |
| `IMAGE_SAVE` | 否 | `1` | 图像响应适配开关，设 `0` 则原样透传上游的畸形结构 |
| `IMAGE_DIR` | 否 | `/root/vertex-proxy/images` | 生成的图片落盘目录 |
| `IMAGE_KEEP` | 否 | `200` | 目录最多保留多少张，超出按时间删最旧 |
| `IMAGE_AUTO_MODALITY` | 否 | `1` | 自动给图像模型补 `modalities:["text","image"]`，设 `0` 关闭 |
| `PUBLIC_BASE_URL` | 否 | 空 | 图片链接的基地址；留空则用请求的 `Host` 头 |

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活检查，返回 `ok` |
| GET | `/v1/models` | 返回支持的模型列表（OpenAI 格式） |
| POST | `/v1/chat/completions` | 对话补全，支持流式 |
| GET | `/images/<name>` | 图像模型生成的图片，**不鉴权** |

调用示例：

```bash
curl -s http://127.0.0.1:18230/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-4-argon","messages":[{"role":"user","content":"你好"}],"max_tokens":200}'
```

模型名可以带 `google/` 前缀，也可以不带，服务会自动补全。

---

## 模型与区域

| 模型 ID | 类型 | 实测首字节 | 备注 |
|---|---|---|---|
| `google/gemini-4-argon` | 旗舰 | 挂起中 | **仅 `global`**，近期大面积无响应 |
| `google/gemini-3.8-flash` | flash | 429 | 最新 flash，配额较紧 |
| `google/gemini-3.7-flash` | flash | 0.81s | 快且稳 |
| `google/gemini-3.6-flash` | flash | 0.89s | 输出最详细 |
| `google/gemini-3.5-flash` | flash | 0.87s | 均衡 |
| `google/gemini-3.5-flash-lite` | lite | 0.73s | 最便宜最快 |
| `google/gemini-3.1-pro-preview` | pro | 1.96s | **只有 preview 版**，限流严格 |
| `google/gemini-3.1-flash-lite` | lite | 0.82s | 3.1 唯一转正的 |
| `google/gemini-3-flash-preview` | flash | 1.16s | preview |
| `google/gemini-2.5-pro` | pro | 4.72s | GA 正式版，长期可用 |
| `google/gemini-2.5-flash` | flash | 3.79s | GA 正式版 |
| `google/gemini-2.5-flash-lite` | lite | 3.80s | GA 正式版 |
| `google/gemini-3-pro-image` | image | 5.9s / 出图 19.7s | 出图质量最高，1408×768 PNG |
| `google/gemini-3.1-flash-image` | image | 1.4s / 出图 9.5s | 出图主力，1408×768 PNG |
| `google/gemini-3.1-flash-image-preview` | image | — | 与上者同名不同期，行为一致 |
| `google/gemini-3.1-flash-lite-image` | image | 0.8s / 出图 6.3s | 最小最快，输出 JPEG |

「首字节 / 出图」两段是分开测的：不带 `modalities` 时它就是个普通文本模型（首字节极快）；带上才真正出图，那一段耗时才包含渲染。

**3.x flash 比 2.5-flash 快 1.6–2.8 倍**，同 prompt 下输出还更详细。日常建议直接用 3.6/3.5-flash，不必守着 2.5。

**区域是最大的坑：** `gemini-4-argon` 只在 `global` 可用，请求打到 `us-central1` 会返回 404，报错内容是「Publisher model ... was not found or your project does not have access to it」，看起来像没权限，实际是区域不对。

另外 `global` 的域名规则和区域性端点不同：`global` 走 `aiplatform.googleapis.com`，**不带** `global-` 前缀。代码里已做分支处理。

### 为什么 2.5-pro 还在、3.1 却「没有」

不是没有，是名字不一样。3.1 的 pro 只有 **preview** 版（`gemini-3.1-pro-preview`），写成 `gemini-3.1-pro` 才会 404。

2.5-pro 能长期存在是因为它是 **GA（正式版）**，Vertex 对 GA 模型承诺稳定可用；3.1-pro 至今没转正，只有 preview，会到期下架。两代并存是正常的生命周期差异，不是「新模型被撤了」。

### 查完整模型清单

```bash
GET https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=200
```

三个必须注意的点：

1. 必须带 header `x-goog-user-project: <你的项目ID>`，否则 403（ADC 缺 quota project 声明）
2. 只有 **`v1beta1`** 有这个端点，`v1` 返回 404
3. 返回字段叫 **`publisherModels`**，不是 `models`——用错字段会静默得到 0 条，看着像「没有模型」

清单里还有 `-tts`、`-transcribe`、`-embedding`、`live` 等变体，它们**不能**用于 Chat Completions。`-image` 系列可以，但需要额外处理，见下一节。

---

## 图像模型

四个 `-image` 模型都能通过 `/v1/chat/completions` 出图，但上游返回的结构是畸形的，直接透传给客户端等于不可用。代理做了三处适配。

### 坑一：图片藏在 `message.audio.data`

正常 OpenAI 图像响应应该有 `images` 或 `content` 里的图片块。Vertex 兼容层不是——它把 PNG/JPEG 的 base64 塞进 **`message.audio.data`**，而 `content` 是空字符串：

```json
{
  "choices": [{
    "message": {
      "audio": { "data": "iVBORw0KGgoAAAANSUhEUg..." },
      "content": "",
      "refusal": "Unexpected tool call: Model tried to call an undeclared function: google:image_gen"
    }
  }]
}
```

### 坑二：伴随一条假的 `refusal`

`refusal` 里那句「模型调用了未声明函数 `google:image_gen` / `google:display`」是兼容层对内部工具调用的误报。图片其实**已经生成好了**，但如果原样透传，客户端会判定为失败并显示这条错误。

### 坑三：不带 `modalities` 就根本不出图

实测同一个 prompt：不写 `modalities` 时，图像模型只回一段文本（`"你好！"`），一个像素都不生成。而 Operit 这类客户端不会自己带这个参数。

### 代理怎么处理的

| 环节 | 处理 |
|---|---|
| 补 `modalities` | 模型名含 `image` 且请求未指定时，自动注入 `["text","image"]` |
| 取出图片 | 从 `message.audio.data` 读 base64，按文件头判断 png/jpg/gif/webp |
| 落盘 | 写到 `IMAGE_DIR`，文件名 `img-<毫秒时间戳>-<6位随机>.<ext>` |
| 改写 content | 替换成一行 markdown 图片链接，删掉 `audio` 和 `refusal` |
| 提供访问 | 暴露 `GET /images/<name>`，**不鉴权**（`<img>` 标签带不了 header） |

流式和非流式都做了适配，但走的是不同路径：

| 客户端 | 上游返回 | 代理处理 |
|---|---|---|
| `stream: false` | 一个完整 JSON | 解析后改写 `message.content` |
| `stream: true` | SSE，图片 base64 分块在 `delta.audio.data` | 读完整个流，拼接 base64，重发一条干净的 SSE |

流式必须先缓冲完整个上游流才能取出图片，所以**流式的「首字节」要等出图结束**，不是真流式。实测体积对比：

| | 上游原始 | 代理改写后 |
|---|---|---|
| 非流式 | 2.3 MB | 2.2 KB |
| 流式 | 1.2 MB | 710 B |

改写后客户端收到的是：

```json
{ "choices": [{ "message": {
  "content": "![png](http://<你的地址>/images/img-1792555895441-i5tfi8.png)",
  "role": "assistant"
} }] }
```

响应体从 **2.3MB 降到 2.2KB**。这一步不是优化，是必需：2.3MB 的 base64 一旦进入对话历史，下一轮请求会连同它一起回传，上下文直接爆掉。

### 使用约束

- 单张图 1.5–2.5MB，`gemini-3-pro-image` 出图约 20 秒，flash 系列 6–10 秒。客户端超时阈值要留够。
- 图片目录默认保留 200 张，超出自动删最旧。想清空直接 `rm -rf images/*`。
- 想让外部域名/端口访问图片，设 `PUBLIC_BASE_URL=https://your.domain`；留空则用请求的 `Host` 头拼。

---

## 运维

服务由 systemd 托管，配置了 `Restart=always` 和开机自启。

```bash
systemctl status vertex-proxy
systemctl restart vertex-proxy
journalctl -u vertex-proxy -n 50
journalctl -u vertex-proxy -f
```

日志走 journald，自动轮转，不会无限增长。

### 更换 PROXY_TOKEN

```bash
NEWKEY=$(openssl rand -hex 16)
sed -i "s/^Environment=PROXY_TOKEN=.*/Environment=PROXY_TOKEN=$NEWKEY/" /etc/systemd/system/vertex-proxy.service
systemctl daemon-reload && systemctl restart vertex-proxy
```

先改服务、再改客户端，中间没有过渡期，旧 token 会立即失效。

---

## 日志与延迟归因

每个请求打印一行 `[ACCESS]`，字段足够定位「慢在哪一段」：

| 字段 | 含义 |
|---|---|
| `ms` | 端到端总耗时（收到请求 → 响应写完） |
| `up_ms` | 上游首字节时间（发出请求 → 收到响应头） |
| `stream` | `1` 流式 / `0` 非流式 / `-1` 请求体未解析 |
| `msgs` | `messages` 条数，新窗口首轮通常 1~2 |
| `tools` | `tools` 数组长度 |
| `chars` | 请求体字符数，粗估输入规模 |
| `effort` | `reasoning_effort` 档位，未设为 `-` |
| `max_tok` | 客户端声明的输出上限 |
| `out_b` | 实际回给客户端的字节数（流式含 SSE 包装） |
| `try` | 第几次尝试，`>1` 说明发生过退避重试 |
| `note` | 失败原因或上游错误摘要 |

### 读法：先看 `stream`，再看 `up_ms`

这是最容易误判的地方。**非流式请求的 `up_ms` 等于完整生成时间**，不是网络延迟——因为服务端要等整段生成完才吐第一个字节。

实测同一个短 prompt（输出一个字）：

| 模式 | `ms` | `up_ms` | 结论 |
|---|---|---|---|
| `stream=false` | 29.76s | 29.58s | 首字节 = 全文生成完 |
| `stream=true` | 3.03s | 2.95s | 首字节 = 首个 token |

同一个请求，非流式比流式慢约 10 倍，而网络和服务器完全没变。

所以判断规则：

- `up_ms` 大且 `ms - up_ms` 只有几十毫秒 → **非流式**，客户端在等全文，不是网络慢
- `up_ms` 小（3~5s）但 `ms - up_ms` 有二三十秒 → **真流式**，模型在慢慢吐字
- `up_ms` 大且 `ms - up_ms` 也大 → 上游排队 + 长输出，只能减上下文或换模型
- `ms - up_ms` 稳定在 30~90ms → 响应头到达时全文已生成，典型非流式特征

### 已观测到的量级（2026-10，81 次真实请求）

| 指标 | p50 | p90 | max |
|---|---|---|---|
| 端到端 `ms` | 10.1s | 45.2s | 117.7s |
| 上游首字节 `up_ms` | 5.1s | 28.3s | 111.9s |
| 流式下发 `ms - up_ms` | 1.7s | 19.1s | 50.5s |

`up_ms` 占端到端的比例：p50 **87.7%**。也就是说瓶颈几乎完全在 Google 侧，不在这台服务器。

另外 `gemini-4-argon` 抖动极大，同一句问题的首字节在 2.2s / 3.0s / 3.9s / 9.8s 之间飘，说明上游存在排队，不是稳定延迟。

### 已排除的变量

用固定 prompt 做的对照实验，结论和直觉相反：

| 变量 | 变化 | 端到端影响 |
|---|---|---|
| 工具数量 | 0 → 30 个（12 → 1542 token） | 无变化 |
| 上下文长度 | 108 → 53,419 token | 4.4s → 6.2s（+40%） |
| 思考档位 | `minimal/low/medium` | 都在 3s 内 |
| 思考档位 | `high` | 14.3s，唯一明显变慢的档 |

输入 token 的处理速度约 3 万/秒，所以「上下文太长拖慢首字」在 5 万 token 以内并不成立；真正的变量是**输出长度**和**思考档位**。

### 上游首字节超时

上游偶尔会「收下请求但迟迟不给响应头」。早期版本没有超时保护，表现为客户端干等一两分钟然后自己断开，日志里只有一行 `This operation was aborted`，看不出是在等什么。

现在加了首字节超时，超时即返回 504 并记录 `[TTFB_TIMEOUT]`：

| 类型 | 默认阈值 | 为什么是这个值 |
|---|---|---|
| 流式 | 45s | 首字节=首个 token，历史 p50 6.7s / p90 31.6s；45~60s 区间**零成功样本**，取 45 不增加误杀但早 15s 失败 |
| 非流式 | 120s | 首字节=全文生成完，历史见过 82s 的样本，必须给足 |

超时后**不重试**。上游已经过载时再重试一轮，只会让用户多等一个周期。

### 上游抖动是常态

用 `max_tokens=5` 的固定短请求连打，同一分钟内能看到这种分布：

| 第几次 | 首字节 | 结果 |
|---|---|---|
| 1 | 81.9s | 429 Resource exhausted |
| 2 | 3.0s | 200 正常 |
| 3 | >120s | 无响应 |
| flash 对照 | 4.9s | 200 正常 |

注意那个 **81.9 秒才返回的 429**——限流错误本身也要排队近一分半才吐出来。所以「没日志」不等于「没限流」，也可能是还在排队。

同一个模型前后两次能差 40 倍，说明这是 Google 侧容量问题，不是本地网络。遇到这种情况直接换 `gemini-2.5-flash`，不要连续重发。

---

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `404 Publisher model ... not found` | 模型在该区域不存在 | 把 `GCP_LOCATION` 改成 `global`，或换模型 |
| `401 invalid api key` | 客户端填的 token 与服务端不一致 | 核对 `PROXY_TOKEN` |
| `502 oauth 400 invalid_grant` | refresh token 被撤销 | 重做第 2 步授权 |
| `502 metadata ...` | 服务跑在 Cloud Run 等没有 ADC 文件的环境 | 配置 `ADC_PATH` |
| 客户端报 cleartext 错误 | Android 禁止明文 HTTP | 前置一层 TLS 反代 |
| 新窗口、没上下文，依然很慢 | 客户端走非流式，必须等全文生成 | 日志看 `stream=0`；改客户端开流式，或降低思考档位 |
| 偶发 429 | 共享容量瞬时争抢，不是配额被占满 | 自动退避重试；`note` 出现 `budget-exhausted` 表示放弃重试、快速失败 |
| 429 报文里只有 message，没有 `quotaMetric`/`violations` | 属于 Dynamic Shared Quota 争抢，不是项目配额墙 | 提配额工单无效；换个模型或过几分钟再试 |
| 单次请求等了 100 秒以上才报错 | 重试链叠加，每次 429 本身要几十秒才吐 | `RETRY_BUDGET_MS` 默认 25s 会中断重试链，可再调小 |
| `504 upstream_timeout` | 上游迟迟不给响应头，通常是过载 | 等一会儿或换 `gemini-2.5-flash`；阈值可用 `TTFB_*_MS` 调 |
| `ERROR ... This operation was aborted` | 客户端主动断开（超时或关窗） | 正常现象，上游请求已同时中止，不会空烧 token |
| 选了图像模型却只回文字 | 客户端没带 `modalities`，上游就当文本模型用 | 检查 `IMAGE_AUTO_MODALITY` 是否被设成 `0` |
| 图像模型回空白 + `Unexpected tool call` | 关掉了 `IMAGE_SAVE`，畸形结构被原样透传 | 去掉 `IMAGE_SAVE=0` 重启 |
| 图片链接打不开 | `PUBLIC_BASE_URL` 或 `Host` 头不是客户端可达的地址 | 显式设 `PUBLIC_BASE_URL` |
| 图像请求报 400 `modalities` | 传了非 image 模型却带 `modalities` | 只在 `-image` 模型上用 |

---

## 安全

- **`PROXY_TOKEN` 和 ADC 文件都是敏感信息。** 一旦泄露，别人可以用你的 GCP 额度。
- **不要把这个服务分享给他人使用。** 自用是正常的后端调用；多人共用一个凭证属于凭证共享，违反 Google 服务条款，可能触发风控并冻结项目资金。
- 仓库里不要提交 `.env`、实际渲染出的 `.service` 文件、ADC 凭证。
- 建议使用 SSH 密钥替代密码登录，并关闭 root 密码登录。

---

## 已知限制

- 只实现 `/v1/chat/completions`，不支持 OpenAI 的 `/v1/responses`
- 不支持流式以外的特殊参数，如 `logprobs`、多模态文件上传
- 图像模型流式请求要先缓冲完整个上游流才能取出图片，表现为「攒够才吐」，不是真流式
- `/images/` 不鉴权，靠文件名随机性保护。图片内容本身不敏感时可用；如需严格管控，应在反代层加签名或 IP 白名单
- 不代理第三方模型（Claude、Llama 等）：它们走不同协议，且不参与 GCP 免费试用赠金抵扣
- 单进程无并发限流，高频调用需要自行在反代层加限制

---

## 许可

个人使用。请自行评估所在地区与 Google 服务条款的合规性。
