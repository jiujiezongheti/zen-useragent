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
 *
 * 补丁是幂等的（带标记注释），每次启动自动执行，DSH 升级后文件被还原也会
 * 自动重新补上 —— 修复不会因升级而失效。
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/** 补丁标记：文件里存在它就代表已打过补丁。 */
const MARKER = "zen-useragent:patched";

/** 目标文件：@deepseek-ai/dsh-llm-pi-ai 的 lib/index.js。 */
const REL_TARGET = "@deepseek-ai/dsh-llm-pi-ai/lib/index.js";

/** 补丁后的 requestHeaders 函数体。 */
const PATCHED_FN = `function requestHeaders(headers) {
	// ${MARKER}: deployment headers may override attribution headers
	const result = { ...attributionHeaders(), ...headers };
	return Object.fromEntries(
		Object.entries(result).map(([k, v]) => [k.toLowerCase(), v])
	);
}`;

/**
 * 定位 dsh-llm-pi-ai/lib/index.js。
 * 从本模块位置向上走 node_modules（会命中 $DSH_HOME/profiles/node_modules 里
 * dsh 启动时建立的共享 symlink 回退层）；失败再尝试常见全局安装路径。
 */
function locateTarget() {
	const tried = [];
	// 1) 从本模块所在目录向上解析（覆盖 profile 共享回退层 / pnpm 布局）
	for (const base of [
		__dirname,
		dirname(__dirname),
		join(dirname(__dirname), "node_modules")
	]) {
		try {
			const pkg = require.resolve(REL_TARGET, { paths: [base] });
			if (pkg) return pkg;
		} catch { /* keep looking */ }
	}
	// 2) Windows npm 全局安装布局
	const candidates = [
		process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"),
		process.env.DSH_HOME && join(process.env.DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js"),
		"/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"
	];
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return void 0;
}

/**
 * 对源码做幂等补丁；返回 { status, source }：
 *   - status "already"  已打过补丁（带标记）
 *   - status "patched"  本次完成替换
 *   - status "annotated" 之前被手动改过（无标记），补上标记
 *   - status "unknown"  新版结构不匹配，未改动（避免破坏升级后的新代码）
 */
function patchSource(source) {
	if (source.includes(MARKER)) return { status: "already", source };
	// 之前手动改过（present 补丁体但没有标记）→ 补标记即可
	if (source.includes("Object.entries(result).map(([k, v]) => [k.toLowerCase(), v])")) {
		const next = source.replace(
			"const result = { ...attributionHeaders(), ...headers };",
			`const result = { ...attributionHeaders(), ...headers }; // ${MARKER}`
		);
		return next === source ? { status: "unknown", source } : { status: "annotated", source: next };
	}
	// 原生结构 → 整体替换函数体
	const origDetect = "const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()))";
	if (source.includes(origDetect)) {
		const re = /function requestHeaders\(headers\) \{[\s\S]*?\n\}/;
		const next = source.replace(re, PATCHED_FN);
		return next === source ? { status: "unknown", source } : { status: "patched", source: next };
	}
	return { status: "unknown", source };
}

/** 对目标文件执行幂等补丁，返回人类可读结果。 */
function patchOnDisk(target) {
	const raw = readFileSync(target, "utf8");
	const { status, source } = patchSource(raw);
	if (status === "already") return `already patched (${target})`;
	if (status === "unknown") return `SKIPPED: unrecognized requestHeaders shape in ${target} — DSH upgraded to a new structure?`;
	writeFileSync(target, source);
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