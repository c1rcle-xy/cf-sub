<div align="center">

# cf-sub

**跑在 Cloudflare Workers 上的节点订阅管理服务**

管理员在一个网页里增删改节点，订阅者拿一个固定链接取订阅。

无外部依赖 · 无需构建 · 单文件 Worker · 数据存 KV · 零成本部署

</div>

---

> ## ⚠️ 免责声明
>
> **本项目仅供学习与技术研究使用。**
>
> - 本项目**只是一个订阅链接的存储和分发工具**，不提供、不托管、不代理任何服务器或网络节点。仓库中不含任何可用节点。
> - 使用者须自行确保其使用行为符合**所在地法律法规**及所接入服务商的条款。因使用本项目产生的任何直接或间接后果，**由使用者自行承担**，作者不承担任何责任。
> - 请勿将本项目用于任何违法用途。
> - 软件按「原样」提供，不附带任何明示或暗示的担保。
>
> 完整条款见 [DISCLAIMER.md](DISCLAIMER.md)。
> VibeCoding 项目，Model:deepseek-v4.1-flash-1017，本人用了感觉还不错ovo
---

## 目录

- [特性](#特性)
- [它是怎么工作的](#它是怎么工作的)
- [快速开始](#快速开始)
  - [方式一：Cloudflare Dashboard（不装任何东西）](#方式一cloudflare-dashboard不装任何东西)
  - [方式二：Wrangler（推荐）](#方式二wrangler推荐)
  - [方式三：Cloudflare Pages](#方式三cloudflare-pages)
- [配置项](#配置项)
- [日常使用](#日常使用)
- [API 参考](#api-参考)
- [数据模型](#数据模型)
- [安全设计](#安全设计)
- [已知限制](#已知限制)
- [本地开发](#本地开发)
- [常见问题](#常见问题)
- [参与贡献](#参与贡献)
- [许可](#许可)

---

## 特性

### 给管理员

- **网页后台**，口令登录，不需要命令行
- **增删改查**：名称、原始链接、备注、启用/禁用、上下移调顺序
- **批量导入**：整段粘贴机场订阅（Base64 或明文自动识别），或直接填订阅 URL 让服务端去拉
- **自动去重**：按 URI 判断，重复导入不会翻倍
- **自动保存**：停止输入 700ms 后落盘，`Ctrl/Cmd + S` 可手动触发
- **一键复制**四种格式的订阅地址

### 给订阅者

| 出口 | 用途 |
| --- | --- |
| `/sub` | Base64 订阅，v2rayN / v2rayNG / NekoBox / Shadowrocket / Loon 通用 |
| `/sub?format=raw` | 明文，一行一个 URI，方便自己写脚本 |
| `/sub?format=clash` | 完整的 Clash / Mihomo 配置，带 proxy-groups 和 rules，导入即用 |
| `/sub?format=json` | 结构化 JSON |

### 技术侧

- **单文件**：`worker.js` 一个文件包含全部逻辑和两个页面，可以直接粘进 Cloudflare 的代码编辑器
- **零依赖**：不 import 任何 npm 包，没有构建步骤
- **KV 存储**：整份节点列表存一个 JSON，原子性好，读写都简单
- **Clash 转换是真的解析**，不是转发；解析失败的节点会被跳过而不是让整个订阅报错
- **防 SSRF**：服务端拉远程订阅时禁掉内网地址
- **常数时间比口令**：避免时序侧信道

### 支持转换的协议（Clash 出口）

`ss` `vmess` `vless` `trojan` `hysteria2` `tuic` `anytls`

传输层支持：`tcp` / `ws` / `grpc` / `h2` / `http` / `httpupgrade`
安全层支持：`none` / `tls` / `reality`
另外覆盖：SS 的 `obfs` / `v2ray-plugin` / `shadow-tls` 插件、VLESS 的 `flow`、Trojan 的 `alpn` / `fp`

> `/sub` 和 `/sub?format=raw` 是**原样直出**，不经过任何解析器，所以任何协议都不会在这里丢失。解析只发生在 Clash 出口。

---

## 它是怎么工作的

```
                    ┌──────────────────────┐
   管理员浏览器 ────▶│  /admin   (口令)      │
                    │  /api/store  (读写)   │──────┐
                    └──────────────────────┘      │
                                                  ▼
                                          ┌───────────────┐
                                          │   KV 存储     │
                                          │ sub_store_v1  │
                                          └───────────────┘
                                                  │
                    ┌──────────────────────┐      │
   订阅客户端   ────▶│  /sub  (公开/口令)    │◀─────┘
                    │  raw/base64/clash/json│
                    └──────────────────────┘
```

KV 里只有一个 key，值是整份节点数组的 JSON。管理员每次保存是**整份覆盖写**。订阅出口只读，从不解压、不写回。

这样设计的好处是：不存在「部分写入」导致数据损坏的可能，备份就是导出这一个 key。代价是并发编辑会互相覆盖——个人自用场景下这不构成问题。

---

## 快速开始

### 方式一：Cloudflare Dashboard（不装任何东西）

全程在网页上点，适合手上没有开发环境的场景。

1. **建 Worker**
   Cloudflare Dashboard → **Workers & Pages** → **Create** → **Worker** → 起个名字 → **Deploy**。

2. **建 KV**
   左侧 **Storage & Databases** → **KV** → **Create a namespace**，名字随意（例如 `sub-kv`）。

3. **绑定 KV**
   回到刚建的 Worker → **Settings** → **Bindings** → **Add** → **KV Namespace**：
   - **Variable name**：`SUB_KV` ← 必须一字不差
   - **KV namespace**：选第 2 步建的那个

4. **设管理员口令**
   **Settings** → **Variables and Secrets** → **Add** → 类型选 **Secret**：
   - Key：`ADMIN_TOKEN`
   - Value：一段强口令，例如 `openssl rand -hex 24` 的输出

5. **部署代码**
   回到 Worker → **Edit code**，把 [worker.js](worker.js) 的内容整段粘进去，覆盖默认代码 → **Deploy**。

6. **登录**
   访问 `https://<worker名>.<你的子域>.workers.dev/admin`，输口令。

> ⚠️ 第 3 步的变量名如果写成 `SUB_KV_`、`sub_kv`、`KV` 之类，后台会一直「保存失败」。这是最常见的坑。

### 方式二：Wrangler（推荐）

能版本管理，本地可调试。

```bash
git clone <你的仓库地址>
cd cf-sub
npm install -D wrangler@latest

# 1. 登录 Cloudflare
npx wrangler login

# 2. 创建 KV，记下输出里的 id
npx wrangler kv namespace create SUB_KV

# 3. 把 id 填进 wrangler.toml
#    [[kv_namespaces]]
#    binding = "SUB_KV"
#    id = "刚才拿到的 id"

# 4. 设置管理员口令（会提示你粘贴，不会进 git）
npx wrangler secret put ADMIN_TOKEN

# 5. 本地跑一下
npm run dev

# 6. 上线
npm run deploy
```

部署完成后地址是 `https://cf-sub.<你的子域>.workers.dev`。

> `wrangler.toml` 里的 `compatibility_date` 如果比你的 wrangler 版本还新，wrangler 会警告，改成一个过去的日期即可。

### 方式三：Cloudflare Pages

1. 新建 Pages 项目，把 `worker.js` 重命名为 `functions/_worker.js` 放进项目。
2. Pages 设置里绑定 KV，变量名同样叫 `SUB_KV`。
3. 加环境变量 `ADMIN_TOKEN`（选加密类型）。
4. 部署。

逻辑完全一致，只是入口位置不同。

---

## 配置项

| 名字 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `ADMIN_TOKEN` | Secret | **是** | — | 管理员口令。没设的话后台永远 401，但 `/sub` 仍可用 |
| `SUB_TOKEN` | Secret | 否 | 空 | 给订阅出口加一道口令。设了之后 `/sub` 必须带 `?token=xxx` |
| `ALLOW_REMOTE_IMPORT` | 变量 | 否 | `"true"` | 设成 `"false"` 禁止后台填 URL 让服务端拉订阅（手动粘贴仍可用） |
| `SUB_KV` | KV 绑定 | **是** | — | 存储绑定，名字必须完全一致 |

`ADMIN_TOKEN` 和 `SUB_TOKEN` 请务必用 **Secret**，不要写进 `wrangler.toml` 或代码里——那会进 git 历史。

---

## 日常使用

### 导入节点

三种方式，按顺手程度挑：

1. **批量导入 → 粘贴**：把机场订阅的原始内容整段粘进去。Base64 包裹的、明文的、每行一个 URI 的，都能识别。
2. **批量导入 → URL**：填订阅地址，服务端去拉。适合你有多个上游订阅、想定期同步的场景。
3. **新增节点 → 一次贴多行**：适合只加几个。

导入按 URI 去重。已经存在的节点不会重复添加，但你手动改过的名字会保留。

### 整理

- **改名字**：直接点名称就地编辑。留空的话订阅里会用 URI 里的 `#fragment`，再没有就用 `协议-地址`。
- **启停**：左侧开关。关掉的节点不会出现在任何订阅出口里，但数据还在。
- **排序**：`↑` `↓`。顺序就是订阅里的顺序。
- **编辑原始链接**：点「编辑」，里面还有个「备注」字段——只给自己看，不会进订阅。

### 客户端怎么填

| 客户端 | 填什么 |
| --- | --- |
| Clash Verge / Clash Meta / FlClash / Mihomo | `/sub?format=clash` |
| v2rayN / v2rayNG / NekoBox / Shadowrocket / Loon | `/sub` |
| sing-box（手动） | `/sub?format=raw` 后自己转 |
| 自己写脚本 | `/sub?format=json` |

---

## API 参考

所有管理接口接受三种认证方式，任选其一：

```
Authorization: Bearer <ADMIN_TOKEN>
X-Admin-Token: <ADMIN_TOKEN>
Cookie: cfsub_sess=<ADMIN_TOKEN>        # 网页后台用的
```

---

### `POST /api/login`

校验口令并下发 Cookie。

```json
// 请求
{ "token": "your-admin-token" }

// 200
{ "ok": true }

// 401
{ "ok": false, "error": "口令不正确" }
```

---

### `POST /api/logout`

清除 Cookie。

---

### `GET /api/store`

读取全部节点（含已禁用的）。

```json
{
  "ok": true,
  "version": 1,
  "updatedAt": "2026-11-04T14:05:44.000Z",
  "nodes": [
    { "id": "2b0c...", "name": "香港 01", "uri": "vless://...", "enabled": true, "remark": "" }
  ]
}
```

---

### `PUT /api/store`

整份覆盖写入。

```json
// 请求
{ "nodes": [ { "id": "...", "name": "...", "uri": "...", "enabled": true, "remark": "" } ] }

// 200
{ "ok": true, "version": 1, "updatedAt": "...", "count": 12 }
```

限制：节点数 ≤ 5000，每个 `uri` ≤ 8192 字符，`name` ≤ 200 字符且自动 trim。非法条目会被静默丢弃而不是整个请求失败。

---

### `POST /api/import`

从文本或 URL 导入。

```json
// 请求（二选一，都填时优先 url）
{ "text": "整段订阅内容" }
{ "url": "https://example.com/subscribe?token=..." }
{ "url": "...", "dryRun": true }    // 只解析不写入

// 200
{ "ok": true, "parsed": 20, "added": 18, "updated": 2, "total": 30 }
```

`dryRun` 时返回 `{ ok, dryRun: true, parsed, uris }`，可以拿来看解析结果。

错误码：`400` URL 不合法 / 内网地址 / 没解析出节点；`403` 服务端禁用了远程导入；`413` 内容超 2MB；`502` 上游拉取失败。

---

### `GET /api/meta`

运行时信息。

```json
{ "ok": true, "updatedAt": "...", "total": 30, "enabled": 28,
  "hasSubToken": true, "hasAdminToken": true, "allowRemoteImport": true }
```

---

### 订阅出口

```
GET /sub                         Base64
GET /sub?format=raw              明文
GET /sub?format=clash            Clash YAML
GET /sub?format=json             JSON
GET /sub?format=text             等同 raw
GET /sub?format=yaml             等同 clash
GET /sub?format=meta             等同 clash
```

如果设了 `SUB_TOKEN`，全部需要加 `?token=xxx`。

响应头里带两个非标准但有用的字段：

```
profile-update-interval: 12
x-node-count: 28
```

---

## 数据模型

KV 里只有一个 key：

```
key:   sub_store_v1
value: {
  "version": 1,
  "updatedAt": "2026-11-04T14:05:44.000Z",
  "nodes": [
    {
      "id": "2b0c...",        // 稳定标识，前端用来定位行
      "name": "香港 01",       // 订阅里的显示名
      "uri": "vless://...",    // 原始 URI，原样存储
      "enabled": true,         // false 则不出现在订阅里
      "remark": ""             // 仅自己可见
    }
  ]
}
```

### 备份与恢复

```bash
# 导出
npx wrangler kv key get --namespace-id=<你的KV id> "sub_store_v1" > backup.json

# 导入
npx wrangler kv key put --namespace-id=<你的KV id> "sub_store_v1" --path backup.json
```

或者在后台用 `/sub?format=json` 拉一份——不过那**只包含启用中的节点**，不是完整备份。

---

## 安全设计

### 已经做到的

| 措施 | 说明 |
| --- | --- |
| 常数时间比较 | 口令比对用 `safeEqual()`，不因提前返回泄露长度或前缀 |
| HttpOnly Cookie | 会话 Cookie 前端 JS 读不到，`SameSite=Strict` 挡 CSRF，HTTPS 下自动加 `Secure` |
| 一次性登录 URL | `/admin?token=xxx` 校验后立刻 302 到无 token 的地址，避免口令留在地址栏和 Referer |
| 防点击劫持 | `X-Frame-Options: DENY` |
| 防 Referer 泄露 | `Referrer-Policy: no-referrer` |
| 禁缓存 | 所有管理接口 `Cache-Control: no-store` |
| 防 SSRF | 服务端拉订阅时拒绝 `127.` `10.` `192.168.` `172.16-31.` `169.254.` `100.64-127.` `::1` `fc00::/7` `fe80::/10` 等 |
| 输入约束 | 导入体积 ≤ 2MB、节点数 ≤ 5000、字段长度截断 |
| 失败延迟 | 口令错误和未授权访问都加 150–400ms 延迟，抬高暴力破解成本 |

### 需要你自己权衡的

**`/sub` 默认是公开的。** 订阅链接一旦泄露，任何人都能拉到你的全部节点。介意的话：

- 设 `SUB_TOKEN`，链接变成 `/sub?token=xxx`。但它是**全局唯一**的一个口令，做不到一人一发。
- 想做「一人一口令、一人一份节点子集」，需要在 `handleSub()` 里加签名验证和用户表——这版没做。

**KV 里的节点是明文 JSON。** Cloudflare 员工理论上能访问你的 KV。真要更严格得自己做应用层加密，这版没做。

**Cloudflare 免费额度**：KV 每天读 10 万次、写 1000 次。你手动点点改改完全够。但注意**同一个 key 每秒最多写 1 次**——后台连续快速改动时理论上可能撞上，撞了会提示「保存失败」，再动一下就好。

---

## 已知限制

| 限制 | 原因 | 影响 |
| --- | --- | --- |
| KV 最终一致，跨区域最长约 60s | Cloudflare KV 的架构特性 | 异地订阅者可能晚几十秒才拿到新节点，同区域无延迟 |
| 单 key 每秒 1 次写 | Cloudflare KV 限制 | 高频编辑可能撞上，重试即可 |
| 整份覆盖写 | 设计取舍：保证原子性 | 多标签页同时编辑会互相覆盖，最后保存的赢 |
| 不做 SSR / ShadowsocksR | 协议已淘汰 | 这类节点在 Clash 出口会被跳过，`/sub` 里仍可用 |
| `SUB_TOKEN` 全局唯一 | 简化实现 | 无法按人分发 |
| Clash 转换是尽力而为 | URI 方言极其混乱 | 小众写法可能解析偏差；但原始 URI 出口不受影响 |
| 无分页 | 数据量假设很小 | 节点上千时后台页面会有点卡 |

---

## 本地开发

```bash
npm install -D wrangler@latest

# 起本地服务（默认 http://localhost:8787）
npm run dev

# 实时看线上日志
npm run tail
```

本地调试需要 `.dev.vars` 文件放 Secret（**已在 .gitignore 里**）：

```
ADMIN_TOKEN=dev-token-please-change
```

KV 绑定在 `wrangler dev` 下会自动创建本地模拟，不需要连真的 Cloudflare。

### 改界面的注意事项

后台页面在 `worker.js` 里的 `ADMIN_HTML` 常量中，用的是 `String.raw` 标签模板。改的时候有两条规矩：

1. **不要出现 `` `${` ``**。那是模板字符串插值语法，会直接被 JS 引擎求值然后报错。
2. **不要出现反引号**。会提前闭合模板字符串。

所以页面里的 JS 全部用字符串拼接，不用模板字符串。改的时候跟着这个风格走就行。

### 目录结构

```
cf-sub/
├── worker.js         # 全部逻辑：路由 + URI 解析 + Clash 生成 + 内嵌两个页面
├── wrangler.toml     # 部署配置
├── package.json      # npm scripts
├── README.md         # 本文档
├── DISCLAIMER.md     # 完整免责声明
├── LICENSE           # MIT
└── .gitignore
```

`worker.js` 内部分区：

| 区段 | 内容 |
| --- | --- |
| 常量 / 响应工具 | 各种 `xxxResponse()`、base64、`safeEqual` |
| KV 存储 | `loadStore()` / `saveStore()` / `normalizeNode()` |
| 认证 | Cookie 解析、`isAdmin()`、会话签发 |
| URI 解析器 | 每个协议一个 `parseXxx()`，输出 Clash proxy 对象 |
| YAML 序列化 | `yamlScalar()` / `yamlDump()` |
| 订阅渲染 | `renderRaw()` / `renderBase64()` / `renderClash()` |
| 导入解析 | `extractURIs()` / `mergeNodes()` |
| 路由 | `handleSub()` / `handleApi()` / `export default` |
| 页面 | `HOME_HTML` / `ADMIN_HTML` |

---

## 常见问题

<details>
<summary><b>后台能登录，但一直显示「保存失败」</b></summary>

KV 绑定名不是 `SUB_KV`，或者 KV 根本没创建。去 Worker 的 Settings → Bindings 检查**变量名**大小写和下划线。
</details>

<details>
<summary><b>`/api/login` 返回 500「服务端未设置 ADMIN_TOKEN」</b></summary>

Secret 没加，或者加成了普通变量但名字拼错了（比如 `ADMIN_TOEKN`）。
</details>

<details>
<summary><b>Clash 能导入，但节点列表是空的</b></summary>

去看 `/sub?format=raw`，确认原始 URI 本身是正常的。如果 raw 有内容而 clash 没有，说明是协议不被支持或者 URI 方言太特殊。Clash 出口会跳过解析失败的节点，不会让整份配置失效。
</details>

<details>
<summary><b>导入后节点数量比我预期少</b></summary>

去重是按 URI 做的。如果你的上游订阅里同一个节点的 URI 完全一致（比如只有 `#name` 不同但被规整掉），会被合并。
</details>

<details>
<summary><b>改了代码但线上没变</b></summary>

Dashboard 里改的代码必须点 **Deploy** 才生效。用 wrangler 的话记得 `npm run deploy`。
</details>

<details>
<summary><b>订阅里的节点顺序和我排的不一样</b></summary>

后台的上下移只改本地状态，要等右上角圆点变绿（或按 `Ctrl/Cmd + S`）才真正写进 KV。
</details>

<details>
<summary><b>能不用 KV 吗？</b></summary>

可以改 D1（SQL）或 Durable Objects，但 KV 对这个场景最合适：读多写少、单条目、免费额度够。改 D1 的话把 `loadStore()` / `saveStore()` 两个函数替换掉就行，其余逻辑不用动。
</details>

<details>
<summary><b>能加节点测速 / 延迟显示吗？</b></summary>

可以，但 Workers 没法直连你的节点做探测（协议不通用，且出站受限）。实际可行的做法是让客户端自己做 url-test——`/sub?format=clash` 里已经生成了 `♻️ 自动选择` 组。
</details>

---

## 参与贡献

欢迎提 Issue 和 PR。提交前请确认：

- 没有引入新的 npm 依赖（这个项目刻意保持零依赖）
- `worker.js` 仍然可以被直接粘贴到 Cloudflare Dashboard 部署
- 改动涉及 URI 解析时，请附上测试用的 URI 样例

---

## 许可

[MIT](LICENSE)

---

<div align="center">
<sub>

**再次提醒：本项目仅为技术演示，不提供任何节点或代理服务。请遵守所在地法律法规。**

</sub>
</div>
