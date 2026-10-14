# 换用 CLI 型 UA 的评估记录

日期：2026-10-14
结论：**放弃**。发现过程与全部实测数据记录于此，避免将来重复调研或误判。

起因：`CODEBUDDY_MODEL` 与 `glm-5.1` 两处修复之后，`08-未完成事项.md` 只剩
「换 CLI 型 UA 拿更多模型列表」一项。评估过程中发现代价远超预期，且我最初的
判断（「收益 4 个模型，风险低」）是**只看清单、未逐字段对比元数据**得出的，
不完整。本文档记录完整的实测依据。

## 结论摘要

|                 | IDE 型 UA（现状）  | CLI 型 UA                      |
| --------------- | ------------------ | ------------------------------ |
| agent 数        | 15                 | 1（只有 `cli`）                |
| `models` 数组   | 22                 | 33                             |
| `data` 顶层字段 | 16                 | 5                              |
| 分派清单        | `craft` 15 个      | `cli` 18 个                    |
| 模型数          | 15                 | **18（+4）**                   |
| 思考档位        | 完整               | **5 个模型退化为单档**         |
| 输出上限        | 完整               | **7 个模型变小（最多 32 倍）** |
| `auto`          | 有（上游默认模型） | **无**                         |

**净变化：+4 个模型，−1 个 `auto`，5 个模型档位退化，7 个模型输出上限缩水。**

## 一、两个 UA 的本质区别

同一账号、同一端点 `GET /v3/config`，服务端按 `User-Agent` 判断请求来自哪个
客户端，返回**那个产品自己的配置**。CLI 那份**不是** IDE 配置的超集，是另一个
产品的配置，因此有增也有减。

|              | IDE 型                                  | CLI 型                          |
| ------------ | --------------------------------------- | ------------------------------- |
| UA 字符串    | `VSCode/1.119.0 CodeBuddy/4.9.29177644` | `CLI/2.164.0 CodeBuddy/2.164.0` |
| 扮演的客户端 | CodeBuddy IDE / 插件                    | CodeBuddy 命令行                |

`docs/07` 引用 Magpie 的注释印证同一点：

> Which product answers goes by the User-Agent: WorkBuddy sends `CLI/…`, and a
> bare `WorkBuddy/…` gets CodeBuddy IDE's config, with no `cli` agent.

### 现状：两条链路都用 IDE 型 UA

改动前 `src/models.ts:84` 与 `src/headers.ts:49` 是**同一个值**，整条链路自洽地
扮演 IDE 插件：

```
发现：GET  /v3/config          → VSCode/1.119.0 CodeBuddy/4.9.29177644
聊天：POST /v2/chat/completions → VSCode/1.119.0 CodeBuddy/4.9.29177644
```

## 二、响应结构差异

```
                       IDE 型 UA    CLI 型 UA
agents 数量                   15            1
models 数组长度               22           33
data 顶层字段数               16            5
```

CLI 响应缺少这 11 个字段（IDE 有）：

```
builtInMarketplaces, commands, completion, config, expKeys,
fillToolCallContentModelWhitelist, links, modelPromotions,
modelTiers, requestMaxStepLimit, tokenUsageThresholds
```

CLI 响应的 `data` 只有 5 个字段：

```
agents, enterpriseId, models, productFeatures, productFeaturesConfig
```

结论：CLI 响应是「瘦身版」，只给模型相关内容。本项目目前未使用那 11 个字段。

### `models` 条目的字段差异

| 仅 IDE 模型有   | 仅 CLI 模型有                |
| --------------- | ---------------------------- |
| `contextWindow` | `canDisableThinking`（顶层） |
| `isDefault`     | `summary`（顶层）            |
| `supportsExtra` |                              |

> 补充核实：CLI 的 `kimi-k2.8-preview` 同时有顶层 `canDisableThinking`/`summary`
> 与嵌套在 `reasoning` 内的同名字段——属重复而非平铺，`reasoning` 结构完整，
> 对本项目的解析无影响。

### IDE 响应的 15 个 agent

`craft` / `ask` / `plan` 各 15 个模型，其余是代码补全、提交信息、内联问答等
小 agent（1~2 个模型）。CLI 响应只有 `cli` 一个 agent。

## 三、模型清单差异（净 +4 −1）

### `models` 数组全量

