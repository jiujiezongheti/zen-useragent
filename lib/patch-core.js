/**
 * dsh-plugin-zen-useragent — pure patch core.
 *
 * 补丁算法与 side effect 分离：本文件只含纯函数（识别 / 替换 / 校验），
 * 不读盘、不写盘、不做网络请求，因此可以直接单测。index.js 负责全部 I/O
 * （定位安装文件 → 读源 → 原子落盘 → 动态导入转发）。
 *
 * 相比早期基于正则的整段替换，这里用「花括号配对」定位 requestHeaders
 * 函数体：扫描时跳过字符串、模板字符串和注释中的花括号，因此函数体内出现
 * 行首闭合的嵌套对象字面量也不会被提前截断（旧正则是匹配到第一个 `\n}`
 * 就停，DSH 升级后函数结构一变就可能写坏文件）。
 *
 * 已知局限：配平不识别正则字面量（`/.../` 会被当作注释起始），若未来函数体
 * 内出现含 `{`/`}` 的正则，配平可能错位且三重校验无法全部拦截 —— 当前原生
 * 函数体没有正则，风险可忽略，改结构前请先确认。
 */

/**
 * v2 补丁标记：目标文件里存在该字符串即视为已打过补丁（v2）。
 *
 * 注意与 v1（`zen-useragent:patched:`）区分：v1 补丁只让 provider 配置的
 * User-Agent 到达 API（解决 429），v2 在此基础上把 OpenCode Zen 网关要求的
 * 身份头（x-opencode-client / x-opencode-project / x-opencode-session /
 * x-opencode-request）自动补全（解决 400 MissingSessionID）。
 */
export const MARKER = "zen-useragent:patched-v2";

/** v1 补丁标记行（带冒号），用于识别「已部署的旧补丁」并升级为 v2。 */
export const OLD_MARKER = "zen-useragent:patched:";

/**
 * 补丁后的 requestHeaders 函数体（替换原生函数用的完整文本）。
 *
 * 行为：
 *  - 仍允许 provider 配置的 headers 覆盖 attribution user-agent（v1 能力）；
 *  - 当合并后的 user-agent 含 "opencode"（即该 provider 指向 opencode
 *    Zen/Go 网关）时，自动补全缺失的 opencode 身份头 —— 显式配置永远优先；
 *  - x-opencode-session 走「进程内稳定」：缓存到函数属性，同一 dsh 进程内
 *    每次调用复用，重启 dsh 才重新生成；x-opencode-request 每次请求随机
 *    （贴近 CLM 每次请求带新 msg_ id 的行为）。
 */
export const PATCHED_FN = `function requestHeaders(headers) {
	// ${MARKER}: deployment headers may override attribution headers
	const result = { ...attributionHeaders(), ...headers };
	const finalHeaders = Object.fromEntries(
		Object.entries(result).map(([k, v]) => [k.toLowerCase(), v])
	);
	const random = () => {
		const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(12));
		return bytes
			? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
			: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
	};
	if (String(finalHeaders["user-agent"] ?? "").toLowerCase().includes("opencode")) {
		if (!finalHeaders["x-opencode-client"]) finalHeaders["x-opencode-client"] = "cli";
		if (!finalHeaders["x-opencode-project"]) finalHeaders["x-opencode-project"] = "global";
		if (!finalHeaders["x-opencode-session"]) {
			requestHeaders.session ??= "ses_" + random();
			finalHeaders["x-opencode-session"] = requestHeaders.session;
		}
		if (!finalHeaders["x-opencode-request"]) finalHeaders["x-opencode-request"] = "msg_" + random();
	}
	return finalHeaders;
}`;

/** 原生 requestHeaders 的函数签名锚点（必须精确匹配才替换）。 */
const ANCHOR = "function requestHeaders(headers) {";
/** 原生函数体的特征行：存在它才认为文件是「原生结构」。 */
const ORIG_DETECT = "const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()))";
/** 补丁函数体的特征行：v1 与 v2 都有；存在它说明文件是某种已补丁形状。 */
const PATCHED_DETECT = "Object.entries(result).map(([k, v]) => [k.toLowerCase(), v])";

