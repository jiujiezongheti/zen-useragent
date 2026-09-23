/**
 * dsh-plugin-zen-useragent
 *
 * 独立补丁入口（通过 cordis.patch.yml 插入的 zen-useragent 行挂载）。
 *
 * 原生 dsh-llm-pi-ai 的 `requestHeaders` 会把与 attribution headers 冲突的
 * 自定义请求头（如 User-Agent）过滤掉，因此 provider 配置的
 * `headers: { User-Agent: opencode/1.18.18 }` 永远到不了 API —— OpenCode ZEN
 * 免费接口因此认为请求来自 deepseek-harness 而不是 opencode 客户端，返回 429
 * （FreeUsageLimitError: Rate limit exceeded）。
 *
 * 本模块在加载时对磁盘上的两处文件执行幂等落盘补丁：
 *   1) dsh-llm-pi-ai/lib/index.js 的 requestHeaders（允许 provider headers
 *      覆盖 attribution、自动补全 opencode 身份头）；
 *   2) pi-ai openai-completions.js 的 buildParams（向 OpenCode Zen 网关的
 *      body.tools 追加 bash 空壳工具）。
 * 原生 llm-pi-ai 行保持单行、直接加载磁盘上已补丁的模块，因此 DSH 的模型页
 * （ConfigEditor）仍可正常增删改 provider —— 这是 v1.4.0 修复的核心。
 *
 * 补丁幂等（带标记注释），每次启动自动执行；DSH 升级把文件还原后也会自动
 * 重新补上（至多重启一次生效）。补丁任何失败只打印说明、绝不中断启动。
 *
 * 识别 / 替换 / 校验算法全部在 ./patch-core.js（纯函数，可单测）；
 * 本文件只做 I/O：定位安装文件 → 读源 → 原子落盘。
 */
