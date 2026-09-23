# dsh-plugin-zen-useragent

> A DeepSeek Harness (DSH) plugin that lets provider-configured request headers
> (e.g. `User-Agent`) reach the `pi-ai` API requests, fixes the OpenCode ZEN
> free model `429 FreeUsageLimitError` / `400 MissingSessionID` / `403
> Generation.FreeTierError` by identifying requests as the opencode client
> instead of `deepseek-harness`.

修复 DSH 中 OpenCode ZEN 免费模型 `429 FreeUsageLimitError: Rate limit exceeded`
、`400 MissingSessionID: OpenCode's free tier can only be used in OpenCode`
与 `403 Generation.FreeTierError` 等问题的插件。

> ⚠️ **已知限制（首次安装 / DSH 升级后务必重启一次）**：DSH 的 loader 并行导入
> 各入口模块，全新安装后的**第一次启动**（或 DSH 升级把补丁文件还原后的第一次
> 启动），若原生 `llm-pi-ai` 恰好先于本插件读到未补丁的文件，该次启动仍按原生
> 行为运行；补丁当次落盘，**重启 DSH 后生效**。此后每次启动日志显示
> `already patched`，零额外开销。判断标准：启动日志出现 `patched:` /
> `upgraded:` 时建议再重启一次确认生效；出现 `already patched` 即为生效状态。

## 原理

原生 `@deepseek-ai/dsh-llm-pi-ai` 的 `requestHeaders()` 会把与 attribution headers
冲突的自定义请求头（如 `User-Agent`）**过滤掉**，实际发给 API 的 always 是
`user-agent: deepseek-harness/0.1.0-rc.6 (+https://github.com/deepseek-ai/deepseek-harness)`。

OpenCode ZEN（`https://opencode.ai/zen/v1`）按客户端标识限流/鉴权。

本插件对两处做补丁：

1. **请求头**（`@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 的 `requestHeaders`）：
   允许 provider 配置的 headers 覆盖 attribution，并对指向 opencode 的请求自动
   补全 opencode 身份头；
2. **请求体**（`@earendil-works/pi-ai/api/openai-completions` 的
   `buildParams`）：向 OpenCode Zen 网关的请求 `body.tools` 里自动追加一个
   名为 `bash` 的**空壳工具**。

### 为什么 body.tools 里必须有 bash？

ZEN 网关对免费档的请求有几个判定条件：

- 请求带 opencode 会话头（`x-session-id` / `x-session-affinity` /
  `x-opencode-session` 任一即可，值任意）；
- 请求 `body.tools` 数组里**必须包含一个名为 `bash` 的函数工具**（数量不限、
  其它工具名不限、描述不限）。

DSH 自带的工具集里**没有 `bash`**（默认 26 个工具里只有 edit/glob/grep/read/
skill/write 六个 opencode 官方名，缺少网关要求的 bash），因此请求恒被网关
判为「非 opencode 客户端」→ `403 Generation.FreeTierError`。本插件在 pi-ai
发送前把 `{ name: "bash", description: "…仅供网关校验，不要真正调用…" }` 追加到
tools 数组末尾（若已存在则不重复追加；非 opencode 网关完全不改）。

### 补丁后的行为（v1.4.0）

**请求头补丁**（`requestHeaders`）：

1. 允许 provider 配置的 headers 覆盖 attribution（解决 429）；
2. 当合并后的 `User-Agent` 含 `opencode`（即该 provider 指向 opencode Zen/Go
   网关）时，**自动补全**缺失的 opencode 身份头（解决 400/403），并据此把请求
   伪装成真正的 `opencode` 深度求索（DeepSeek-Harness）客户端：
   - `x-opencode-client: cli`
   - `x-opencode-session: ses_<…>` —— **进程内稳定**（同一 dsh 进程内所有会话
     复用同一值，重启 dsh 才重新生成），结构为 `ses_` + 12 位小写 hex +
     14 位字母数字（`ses_[0-9a-f]{12}[0-9A-Za-z]{14}`）
   - `x-opencode-request-id: msg_<…>` —— 每次请求随机，结构为 `msg_` + 12 位
     小写 hex + 14 位字母数字（`msg_[0-9a-f]{12}[0-9A-Za-z]{14}`）
3. 头名与格式都严格对齐真实 opencode CLM 客户端（网关逐位校验）：
   - 请求头名是 `x-opencode-request-id`（不是 `x-opencode-request`）；
   - **不注入** `x-opencode-project`（真实 CLM 客户端不带这个头）。
4. **显式配置永远优先**：你在 provider headers 里手写了同名头，就按你写的来，
   自动补全不会覆盖。

**请求体补丁**（`openai-completions` 的 `buildParams`）：

1. 仅对 provider 名为 `opencodezen` 或 baseUrl 含 `opencode` 的请求生效；
2. tools 里没有 `bash` 时追加一个 bash 空壳（放在数组末尾，不影响原有工具）；
3. 幂等 —— bash 已存在则不重复追加。

## 原理（v1.4.0 实现）

同一把 API Key 在 OpenCode TUI 里正常，在 DSH 里报错，就是这个原因。

本插件的 `cordis.patch.yml` **不改动原生 `llm-pi-ai` 入口**（保持唯一、直接挂载，
因此 DSH 模型页 —— ConfigEditor —— 可以正常增删改 provider；这是 v1.4.0 的核心
修复，旧版「禁用原生行 + 插入同名包装行」会造成两条 `llm-pi-ai` 行，模型页任何
写入都会报 `Configuration for "llm-pi-ai" is overridden by a home patch or command-line overlay`），
而是**额外插入一个独立入口 `zen-useragent`**，该模块每次启动时对磁盘上的
`requestHeaders` 与 pi-ai `openai-completions` 幂等落盘补丁，原生模块加载时读到的
就是已补丁的文件。补丁失败不会中断启动，会回退为原生行为。

时序与生效：见顶部「已知限制」—— 安装/升级后重启一次确认生效；DSH 升级会
自动重新打补丁，修复不会因升级而失效。

## 安装

```bash
# 1. 安装 pnpm（如已有可跳过）
npm install -g pnpm

