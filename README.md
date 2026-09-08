# dsh-plugin-zen-useragent

> A DeepSeek Harness (DSH) plugin that lets provider-configured request headers
> (e.g. `User-Agent`) reach the `pi-ai` API requests, fixing the OpenCode ZEN
> free model `429 FreeUsageLimitError` / `400 MissingSessionID` by identifying
> requests as the opencode client instead of `deepseek-harness`.

修复 DSH 中 OpenCode ZEN 免费模型 `429 FreeUsageLimitError: Rate limit exceeded`
与 `400 MissingSessionID: OpenCode's free tier can only be used in OpenCode`
问题的插件。

## 原理

原生 `@deepseek-ai/dsh-llm-pi-ai` 的 `requestHeaders()` 会把与 attribution headers
冲突的自定义请求头（如 `User-Agent`）**过滤掉**，实际发给 API 的 always 是
`user-agent: deepseek-harness/0.1.0-rc.6 (+https://github.com/deepseek-ai/deepseek-harness)`。

OpenCode ZEN（`https://opencode.ai/zen/v1`）按客户端标识限流/鉴权：

- 请求头不是 `opencode/...` 就被当作未知客户端 → `429 FreeUsageLimitError`；
- UA 通过后若缺少 `x-opencode-session` 等身份头 → `400 MissingSessionID`
  （`OpenCode's free tier can only be used in OpenCode`）。

同一把 API Key 在 OpenCode TUI 里正常，在 DSH 里报错，就是这个原因。

本插件通过 `cordis.patch.yml` **禁用原生 `llm-pi-ai` 入口**，并插入一个指向插件
包装模块的新入口。包装模块在加载原模块**之前**给 `requestHeaders` 打补丁，然后
原样转发原模块导出。补丁幂等、每次启动自动执行，**DSH 升级后自动重新打补丁，
修复不会失效**。

### 补丁后的行为（v1.1.0）

补丁后的 `requestHeaders`：

1. 允许 provider 配置的 headers 覆盖 attribution（解决 429）；
2. 当合并后的 `User-Agent` 含 `opencode`（即该 provider 指向 opencode Zen/Go
   网关）时，**自动补全**缺失的 opencode 身份头（解决 400 MissingSessionID）：
   - `x-opencode-client: cli`
   - `x-opencode-project: global`
   - `x-opencode-session: ses_<…>` —— **进程内稳定**（同一 dsh 进程内所有会话
     复用同一值，重启 dsh 才重新生成）
   - `x-opencode-request: msg_<…>` —— 每次请求随机
3. **显式配置永远优先**：你在 provider headers 里手写了同名头，就按你写的来，
   自动补全不会覆盖。

## 安装

```bash
# 1. 安装 pnpm（如已有可跳过）
npm install -g pnpm

# 2. 安装插件到 web profile（推荐：从 GitHub 源）
dsh plugin --profile web add github:jiujiezongheti/zen-useragent

#    或从 npm 安装
dsh plugin --profile web add dsh-plugin-zen-useragent
```

**升级 v1.x 用户**：直接重装/更新插件后重启 DSH 即可。启动时会检测到旧 v1 补丁
并自动升级为 v2，日志打印 `upgraded: ...`，无需手动改动任何文件或配置。

## 启用

1. 确保 `settings.yaml`（`$DSH_HOME/settings.yaml`）里 opencodezen provider 配置
   了 `User-Agent`（DSH Web 的 Models 页面可直接编辑；也可直接改文件）：

   ```yaml
   llm-pi-ai:
     providers:
       opencodezen:
         displayName: opencode
         apiKeyEnv: OPENCODEZEN_API_KEY
         api: openai-completions
         baseURL: https://opencode.ai/zen/v1
         headers: { User-Agent: opencode/1.18.18, Referer: https://opencode.ai }
         models: [...]
   ```

   `x-opencode-*` 身份头**无需手写**——插件的自动补全会按上面的规则生成。

2. 重启 DSH Web（插件在启动时执行补丁，改配置/装插件后必须重启）。

3. 启动时终端会打印确认：
   ```
   [dsh-plugin-zen-useragent] upgraded: C:\...\dsh-llm-pi-ai\lib\index.js
   ```
   依次可能出现的状态：`patched`（从原生打补丁）、`upgraded`（v1 旧补丁升级为
   v2）、`already patched`（已是 v2）。若输出 `READONLY: ...` 或
   `WRITE FAILED: ...`，说明安装目录不可写，修复未生效（补丁失败不会中断启动，
   会回退为原生行为）——修复权限或改用本地安装。

### 想要会话 id 永久稳定？

不想要"进程内稳定"（重启 dsh 就换值），可以在 provider headers 里手写一个固定值，
自动补全会尊重它：

```yaml
headers:
  User-Agent: opencode/1.18.18
  Referer: https://opencode.ai
  x-opencode-session: ses_你的固定值
  x-opencode-client: cli
  x-opencode-project: global
  x-opencode-request: msg_dsh
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
  身份头）。
- 若 DSH 升级后函数结构变化导致"无法识别"，插件会打印
  `SKIPPED: unrecognized requestHeaders shape` 并保持不破坏新代码 —— 此时升级本插件即可。
- 补丁可靠性措施：
  - `requestHeaders` 的定位按**花括号配平**执行（跳过字符串、模板字符串与注释里
    的括号），函数体内出现行首闭合的嵌套对象也不会被截断写坏；
  - 替换结果写盘前做三重校验（旧特征行已消失、标记已存在、函数唯一），任一不满足
    即拒绝写盘（打印 `SKIPPED:`）;
  - 落盘采用**原子写**（同目录临时文件 + rename，Windows 上 rename 被占用时回退
    直接写），并发启动的进程不会读到写了一半的文件；
  - 目标只读或写入失败时打印 `READONLY:` / `WRITE FAILED:` 并跳过，**不会中断 DSH
    启动**，请求回退为原生行为。
- 补丁算法在 `lib/patch-core.js`（纯函数），单测见 `test/patch-core.test.mjs`，
  运行 `node test/patch-core.test.mjs`。