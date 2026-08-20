/**
 * dsh-plugin-zen-useragent
 *
 * llm-pi-ai 的包装模块（通过 cordis.patch.yml 插入的新入口加载）。
 *
 * 原生 dsh-llm-pi-ai 的 `requestHeaders` 会把与 attribution headers 冲突的
 * 自定义请求头（如 User-Agent）过滤掉，因此 settings.yaml 里 provider 配置的
 * `headers: { User-Agent: opencode/1.18.18 }` 永远到不了 API —— OpenCode ZEN
 * 免费接口因此认为请求来自 deepseek-harness 而不是 opencode 客户端，返回 429
 * （FreeUsageLimitError: Rate limit exceeded）。
 *
 * 本模块在导入原模块*之前*先把其 lib/index.js 打上补丁，然后动态导入原模块，
 * 并把原模块的导出（name / inject / apply / PiAiAdapter / …）原样转发给 loader，
 * 使 DSH 完全按原生 llm-pi-ai 处理，只是底层请求头行为被修正。
 * 补丁是幂等的（带标记注释），每次启动自动执行，DSH 升级后文件被还原也会
 * 自动重新补上 —— 修复不会因升级而失效。
 *
 * 识别 / 替换 / 校验算法全部在 ./patch-core.js（纯函数，可单测）；
 * 本文件只做 I/O：定位安装文件 → 读源 → 原子落盘 → 动态导入转发。
 */
import { createRequire } from "node:module";
import { accessSync, constants, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchSource } from "./patch-core.js";

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
 * 模块顶层执行：先补丁，再导入原模块。
 * `export default await …` 让 loader 的 unwrapExports 拿到原模块命名空间
 * （name/inject/apply/PiAiAdapter/Config/… 全部原样保留）。
 */
const ns = await (async () => {
	const target = locateTarget();
	if (target) {
		// patchOnDisk 自身不抛错，但读盘仍可能出意外（文件恰在定位后消失等），
		// 兜底保证补丁失败绝不拖垮插件加载 —— 总回退到导入原模块。
		try {
			console.log(`[dsh-plugin-zen-useragent] ${patchOnDisk(target)}`);
		} catch (error) {
			console.error("[dsh-plugin-zen-useragent] patch failed:", error);
		}
		return import(pathToFileURL(target).href);
	}
	console.warn("[dsh-plugin-zen-useragent] could not locate dsh-llm-pi-ai/lib/index.js — headers fix NOT applied");
	return import("@deepseek-ai/dsh-llm-pi-ai");
})();

export default ns;