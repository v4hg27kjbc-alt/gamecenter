---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: fbb3d0100d73840269ed17c69ec05f26_0ce6fdfdbe3511f1887c525400de85a5
    ReservedCode1: JAq/USMkeaEhU5bm+9F5yIvZNp2653eOBm2c6pGEbyppS4fNhN3d2cXpe0mXQDoR2te5Gd+2EaxjNEbgpiRI9cb7W6xsOGP21slHhexqMq0sO61xBkOEBbfIcCdlfBIJaojgB4U9UuAuomSJy6CwvUJ67vRe1vOmuV8AtWe1lfDlWCP8WQp55wQAAB8=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: fbb3d0100d73840269ed17c69ec05f26_0ce6fdfdbe3511f1887c525400de85a5
    ReservedCode2: JAq/USMkeaEhU5bm+9F5yIvZNp2653eOBm2c6pGEbyppS4fNhN3d2cXpe0mXQDoR2te5Gd+2EaxjNEbgpiRI9cb7W6xsOGP21slHhexqMq0sO61xBkOEBbfIcCdlfBIJaojgB4U9UuAuomSJy6CwvUJ67vRe1vOmuV8AtWe1lfDlWCP8WQp55wQAAB8=
---

# 主站 AI 服务端接口部署说明（Cloudflare Pages Functions）

> 适用仓库：`v4hg27kjbc-alt/gamecenter`（线上站点 `henry126923.pages.dev`）
> 覆盖范围：`functions/api/token.js`、`functions/api/chat.js`

## 一、为什么需要这两个接口

主站前端（`index.html` 内 `window.AIBridge`）采用**零前端密钥**方案：浏览器不持有任何上游 API Key，
统一走同源接口 `/api/token`（取短期令牌）与 `/api/chat`（发起对话）。

此前仓库中**没有 `functions` 目录**，两个路径落到静态资源回退上，表现为：

| 请求 | 现象 | 原因 |
|---|---|---|
| `GET /api/token` | 返回站点首页 HTML | 无 Function 处理，被静态回退（200 + index.html） |
| `POST /api/chat` | 405 Method Not Allowed | 静态资源不支持 POST |

因此线上 AI 问答不可用。补齐 `functions/api/` 下的两个函数后即可恢复。

## 二、新增文件与路由

```
functions/
└── api/
    ├── token.js   ->  /api/token   （GET 下发访客 Cookie；POST 签发短期令牌）
    └── chat.js    ->  /api/chat    （POST 路由转发到智谱 / Kimi）
```

Cloudflare Pages 会自动把仓库根目录下的 `functions/` 编译为 Functions 并按文件路径生成路由，
无需额外配置 `_routes.json`（若项目设置了构建输出目录，`functions/` 仍须位于**项目根目录**）。

## 三、必须配置的环境变量

进入 Cloudflare Dashboard → **Workers & Pages** → 选择项目 `henry126923` → **Settings** →
**Variables and Secrets**，在 **Production**（建议 Preview 同步配置）中逐条添加。
**保存后需要重新部署（Retry deployment / 重新 push）才会生效。**

| 变量名 | 必填 | 说明 |
|---|---|---|
| `ZHIPU_API_KEY` | ✅ 必填 | 智谱开放平台 API Key，服务端调用 `open.bigmodel.cn` 使用；仅存在于服务端 |
| `KIMI_API_KEY` | ✅ 必填 | Kimi（Moonshot）API Key，服务端调用 `api.moonshot.cn` 使用；仅存在于服务端 |
| `AI_TOKEN_SECRET` | ✅ 必填 | 令牌签名密钥，长度 ≥ 16（建议 48 字节随机）。`/api/token` 签发、`/api/chat` 校验共用同一值 |
| `ALLOWED_ORIGIN` | ⬜ 选填 | 跨域白名单，逗号分隔（如 `https://henry126923.pages.dev`）。不配置时仅同源可用 |

可选（模型名迭代时零改码切换，不配置则用代码内默认值）：

| 变量名 | 默认值 | 用途 |
|---|---|---|
| `AI_MODEL_ZHIPU_LIGHT` | `glm-4.7-flash` | `tier='light'`（故事 / 查找 / 简介 / 新闻摘要） |
| `AI_MODEL_ZHIPU_FLAGSHIP` | `glm-4.7` | `tier='flagship'`（收藏洞察报告 / 长文翻译） |
| `AI_MODEL_ZHIPU_VISION` | `glm-4.7` | `tier='vision'`（照片识机，需多模态模型） |
| `AI_MODEL_KIMI_DEEP` | `kimi-k2.6` | Kimi 深度模式默认模型 |