```
IDE  22 个
CLI  33 个
交集 16 个
```

仅 IDE 有（6 个）：

```
auto, codewise-completions, codewise-default-model-v2,
codewise-jump, codewise-rewrite, nes-gf
```

仅 CLI 有（17 个）：

```
deepseek-v3-2-volc, default, glm-4.6, glm-4.6v, glm-4.7, glm-5.0,
glm-5.0-turbo, glm-5v-turbo, hunyuan-chat, hunyuan-image-alpha-edit,
hy4-preview-x, kimi-k2-thinking, kimi-k2.5, kimi-k2.6, kimi-k2.7,
minimax-m2.5, minimax-m2.7
```

### 实际分派清单（本项目取的就是这个）

```
craft agent 15 个
cli   agent 18 个
交集 14 个

仅 craft 有：auto
仅 cli   有：glm-5v-turbo, kimi-k2.6, kimi-k2.7, minimax-m2.7
```

### 新增的 4 个模型（完整字段）

四个都是 `onlyReasoning: true`、`supportsImages: true`、`supportsToolCall: true`，
`reasoning` 都只有 `{"effort":"medium","summary":"auto"}`（无 `supportedEfforts`）
——即走 `c45c884` 建立的 `effort` 单档兜底路径。

| 模型           | 名称           | 上下文 | 输出上限 | credits |
| -------------- | -------------- | ------ | -------- | ------- |
| `glm-5v-turbo` | GLM-5v-Turbo   | 200000 | 64000    | x0.71   |
| `kimi-k2.6`    | Kimi-K2.6      | 256000 | 32000    | x0.52   |
| `kimi-k2.7`    | Kimi-K2.7-Code | 256000 | 32000    | x0.57   |
| `minimax-m2.7` | MiniMax-M2.7   | 200000 | 48000    | x0.19   |

> `kimi-k2.6` 的 `relatedModels` 指向 `kimi-k2.5` / `kimi-k2-thinking`
> （这两个都不在 `cli` 分派清单里）。

### 会丢失的 `auto`

```json
{
  "id": "auto",
  "name": "Auto",
  "isDefault": true,
  "descriptionZh": "平衡效果与速度。自动为每个任务匹配最优模型，积分倍率随之浮动",
  "maxInputTokens": 256000,
  "maxOutputTokens": 32000,
  "onlyReasoning": true,
  "reasoning": { "effort": "high", "summary": "auto" },
  "supportsImages": true,
  "supportsReasoning": true,
  "supportsToolCall": true,
  "tags": ["craft"]
}
```

**`auto` 完全不在 CLI 响应里**——连 `models` 数组都没有：

```
CLI models 数组有 auto:            False
CLI 任何 agent 引用 auto:          False
```

它是上游 `isDefault: true` 的模型，也是本项目 `DEFAULT_MODEL` 的值
（`src/models.ts`）。用户已决定不要它。

实测：`auto` 用 CLI 型 UA **仍可调用**（HTTP 200），只是发现不到。

## 四、同一模型的元数据退化（关键代价）

14 个共同模型的字段全部有差异，但其中 14 个都有的 `credits` 只是格式差异
（`x0.17` vs `x0.17 credits`，本项目未使用该字段）。**真正影响本项目的差异
出现在 12 个模型上**（只有 `space-bunny` 与 `glm-5.1` 仅 `credits` 不同）：

### 4.1 思考档位退化

| 模型                                   | IDE `craft`               | CLI `cli`            | 结果            |
| -------------------------------------- | ------------------------- | -------------------- | --------------- |
| `hy3`                                  | 词表 `low/high`           | 只有 `effort=high`   | **2 档 → 1 档** |
| `hy3-x`                                | 词表 `low/high`           | 只有 `effort=high`   | **2 档 → 1 档** |
| `glm-5.3`                              | 词表 `low/high/max`       | 只有 `effort=medium` | **3 档 → 1 档** |
| `glm-5.2`                              | 词表 `high/xhigh`         | 只有 `effort=medium` | **2 档 → 1 档** |
| `deepseek-v4-pro`                      | 词表 `low/high/xhigh`     | 只有 `effort=high`   | **3 档 → 1 档** |
| `kimi-k2.8-preview`                    | `low/medium/high`         | `low/high/max`       | 档位集合不同    |
| `step-5-preview`                       | `defaultEffort=medium`    | `defaultEffort=high` | 默认档变了      |
| `glm-5.3-flash`                        | `canDisableThinking=true` | `=false`             | 变成不可关思考  |
| `hy4-preview`                          | 词表 `high`               | 词表 `high`          | 相同            |
| `deepseek-v4.1-flash`                  | 词表 `low/high/max`       | 同左                 | 相同            |
| `space-bunny`                          | 全档位                    | 同左                 | 相同            |
| `glm-5.1` / `kimi-k3-1` / `minimax-m3` | `effort=medium`           | 同左                 | 相同            |

