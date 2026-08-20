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

/** 补丁标记：目标文件里存在该字符串即视为已打过补丁。 */
export const MARKER = "zen-useragent:patched";

/** 补丁后的 requestHeaders 函数体（替换原生函数用的完整文本）。 */
export const PATCHED_FN = `function requestHeaders(headers) {
	// ${MARKER}: deployment headers may override attribution headers
	const result = { ...attributionHeaders(), ...headers };
	return Object.fromEntries(
		Object.entries(result).map(([k, v]) => [k.toLowerCase(), v])
	);
}`;

/** 原生 requestHeaders 的函数签名锚点（必须精确匹配才替换）。 */
const ANCHOR = "function requestHeaders(headers) {";
/** 原生函数体的特征行：存在它才认为文件是「原生结构」。 */
const ORIG_DETECT = "const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()))";
/** 补丁函数体的特征行：存在它且没有标记，说明是「手动改过没打标」。 */
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
 * 定位原生 requestHeaders 的完整区间（从 `function` 关键字到闭合 `}`），
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
 * 对源码做幂等补丁。纯函数，永不抛错。
 * 返回 { status, source }：
 *   - "already"   已打过补丁（带标记），原样返回
 *   - "annotated" 有补丁体但没标记（之前手动改过）→ 补上标记
 *   - "patched"   识别到原生结构并完成替换
 *   - "unknown"   结构不匹配，原样返回、绝不写盘（避免破坏升级后的新代码）
 *
 * "patched" 分支在构造结果后做三重防线，任一不满足即降级为 "unknown"：
 *   1) 旧特征行（ORIG_DETECT）必须消失；
 *   2) 新标记（MARKER）必须存在；
 *   3) 文件里 requestHeaders 锚点恰好只剩 1 个。
 */
export function patchSource(source) {
	if (source.includes(MARKER)) return { status: "already", source };
	if (source.includes(PATCHED_DETECT)) {
		const next = source.replace(
			"const result = { ...attributionHeaders(), ...headers };",
			`const result = { ...attributionHeaders(), ...headers }; // ${MARKER}`
		);
		return next === source ? { status: "unknown", source } : { status: "annotated", source: next };
	}
	if (!source.includes(ORIG_DETECT)) return { status: "unknown", source };
	const span = locateRequestHeadersSpan(source);
	if (!span) return { status: "unknown", source };
	const next = source.slice(0, span.start) + PATCHED_FN + source.slice(span.end);
	if (next.includes(ORIG_DETECT)) return { status: "unknown", source };
	if (!next.includes(MARKER)) return { status: "unknown", source };
	if (next.split(ANCHOR).length - 1 !== 1) return { status: "unknown", source };
	return { status: "patched", source: next };
}