/**
 * 返回 source 中以 braceIndex（必须是 `{` 的下标）为起点、括号配平的
 * `{ ... }` 块区间 { start, end }（end 为闭合 `}` 的后一位），无法闭合时
 * 返回 null。扫描跳过三种字符串（' " `）和 //、/* 注释，所以字符串里的
 * 花括号不会干扰深度计数。
 */
export function balancedSpan(source, braceIndex) {
	let depth = 0;
	let quote = null; // "'" | '"' | "`"
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let i = braceIndex; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];
		if (lineComment) {
			if (ch === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (ch === "*" && next === "/") { blockComment = false; i++; }
			continue;
		}
		if (quote) {
			if (escaped) { escaped = false; continue; }
			if (ch === "\\") { escaped = true; continue; }
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
		if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
		if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return { start: braceIndex, end: i + 1 };
		}
	}
	return null;
}

/**
 * 定位 requestHeaders 的完整区间（从 `function` 关键字到闭合 `}`），
 * 形状不被识别时返回 null：锚点缺失、出现多个候选函数、或函数体括号
 * 不配平（文件本身可能是坏的，宁可跳过也不动它）。
 */
export function locateRequestHeadersSpan(source) {
	const first = source.indexOf(ANCHOR);
	if (first < 0) return null;
	if (source.indexOf(ANCHOR, first + ANCHOR.length) >= 0) return null; // 不止一个
	const brace = first + ANCHOR.length - 1; // `{` 在锚点末尾
	const span = balancedSpan(source, brace);
	if (!span) return null;
	return { start: first, end: span.end };
}

/**
 * 整段替换 requestHeaders 函数并做三重校验；任一不满足返回 null（降级）。
 * 三重防线：
 *   1) 旧特征行（ORIG_DETECT 或 OLD_MARKER）必须消失；
 *   2) 新标记（MARKER）必须存在；
 *   3) 文件里 requestHeaders 锚点恰好只剩 1 个。
 */
function replaceFunction(source, span, cleared) {
	const next = source.slice(0, span.start) + PATCHED_FN + source.slice(span.end);
	for (const gone of cleared) {
		if (next.includes(gone)) return null;
	}
	if (!next.includes(MARKER)) return null;
	if (next.split(ANCHOR).length - 1 !== 1) return null;
	return next;
}

/**
 * 对源码做幂等补丁。纯函数，永不抛错。
 * 返回 { status, source }：
 *   - "already"   已打过 v2 补丁（含 v2 标记），原样返回
 *   - "patched"   识别到原生结构并替换为 v2 补丁体
 *   - "upgraded"  识别到 v1 旧补丁（或未打标的补丁体），整段替换为 v2 补丁体
 *   - "annotated" 补丁体可识别但函数区间无法定位 → 仅在标记行补上 v2 标记
 *   - "unknown"   结构不匹配，原样返回、绝不写盘（避免破坏升级后的新代码）
 */
export function patchSource(source) {
	if (source.includes(MARKER)) return { status: "already", source };
	const span = locateRequestHeadersSpan(source);
	// 原生结构：整段替换
	if (source.includes(ORIG_DETECT)) {
		if (!span) return { status: "unknown", source };
		const next = replaceFunction(source, span, [ORIG_DETECT]);
		return next === null ? { status: "unknown", source } : { status: "patched", source: next };
	}
	// 某种已补丁形状（v1 旧补丁 / 未打标补丁体）：可定位则整段升级
	if (source.includes(PATCHED_DETECT)) {
		if (span) {
			const next = replaceFunction(source, span, [OLD_MARKER]);
			return next === null ? { status: "unknown", source } : { status: "upgraded", source: next };
		}
		// 极端：函数体不在但补丁体特征散落（例如手动截断了函数）→ 只在标记行补标
		const next = source.replace(
			"const result = { ...attributionHeaders(), ...headers };",
			`const result = { ...attributionHeaders(), ...headers }; // ${MARKER}`
		);
		return next === source ? { status: "unknown", source } : { status: "annotated", source: next };
	}
	return { status: "unknown", source };
}