# 2. 安装插件到 web profile（推荐：从 GitHub 源）
dsh plugin --profile web add github:jiujiezongheti/zen-useragent

#    或从 npm 安装
dsh plugin --profile web add dsh-plugin-zen-useragent
```

**升级 v1/v2/v3/v4 用户**：直接重装/更新插件后重启 DSH 即可。启动时会检测到旧
补丁并自动升级，日志打印 `upgraded: ...` 或 `patched: ...`，无需手动改动任何文件或配置。

## 启用

1. 配置 opencodezen provider。DSH 的 provider 配置现在位于 profile 层的
   `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），不再是旧的
   `settings.yaml`。v1.4.0 起插件**不再内置默认 provider**，需要在 profile 层配置
   一个指向 opencode 网关的 provider（headers 必须带 `User-Agent` —— 解决 429
   必需）：

   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         opencodezen:
           displayName: opencode
           apiKeyEnv: OPENCODEZEN_API_KEY
           api: openai-completions
           baseURL: https://opencode.ai/zen/v1
           headers: { User-Agent: opencode/1.18.18, Referer: https://opencode.ai }
           models: [...]
   ```

   对应 API Key 放在 `$DSH_HOME/.credentials.yaml`（web profile 下即
   `C:\Users\...\.dsh\.credentials.yaml`）。

2. `x-opencode-*` 身份头**无需手写**——插件的自动补全会按上面的规则生成。

3. 重启 DSH Web（插件在启动时执行补丁，改配置/装插件后必须重启；全新安装的
   第一次启动若日志显示 `patched` / `upgraded`，建议再重启一次确认生效）。

4. 启动时终端会打印两条确认：
   ```
   [dsh-plugin-zen-useragent] upgraded: C:\...\dsh-llm-pi-ai\lib\index.js
   [dsh-plugin-zen-useragent] patched: C:\...\@earendil-works\pi-ai\dist\api\openai-completions.js
   ```
   依次可能出现的状态：`patched`（从原生打补丁）、`upgraded`（旧补丁升级）、
   `already patched`（已是新版）。若输出 `READONLY: ...` 或 `WRITE FAILED: ...`，
   说明安装目录不可写，修复未生效（补丁失败不会中断启动，会回退为原生行为）
   ——修复权限或改用本地安装。若缺第二条（`could not locate ... pi-ai`），说明
   pi-ai 路径变化，tools 补丁未生效（仅请求头补丁生效）。

### 想要会话 / 请求 id 永久稳定？

不想要"进程内稳定"（重启 dsh 就换值），可以在 provider headers 里手写固定值，
自动补全会尊重它们（注意固定值也要符合网关校验格式，否则可能 400/403）：

```yaml
headers:
  User-Agent: opencode/1.18.18
  Referer: https://opencode.ai
  x-opencode-session: ses_0123456789abCDEFGHIJKLMNOP
  x-opencode-client: cli
  x-opencode-request-id: msg_abcdef012345uvwxyzABCDEFGH
```

## 验证

重启后切到 opencode 免费模型发一条消息，如不再 429 / 400 即成功。
终端日志出现 `already patched` 表示此前已被补丁，无需重复操作。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-zen-useragent
```

卸载后需要重启 DSH，且被补丁的文件会保留（无害：只是允许自定义请求头覆盖
attribution、并自动补全 opencode 身份头）。如需彻底还原，可重装最新版 DSH。

## 备注

- 补丁只影响「provider 显式配置了同名请求头」或「请求带 opencode UA」的情况；
  未配置 headers 的 provider 行为与原生完全一致（非 opencode UA 也不会注入
  身份头）。tools 补丁只影响 provider 名为 `opencodezen` 或 baseUrl 含
  `opencode` 的请求。
- 若 DSH 升级后函数结构变化导致"无法识别"，插件会打印
  `SKIPPED: unrecognized requestHeaders shape`（或 pi-ai 的
  `SKIPPED: unrecognized tools shape`）并保持不破坏新代码 —— 此时升级本插件即可。
- 补丁可靠性措施：
  - `requestHeaders` 的定位按**花括号配平**执行（跳过字符串、模板字符串与注释里
    的括号），函数体内出现行首闭合的嵌套对象也不会被截断写坏；
  - pi-ai `openai-completions` 的替换锚点选取 `buildParams` 主分支的唯一文本
    （`if (activeTools && activeTools.length > 0) {` 之后的首个
    `params.tools = convertTools(activeTools, compat);`），替换后做三重校验
    （新标记存在、原生结构保留、周边未破坏）；
  - 替换结果写盘前做三重校验（旧特征行已消失、标记已存在、函数唯一），任一不满足
    即拒绝写盘（打印 `SKIPPED:`）;
  - 落盘采用**原子写**（同目录临时文件 + rename，Windows 上 rename 被占用时回退
    直接写），并发启动的进程不会读到写了一半的文件；
  - 目标只读或写入失败时打印 `READONLY:` / `WRITE FAILED:` 并跳过，**不会中断 DSH
    启动**，请求回退为原生行为。
- 补丁算法在 `lib/patch-core.js`（纯函数），单测见 `test/patch-core.test.mjs`，
  运行 `node test/patch-core.test.mjs`。