import { createRequire } from "node:module";
import { accessSync, constants, existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { patchOpenAiCompletions, patchSource } from "./patch-core.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 目标包：@deepseek-ai/dsh-llm-pi-ai。
 * 注意不要用 "…/lib/index.js" 子路径去 require.resolve：该包的 exports 映射只
 * 暴露 "." / "./invariant" / "./src/*" / "./package.json"，lib/index.js 子路径
 * 被封装，一律 ERR_PACKAGE_PATH_NOT_EXPORTED，会让定位永远 fallback 到全局安装
 * 路径（本地跑的时候也 patch/import 全局老版本）。按包名解析命中 exports["."]
 * → lib/index.js，并跟随 profile 共享层 junction：本地 dsh → 本地仓库构建产物，
 * 全局 dsh → 全局安装。
 */
const REL_PKG = "@deepseek-ai/dsh-llm-pi-ai";

/**
 * 定位 dsh-llm-pi-ai 的入口文件（lib/index.js）。
 * 优先按包名向上解析 —— 会命中 $DSH_HOME/profiles/node_modules 里 dsh 启动时
 * 建立的共享 symlink 回退层，跟随其 junction 指向当前运行的那份安装；
 * 再显式探测 profile 共享层；最后回退常见全局安装路径。
 */
function locateTarget() {
	// 1) 从本模块所在目录向上按包名解析（覆盖 profile 共享回退层 / pnpm 布局）
	for (const base of [
		__dirname,
		dirname(__dirname),
		join(dirname(__dirname), "node_modules")
	]) {
		try {
			const pkg = require.resolve(REL_PKG, { paths: [base] });
			if (pkg) return pkg;
		} catch { /* keep looking */ }
	}
	// 2) 显式探测 profile 共享层（$DSH_HOME 或默认 ~/.dsh，dsh 启动时建立的 junction）
	const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
	const shared = join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");
	if (existsSync(shared)) return shared;
	// 3) Windows npm 全局安装布局
	const candidates = [
		process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"),
		"/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return void 0;
}

/**
 * 把补丁后的源码原子写到 target：先写同目录临时文件，再 rename 覆盖目标，
 * 这样并发启动的另一个 dsh 进程永远不会读到「写了一半」的文件。Windows 上
 * rename 因目标被临时占用而失败时，回退为直接写入，并总是清理临时文件。
 */
function writeAtomically(target, source) {
	const tmp = `${target}.zen-useragent.tmp`;
	writeFileSync(tmp, source); // 若此步中途抛错，tmp 可能残留；属极端情况，忽略
	try {
		renameSync(tmp, target);
	} catch {
		try {
			writeFileSync(target, source);
		} finally {
			try { unlinkSync(tmp); } catch { /* tmp may already be gone */ }
		}
	}
}
/**
 * 对目标文件执行幂等补丁。永不抛错：任何失败模式都返回可读说明，让启动
 * 继续走「未补丁的原模块」，而不是因补丁问题中断 DSH。
 */
function patchOnDisk(target) {
	const raw = readFileSync(target, "utf8");
	const { status, source } = patchSource(raw);
	if (status === "already") return `already patched (${target})`;
	if (status === "unknown") return `SKIPPED: unrecognized requestHeaders shape in ${target} — DSH upgraded to a new structure?`;
	// 只读安装目录（受保护的全局 npm 目录、pnpm store 的只读目标等）不中断启动：
	// 先探测可写性给个明确提示，真实失败仍由写入时的 try/catch 兜底。
	try {
		accessSync(target, constants.W_OK);
	} catch {
		return `READONLY: ${target} is not writable — headers fix NOT applied (fix permissions or use a local dsh install)`;
	}
	try {
		writeAtomically(target, source);
	} catch (error) {
		return `WRITE FAILED: ${target} — ${String(error?.message ?? error)} — headers fix NOT applied`;
	}
	return `${status}: ${target}`;
}

/**
 * 定位 pi-ai 的 openai-completions.js。
 * 从 dsh-llm-pi-ai 入口所在目录向上解析 `@earendil-works/pi-ai`：
 * 先按 require.resolve 正常解析（会命中 profile 的 node_modules，若它是独立副本），
 * 再跟随 realpath 到物理文件（若 profile 是 junction/链接 → 全局安装那份）。
 * 最后回退到已知的 dsh 全局布局。
 */
function locatePiAi(dshTargetPath) {
	const completions = () => "@earendil-works/pi-ai/api/openai-completions.lazy";
	for (const base of [dirname(dshTargetPath), join(dirname(dshTargetPath), "node_modules")]) {
		try {
			const resolved = require.resolve(completions(), { paths: [base] });
			if (resolved) {
				const real = realpathSync(resolved);
				const file = join(dirname(real), "openai-completions.js");
				if (existsSync(file)) return file;
			}
		} catch { /* keep looking */ }
	}
	// 已知全局布局（Windows npm 全局 / 通用布局）
	const candidates = [
		process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js"),
		join(dirname(dirname(dirname(dshTargetPath))), "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js"),
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return void 0;
}

/**
 * 对 pi-ai openai-completions.js 执行幂等补丁（追加 bash 工具）。
 * 与 patchOnDisk 同一容错哲学：任何失败只返回说明，不抛错。
 */
function patchPiAiOnDisk(target) {
	const raw = readFileSync(target, "utf8");
	const { status, source } = patchOpenAiCompletions(raw);
	if (status === "already") return `already patched (${target})`;
	if (status === "unknown") return `SKIPPED: unrecognized tools shape in ${target} — pi-ai upgraded?`;
	try {
		accessSync(target, constants.W_OK);
	} catch {
		return `READONLY: ${target} is not writable — tools fix NOT applied (fix permissions or use a local dsh install)`;
	}
	try {
		writeAtomically(target, source);
	} catch (error) {
		return `WRITE FAILED: ${target} — ${String(error?.message ?? error)} — tools fix NOT applied`;
	}
	return `${status}: ${target}`;
}

/**
 * 模块加载时执行补丁（与旧版同一套 I/O 逻辑，仅去掉「再导入原模块转发」）。
 * 幂等、永不抛错；原生 llm-pi-ai 行由 loader 单独导入磁盘上已补丁的模块。
 */
(function patchOnMount() {
	const target = locateTarget();
	if (!target) {
		console.warn("[dsh-plugin-zen-useragent] could not locate dsh-llm-pi-ai/lib/index.js — headers fix NOT applied");
		return;
	}
	// 补丁 1/2：requestHeaders（会话头）。
	try {
		console.log(`[dsh-plugin-zen-useragent] ${patchOnDisk(target)}`);
	} catch (error) {
		console.error("[dsh-plugin-zen-useragent] patch failed:", error);
	}
	// 补丁 2/2：pi-ai openai-completions（tools 补 bash）。
	// pi-ai 与 dsh-llm-pi-ai 同级安装（dsh 的 node_modules 里），跟随
	// dsh-llm-pi-ai 的物理路径（realpath 已解析 junction → 全局那份）。
	const piAi = locatePiAi(target);
	if (piAi) {
		try {
			console.log(`[dsh-plugin-zen-useragent] ${patchPiAiOnDisk(piAi)}`);
		} catch (error) {
			console.error("[dsh-plugin-zen-useragent] pi-ai patch failed:", error);
		}
	} else {
		console.warn("[dsh-plugin-zen-useragent] could not locate @earendil-works/pi-ai/api/openai-completions.js — tools fix NOT applied");
	}
})();

/**
 * cordis 插件入口（zen-useragent 行）。补丁在模块顶层已执行，
 * apply 为空即可；导出 name 便于日志与 loader 识别。
 */
export default {
	name: "dsh-plugin-zen-useragent",
	apply() {},
};