**原因**：CLI 那份配置对这几个模型不带 `supportedEfforts`，只给一个 `effort`。
本项目的 `buildThinkingLevelMap`（`c45c884`）在「只有 `effort`」时**只暴露那一档**，
因此 Pi 的 `/thinking` 里会看不到其他档位。

**重要澄清**：这些模型上游**实际接受多个档位**（此前实测 `hy3` 发 `medium`、
`banana` 均返回 200）。所以这是**元数据声明变少，不是能力变少**。但本项目依据
声明工作，故 UI 上确实体现为退化。

### 4.2 输出上限缩水（影响 Pi 的 `maxTokens`）

CLI 侧明显更小，7 个模型受影响：

| 模型                  | IDE     | CLI    |
| --------------------- | ------- | ------ |
| `deepseek-v4.1-flash` | 393216  | 128000 |
| `deepseek-v4-pro`     | 393216  | 128000 |
| `glm-5.3`             | 131072  | 64000  |
| `glm-5.2`             | 131072  | 64000  |
| `kimi-k2.8-preview`   | 131072  | 64000  |
| `minimax-m3`          | 524288  | 64000  |
| `kimi-k3-1`           | 1048576 | 32000  | ← 差 32 倍 |

输入上限也有变动：

| 模型          | IDE     | CLI    |
| ------------- | ------- | ------ |
| `hy4-preview` | 1000000 | 960000 |

Pi 用 `maxOutputTokens` 作 `maxTokens`、`maxAllowedSize`/`maxInputTokens` 作
`contextWindow`，因此这会压低单次回复上限与上下文窗口。

### 4.3 其他字段差异（对本项目无影响）

- `credits` 格式：IDE `x0.17` vs CLI `x0.17 credits`——**14 个模型全都不同**，
  但本项目未使用该字段
- `onlyReasoning`：`deepseek-v4-pro`、`glm-5.2` 由 `false → true`
  （本项目未使用该字段）
- `step-5-preview` 的 credits：`x0.43 → x0.00`
- `space-bunny` 与 `glm-5.1` 除 `credits` 格式外**无其他差异**

## 五、UA 校验行为（实测）

网关对 UA 有感知，**格式**校验但**版本号**不校验：

| UA                                        | 结果                                                           |
| ----------------------------------------- | -------------------------------------------------------------- |
| `CLI/2.164.0 CodeBuddy/2.164.0`           | ✅ `cli` 18 个                                                 |
| `CLI/4.9.29177644 CodeBuddy/4.9.29177644` | ✅ `cli` 18 个                                                 |
| `CLI/1.0.0 CodeBuddy/1.0.0`               | ✅ `cli` 18 个                                                 |
| `CLI/999.0.0 CodeBuddy/999.0.0`           | ✅ `cli` 18 个                                                 |
| `CLI/2.0.0 WorkBuddy/5.5.6`               | ✅ `cli` 18 个（`models` 数组 60 个）                          |
| `codebuddy-cli/2.164.0`                   | ❌ `400 code 12403 check ua, get coding copilot version error` |
| `totally-unknown-client/1.0`              | ❌ `400 code 12403`                                            |

故可用本项目已有的 `APP_VERSION` 常量拼接，无需引入新的版本号。

### `X-Agent-Intent` 与 `X-IDE-*` 对 `/v3/config` 无影响

UA 固定为 CLI 型时，逐一变更这些头，结果都是 `cli` 18 个：

```
X-Agent-Intent=craft / cli / 不设        → cli 18
X-IDE-Type=WorkBuddy, X-IDE-Name=WorkBuddy → cli 18
X-IDE-* 全部置空                          → cli 18
```

**只有 UA 决定返回哪个产品的配置。**

## 六、发现 ≠ 调用（此前的判断需要更正）

