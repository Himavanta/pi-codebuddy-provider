# pi-codebuddy-provider

把腾讯 CodeBuddy（IOA 编程助手）接入 [Pi](https://github.com/earendil-works/pi) 的扩展，
将 CodeBuddy 注册为 OpenAI 兼容的 HTTP provider。

> 非官方扩展。通过模拟 CodeBuddy IDE 客户端的 HTTP 接口工作，上游接口变化时可能失效。

## 安装

```bash
pi install git:github.com/Himavanta/pi-codebuddy-provider
```

需要 Pi 与一个可用的 CodeBuddy / IOA 账号。

## 认证

- **OAuth** — 在 Pi 中执行 `/login codebuddy`，按提示在浏览器完成 IOA 登录
- **API Key** — 设置环境变量 `CODEBUDDY_API_KEY`

`CODEBUDDY_AUTH` 决定使用哪一种，默认 `auto`：有 key 用 key，否则用 OAuth。

凭据由 Pi 持久化到 `~/.pi/agent/auth.json`。本扩展另存一份快照到
`~/.pi/agent/codebuddy-auth.json`，供请求时读取。

## 配置

常用环境变量：

| 变量                 | 默认值     | 说明                                                                          |
| -------------------- | ---------- | ----------------------------------------------------------------------------- |
| `CODEBUDDY_NETWORK`  | `internal` | `internal` / `ioa` 走 `copilot.tencent.com`，`internet` 走 `www.codebuddy.ai` |
| `CODEBUDDY_AUTH`     | `auto`     | `auto` / `oauth` / `api`                                                      |
| `CODEBUDDY_API_KEY`  | 空         | API Key 模式的密钥                                                            |
| `CODEBUDDY_ENDPOINT` | 空         | 自定义端点，设置后忽略 `CODEBUDDY_NETWORK`                                    |
| `CODEBUDDY_MODEL`    | 空         | 覆写请求中的模型 ID，见下方「指定任意模型」                                   |

其余为调优项（重试次数、思考泄漏开关、身份覆盖、会话 ID 缓存上限等），
见 [`src/config.ts`](./src/config.ts)。

## 功能

**模型与能力**

- 启动和登录后拉取 `/v3/config`，把 craft agent 的模型清单注册给 Pi，
  并缓存到 `~/.pi/agent/codebuddy-models-cache.json` 作为下次启动的种子。
- 推理能力与图片输入优先采信上游的 `supportsReasoning` / `supportsImages`，
  字段缺失时才回退到模型 ID 猜测。
- 思考档位按上游 `supportedEfforts` 生成 `thinkingLevelMap`，不支持的档位显式置空。

**请求处理**

- 认证头由 fetch 拦截器统一注入，OAuth 模式附带从 JWT 解析的租户 / 企业 / 用户头。
- OAuth 模式遇到 401/403 时刷新 token 并重发一次；刷新失败后进入 15 秒冷却。
- 429 时按 `Retry-After` 就地等待重发，超出预算则合成可读的错误 body，
  并区分「可重试」与「配额超限」两种文案。
- 上游偶发把瞬时校验失败包装成 400（code 11133），对此按 1s / 4s / 10s / 25s 退避重发。

**思考泄漏归一**

部分模型会把思考草稿混进 `delta.content`，并在结尾留下 `</think:会话id>` 标记。
扩展在 SSE 层把标记之前的文本改道到 `reasoning_content`，并将标记本身删除。
默认开启，可用 `CODEBUDDY_LEAKED_REASONING=0` 关闭。

## 模型列表

扩展启动时从 `/v3/config` 取 craft agent 的模型清单。这个清单不一定等于
CodeBuddy 的完整模型列表：部分模型（如 `glm-5v-turbo`、`kimi-k2.6`）
接口不返回，因此不会出现在 Pi 的模型选择里。

这类模型可以用 `CODEBUDDY_MODEL` 强制指定，见下节。

## 指定任意模型

设置 `CODEBUDDY_MODEL` 可强制用指定模型，即使它不在模型列表里：

```bash
CODEBUDDY_MODEL=glm-5v-turbo pi
```

该值会覆写请求体中的 `model` 字段（网关按此字段选模型）。
注意：Pi 界面上仍会显示当前选中的模型，与实际发往上游的模型不一定一致。
模型 ID 无效时，上游会返回 `400`，错误信息为 `model [...] service info not found`。

## 已知限制

- 非官方扩展，依赖模拟 IDE 客户端行为，上游改动可能导致失效。
- token 过期会自动刷新；仅当刷新失败时才需要重新 `/login codebuddy`，此时日志会提示。
- 模型缓存不会自愈：只作为启动种子，需要一次成功的网络发现才会更新。
- 模型列表不含 CodeBuddy 的全部可用模型，详见「模型列表」。
- 429 与瞬时 400 的处理是尽力而为，不覆盖上游所有错误形态。

## 开发

```bash
vp install    # 安装依赖
vp test       # 运行测试
vp check      # 格式化 + lint + 类型检查
```

## 致谢

本项目的代码与设计来源于以下仓库：

- [SoulChildTc/pi-codebuddy-oauth](https://github.com/SoulChildTc/pi-codebuddy-oauth) —
  Pi 扩展前身，已停止维护
- [minglo/opencode-codebuddy-oauth](https://github.com/minglo/opencode-codebuddy-oauth) —
  核心实现来源
- [HunkYuan/opencode-codebuddy-plugin](https://github.com/HunkYuan/opencode-codebuddy-plugin) —
  设计灵感

完整的版权与许可信息见 [LICENSE](./LICENSE)。

## 许可证

[MIT](./LICENSE)
