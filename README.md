# dsh-plugin-zen-useragent

> A DeepSeek Harness (DSH) plugin that lets provider-configured request headers
> (e.g. `User-Agent`) reach the `pi-ai` API requests, fixing the OpenCode ZEN
> free model `429 FreeUsageLimitError` by identifying requests as the opencode
> client instead of `deepseek-harness`.

修复 DSH 中 OpenCode ZEN 免费模型 `429 FreeUsageLimitError: Rate limit exceeded` 问题的插件。

## 原理

原生 `@deepseek-ai/dsh-llm-pi-ai` 的 `requestHeaders()` 会把与 attribution headers
冲突的自定义请求头（如 `User-Agent`）**过滤掉**，实际发给 API 的 always 是
`user-agent: deepseek-harness/0.1.0-rc.6 (+https://github.com/deepseek-ai/deepseek-harness)`。

OpenCode ZEN（`https://opencode.ai/zen/v1`）按客户端标识限流：请求头不是
`opencode/...` 就被当作未知客户端 → 返回 429。同一把 API Key 在 OpenCode TUI 里
正常，在 DSH 里 429，就是这个原因。

本插件通过 `cordis.patch.yml` **禁用原生 `llm-pi-ai` 入口**，并插入一个指向插件
包装模块的新入口。包装模块在加载原模块**之前**给 `requestHeaders` 打补丁，让配置的
headers 覆盖 attribution，然后原样转发原模块导出。补丁幂等、每次启动自动执行，
**DSH 升级后自动重新打补丁，修复不会失效**。

## 安装

```bash
# 1. 安装 pnpm（如已有可跳过）
npm install -g pnpm

# 2. 安装插件到 web profile（推荐：从 GitHub 源）
dsh plugin --profile web add github:jiujiezongheti/zen-useragent

#    或从 npm 安装
dsh plugin --profile web add dsh-plugin-zen-useragent
```

## 启用

1. 确保 `settings.yaml`（`$DSH_HOME/settings.yaml`）里 opencodezen provider 配置了
   请求头（DSH Web 的 Models 页面可直接编辑不保存的部分）：

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

2. 重启 DSH Web：`dsh web`（安装插件后必须重启才会加载新的 bundle 层）。

3. 启动时终端会打印一行确认：
   ```
   [dsh-plugin-zen-useragent] patched: C:\...\dsh-llm-pi-ai\lib\index.js
   ```

## 验证

重启后切到 opencode 免费模型发一条消息，如不再 429 即成功。
终端日志出现 `already patched` 表示此前已被补丁，无需重复操作。

## 卸载

```bash
dsh plugin --profile web remove dsh-plugin-zen-useragent
```

卸载后需要重启 DSH，且被补丁的文件会保留（无害：只是允许自定义请求头覆盖
attribution）。如需彻底还原，可删除 `requestHeaders` 里的补丁标记行并重启，
或重装最新版 DSH。

## 备注

- 补丁只影响「provider 显式配置了同名请求头」的情况；未配置 headers 的 provider
  行为与原生完全一致。
- 若 DSH 升级后函数结构变化导致"无法识别"，插件会打印
  `SKIPPED: unrecognized requestHeaders shape` 并保持不破坏新代码 —— 此时升级本插件即可。