`docs/07` 曾记录「17 个仅 CLI 模型只有 10 个可用」，据此提出「先试调用再注册」。
本次复核发现那个结论**来自 `models` 全量数组（33 个，含大量旧型号）**，
而本项目取的是 **`cli` agent 分派清单（18 个）**：

```
cli agent 清单 18 个，用 IDE 型 UA 逐个调用 → 18/18 全部返回 200
且这 18 个在 models 数组里都有完整详情（无「缺详情」的）
```

不在 `cli` 清单里的那些（`glm-4.6`、`glm-4.7`、`hy4-preview-x`、
`kimi-k2-thinking`、`minimax-m2.5`、`hunyuan-image-alpha-edit`）**确实不可用**
（`400 code 11102`，图像模型报 `11103`），但它们**本就不会被分派给用户**
——所以「试调用再注册」是不必要的。

## 七、评估过的方案与舍弃原因

| 方案 | 做法                                        | 结果                                         | 结论                        |
| ---- | ------------------------------------------- | -------------------------------------------- | --------------------------- |
| A    | 只用 CLI 型 UA                              | 18 个模型，但档位退化 + 输出缩水 + 丢 `auto` | **代价过大**                |
| B    | 两次发现合并（IDE + CLI），IDE 侧元数据优先 | 19 个模型且元数据完整                        | 逻辑变复杂，收益仅 4 个模型 |
| C    | 保持 IDE 型 UA                              | 15 个模型，元数据完整                        | **最终选择**                |
| D    | CLI 发现 + IDE 补元数据                     | 同 B                                         | 同 B                        |

### 方案 A 曾短暂实现并回退

评估中把 `src/models.ts` 的发现 UA 改为 CLI 型并跑通（测试通过），
同时发现一个**设计上不自洽**的问题：

```
发现：扮演 CodeBuddy CLI
聊天：扮演 CodeBuddy IDE（src/headers.ts 未动）
```

这样改的理由是「实测 CLI 型 UA 发现的模型用 IDE 型 UA 也能调用，故只改一处、
风险最小」。但**链路的客户端身份不一致本身是隐患**——上游若将来加一致性校验
就会失效。且此时才发现**逐字段对比的代价（第四、五节）远超最初判断**，
故**全部回退**（`git checkout -- src/models.ts test/models.test.ts`），
未产生任何提交。

## 八、另一个被否掉的方向：`CODEBUDDY_CLI_PATH`

评估早期曾考虑「让用户指定官方 CLI 的安装路径，从 `product.*.json` 读模型列表」。
**该方向只停留在讨论，未写入代码，也未提交**（仓库中无 `CODEBUDDY_CLI_PATH`，
`git log -S` 无记录）。它在发现 UA 差异后失效：

- `product.internal.json`（32 个）等本地静态表**不是** `/v3/config` 的替代
- 这些文件里的模型，`/v3/config` 用 CLI 型 UA 都能拿到
- 依赖用户安装 181 MB 的 CLI 包不成比例

详见 `docs/07`。

## 九、若将来重新评估

1. **先逐字段对比元数据**，不要只看模型数量。本次教训即在此：
   清单层面是「+4」，元数据层面却付出 5 个档位退化 + 7 个输出缩水的代价。
2. **`auto` 无法通过 CLI 型 UA 获得**，它只在 IDE 型 UA 下返回。
   若需要它，只能走方案 B（两次发现合并）。
3. **方案 B 是唯一能兼顾两者的路径**，但要多一次只读请求与一套合并逻辑；
   收益是 4 个模型（`glm-5v-turbo` / `kimi-k2.6` / `kimi-k2.7` / `minimax-m2.7`）。
4. **UA 格式会被校验**（`12403`），不得随意拼接。
5. 需要个别模型时，用 `CODEBUDDY_MODEL` 直接指定即可，无需改动代码：

```bash
CODEBUDDY_MODEL=glm-5v-turbo pi
```

## 附：数据来源

本文档的所有数字来自 2026-10-14 用真实凭据对 `https://copilot.tencent.com/v3/config`
的两次请求（IDE 型 / CLI 型 UA 各一次），原始响应存于：

```
/tmp/ua-ide.json
/tmp/ua-cli.json
```

调用可用性来自对 `POST /v2/chat/completions` 的逐个实测（`stream: true`）。