生成签名密钥：

```bash
openssl rand -base64 48
```

> ⚠️ 密钥只填在 Cloudflare 控制台，**严禁**写入仓库文件、前端代码或提交到 Git。
> 仓库内两个 `.js` 文件不含任何 Key，只通过 `env.ZHIPU_API_KEY` / `env.KIMI_API_KEY` / `env.AI_TOKEN_SECRET` 读取。

## 四、部署步骤

```bash
cd "<仓库本地目录>"          # 例：~/Desktop/网页开发/文档备份与文件可行性报告方案/henry
git add functions/ DEPLOY-AI.md
git commit -m "feat(api): 新增 /api/token 与 /api/chat 服务端接口，密钥走环境变量"
git push origin main
```

推送后 Cloudflare Pages 自动构建部署；在控制台确认环境变量已配置后即可生效。

## 五、上线后自检

```bash
# 1) 访客 Cookie：应返回 {"ok":true,"bootstrapped":true,...}
curl -i "https://henry126923.pages.dev/api/token?bootstrap=1"

# 2) 签发令牌：应返回 {"ok":true,"token":"v1....","expiresIn":900,...}
curl -s -X POST https://henry126923.pages.dev/api/token \
  -H 'Content-Type: application/json' \
  -d '{"scope":"chat","ttl":900,"provider":"zhipu"}'

# 3) 带令牌对话（TOKEN 换成上一步返回值）：应返回 {"ok":true,"answer":"..."}
curl -s -X POST https://henry126923.pages.dev/api/chat \
  -H 'Content-Type: application/json' \
  -H "X-AI-Token: <TOKEN>" \
  -d '{"provider":"zhipu","model":"glm-4.7-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

常见错误码与含义：

| 返回 | 含义 | 处理 |
|---|---|---|
| `500 server_misconfigured` | 环境变量缺失（`AI_TOKEN_SECRET` 或对应 `*_API_KEY`） | 在控制台补齐后重新部署 |
| `401 token_expired` | 令牌过期 | 前端会自动刷新并重试一次 |
| `502 upstream_auth_failed` | 上游拒绝鉴权，通常是 API Key 无效 / 欠费 | 检查对应平台的 Key |
| `429 upstream_rate_limited` | 上游限流 | 稍后重试或降低并发 |
| `502 upstream_unreachable` | 网络到上游失败 | 检查上游域名可达性 |

## 六、接口契约摘要

**POST /api/token**

- 入参：`{ scope?: 'chat', ttl?: 900, provider?: 'zhipu' | 'kimi' }`
- 出参：`{ ok, token, expiresIn, scope, provider, tokenType: 'hmac-sha256', upstreamReady }`
- `token` 是服务端用 `AI_TOKEN_SECRET` 签发的短期 HMAC 令牌（`v1.<payload>.<sig>`），
  **不是上游 API Key**；有效期默认 900 秒，服务端上限 3600 秒。

**POST /api/chat**

- 请求头：`X-AI-Token: <token>`（也兼容 `Authorization: Bearer <token>`）
- 入参：`{ messages, stream?, tier?, provider?, mode?, model?, feature?, temperature?, maxTokens? }`
- 出参（非流式）：`{ ok, answer, model, provider, finishReason, usage, requestId }`
- 出参（`stream: true`）：`text/event-stream`，OpenAI 兼容增量，末包 `data: [DONE]`

路由规则（与前端 `AIBridge` 对齐）：

| 场景 | 判定 | 上游 |
|---|---|---|
| 主问答 · 快速 | `provider='zhipu'`（默认）/ `mode='fast'` | 智谱 `open.bigmodel.cn`，默认 `glm-4.7-flash` |
| 主问答 · 深度 | `provider='kimi'` / `mode='deep'` | Kimi `api.moonshot.cn`，默认 `kimi-k2.6` |
| 场景调用 | 带 `tier`（前端测评 / 新闻 / 照片识机等） | 按 `TIER_ROUTES` 固定路由，不受左上角模型选择器影响 |

安全限制：单次最多 40 条消息、文本总量 ≤ 48000 字符、`max_tokens ≤ 8192`；
上游错误统一映射，**绝不回传 API Key**，仅返回错误码与上游错误摘要。
*（内容由AI生成，仅供参考）*
