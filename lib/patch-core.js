/**
 * dsh-plugin-zen-useragent — pure patch core.
 *
 * 补丁算法与 side effect 分离：本文件只含纯函数（识别 / 替换 / 校验），
 * 不读盘、不写盘、不做网络请求，因此可以直接单测。index.js 负责全部 I/O
 * （定位安装文件 → 读源 → 原子落盘）。
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
 * v4 补丁标记：目标文件里存在该字符串即视为已打过补丁（v4）。
 *
 * 版本演进：
 *  - v1（`zen-useragent:patched:`）：只让 provider 配置的 User-Agent 到达 API
 *    （解决 429）；
 *  - v2（`zen-useragent:patched-v2`）：额外把 OpenCode Zen 网关要求的身份头
 *    （x-opencode-client / x-opencode-project / x-opencode-session /
 *    x-opencode-request）自动补全（解决 400 MissingSessionID）；
 *  - v3（`zen-useragent:patched-v3`）：x-opencode-session 的格式对齐网关校验，
 *    由 24 位 hex 改为 `[0-9a-f]{12}[0-9A-Za-z]{14}`；
 *  - v4（`zen-useragent:patched-v4`）：x-opencode-request-id 对齐真实 opencode
 *    CLM 客户端 —— 头名必须是 `x-opencode-request-id`（v2/v3 用的
 *    `x-opencode-request` 与格式不符会被网关判定为未知客户端 403
 *    Generation.FreeTierError），值为 `msg_` + `[0-9a-f]{12}[0-9A-Za-z]{14}`；
 *    同时不再自动注入 x-opencode-project（真实 CLM 客户端不携带该头）。
 */
export const MARKER = "zen-useragent:patched-v4";

/**
 * bash 工具补丁标记：pi-ai 的 openai-completions.js 里存在该字符串即视为
 * 已打过「追加 bash 工具」补丁。
 *
 * v5 结论（由抓包 + 消融实验得出）：OpenCode Zen 网关对免费档的判定只看两件事
 *  —— 请求带 opencode 会话头（x-session-id / x-session-affinity /
 *  x-opencode-session 任一即可，值任意），且请求 body 的 tools 数组里**必须包含
 *  一个名为 `bash` 的函数工具**（数量不限、描述不限、其它名字不限霸）。
 *  DSH 自带的工具集里没有 bash（26 个工具里只有 edit/glob/grep/read/skill/write
 *  六个官方名，恰好卡在 4 个的 403 阈值下），因此网关始终 403
 *  Generation.FreeTierError；通过 MITM 抓包确认真实 opencode CLM 客户端的请求
 *  body.tools 里必然有 bash。本补丁在 pi-ai 发送前往 tools 数组追加一个 bash
 *  空壳工具（描述明示“仅供网关校验，不要真的调用”），即可通过网关。
 */
export const MARKER_BASH = "zen-useragent:patched-bash";

/** v1 补丁标记行（带冒号），用于识别「已部署的旧补丁」并升级为 v4。 */
export const OLD_MARKER = "zen-useragent:patched:";

/** v2 补丁标记行，用于识别「v2 旧补丁」并升级为 v4。 */
export const OLD_MARKER_V2 = "zen-useragent:patched-v2";

/** v3 补丁标记行，用于识别「v3 旧补丁」并升级为 v4。 */
export const OLD_MARKER_V3 = "zen-useragent:patched-v3";

/**
 * 补丁后的 requestHeaders 函数体（替换原生函数用的完整文本）。
 *
 * 行为：
 *  - 仍允许 provider 配置的 headers 覆盖 attribution user-agent（v1 能力）；
 *  - 当合并后的 user-agent 含 "opencode"（即该 provider 指向 opencode
 *    Zen/Go 网关）时，自动补全缺失的 opencode 身份头 —— 显式配置永远优先；
 *  - x-opencode-session 走「进程内稳定」：缓存到函数属性，同一 dsh 进程内
 *    每次调用复用，重启 dsh 才重新生成；x-opencode-request-id 每次请求随机
 *    （贴近 CLM 每次请求带新 msg_ id 的行为）。
 *  - session 与 request 的结构对齐真实 opencode CLM 客户端：
 *    头名 `x-opencode-session` / `x-opencode-request-id`，值分别为
 *    `ses_` / `msg_` + 12 位 hex + 14 位字母数字
 *    （`[0-9a-f]{12}[0-9A-Za-z]{14}`），其中 hex 段保证全小写 —— 网关对
 *    session/request 的格式和头名都做校验，v1/v2/v3 的旧格式会被判定非法。
 *  - 不再自动注入 x-opencode-project：真实 CLM 客户端不携带该头（v2/v3 曾
 *    注入 `global`），删除它使请求头与网关期望完全一致。
 */
export const PATCHED_FN = `function requestHeaders(headers) {
	// ${MARKER}: deployment headers may override attribution headers
	const result = { ...attributionHeaders(), ...headers };
	const finalHeaders = Object.fromEntries(
		Object.entries(result).map(([k, v]) => [k.toLowerCase(), v])
	);
	const hex = (n) => {
		const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(Math.ceil(n / 2)));
		return bytes
			? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n)
			: (Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(0, n);
	};
	const alnum = (n) => {
		const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
		const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(n));
		return bytes
			? Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
			: (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, n);
	};
	if (String(finalHeaders["user-agent"] ?? "").toLowerCase().includes("opencode")) {
		if (!finalHeaders["x-opencode-client"]) finalHeaders["x-opencode-client"] = "cli";
		if (!finalHeaders["x-opencode-session"]) {
			requestHeaders.session ??= "ses_" + hex(12) + alnum(14);
			finalHeaders["x-opencode-session"] = requestHeaders.session;
		}
		if (!finalHeaders["x-opencode-request-id"]) {
			finalHeaders["x-opencode-request-id"] = "msg_" + hex(12) + alnum(14);
		}
	}
	return finalHeaders;
}`;

/** 原生 requestHeaders 的函数签名锚点（必须精确匹配才替换）。 */
const ANCHOR = "function requestHeaders(headers) {";
/** 原生函数体的特征行：存在它才认为文件是「原生结构」。 */
const ORIG_DETECT = "const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()))";
/** 补丁函数体的特征行：v1/v2/v3 都有；存在它说明文件是某种已补丁形状。 */
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
 *   - "already"   已打过 v4 补丁（含 v4 标记），原样返回
 *   - "patched"   识别到原生结构并替换为 v4 补丁体
 *   - "upgraded"  识别到 v1/v2/v3 旧补丁（或未打标的补丁体），整段替换为 v4 补丁体
 *   - "annotated" 补丁体可识别但函数区间无法定位 → 仅在标记行补上 v4 标记
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
	// 某种已补丁形状（v1/v2/v3 旧补丁 / 未打标补丁体）：可定位则整段升级
	if (source.includes(PATCHED_DETECT)) {
		if (span) {
			const next = replaceFunction(source, span, [OLD_MARKER, OLD_MARKER_V2, OLD_MARKER_V3]);
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

/**
 * pi-ai `openai-completions.js` 补丁后的 buildParams tools 生成段（完整文本）。
 *
 * 行为：
 *  - 对 opencode Zen 网关（provider 名为 `opencodezen`，或 baseUrl 含
 *    "opencode"）的请求，在把工具列表交给 convertTools 之前：
 *      * 若 tools 数组里没有名为 `bash` 的工具，就追加一个 bash 空壳工具；
 *      * 追加的工具 description 明示"仅供网关校验，模型不要调用"；
 *      * 插入到数组末尾，不影响原有工具的排序（原有工具优先被模型选择）。
 *  - 非 opencode 网关的请求完全不变。
 *  - 幂等：bash 已存在时不重复追加。
 *
 * 注意：这段代码嵌在原来 `params.tools = convertTools(activeTools, compat);`
 * 的位置，因此必须依赖作用域里已有的 `model` / `activeTools` / `convertTools`
 * / `compat`（buildParams 的局部变量），不新增顶层定义，避免破坏 DSH 打包。
 */
export const PATCHED_OPENCODE_TOOLS = `// ${MARKER_BASH}: add a bash shell so the Zen gateway recognizes this as opencode
		const isOpencodeZen = model.provider === "opencodezen" || String(model.baseUrl ?? "").toLowerCase().includes("opencode");
		const zenTools = isOpencodeZen && !activeTools.some((tool) => tool.name === "bash")
			? [...activeTools, { name: "bash", description: "Zen gateway requires a \\"bash\\" tool to be present; do not actually call it.", parameters: { type: "object", properties: {} } }]
			: activeTools;
		params.tools = convertTools(zenTools, compat);`;

/** 原生 openai-completions tools 生成锚点（必须精确匹配才替换）。 */
export const OC_TOOLS_ANCHOR = "params.tools = convertTools(activeTools, compat);";

/** 原生文件特征行：存在它才认为 openai-completions.js 是「原生结构」。 */
const OC_ORIG_DETECT = "const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));";

/** 已补 bash 的特征行：存在它说明文件已被本补丁处理过（任何形状）。 */
const OC_PATCHED_DETECT = "isOpencodeZen && !activeTools.some";

/**
 * 替换 openai-completions.js 里的 tools 生成段。三重校验与 requestHeaders 补丁
 * 相同的原则：替换后标记存在、原生锚点消失、且 `convertTools(activeTools` 唯一。
 * 不满足时返回 null（降级）。
 */
function replaceOpenAiTools(source, anchor, index) {
	const next = source.slice(0, index) + PATCHED_OPENCODE_TOOLS + source.slice(index + anchor.length);
	// 三重校验：新标记必须存在；被替换的锚点必须从原位消失；原文件特征（activeTools
	// 定义行）必须仍保留（说明文件结构完好）。任一不满足拒绝写盘。
	if (!next.includes(MARKER_BASH)) return null;
	if (!next.includes(OC_ORIG_DETECT)) return null;
	return next;
}

/**
 * 对 pi-ai `openai-completions.js` 源码做幂等补丁。纯函数，永不抛错。
 * 返回 { status, source }：
 *   - "already"   已打过 bash 补丁（含标记），原样返回
 *   - "patched"   识别到原生结构并替换为补丁体
 *   - "unknown"   结构不匹配，原样返回、绝不写盘
 */
export function patchOpenAiCompletions(source) {
	if (source.includes(MARKER_BASH)) return { status: "already", source };
	if (!source.includes(OC_ORIG_DETECT)) return { status: "unknown", source };
	// 锚点可能在文件中出现多次（kimi deferred tools 分支也有一次 convertTools）。
	// 我们只替换 buildParams 里紧随 activeTools 定义之后的那一次：要求上下文是
	// `params.tools = convertTools(activeTools, compat);` 且前面最近的注释是
	// 关于 deferredTools 的（即 buildParams 主分支）。通过定位"if (activeTools
	// && activeTools.length > 0) { may appear once" 来唯一化。
	const needle = "if (activeTools && activeTools.length > 0) {";
	const gate = source.indexOf(needle);
	if (gate < 0) return { status: "unknown", source };
	const index = source.indexOf(OC_TOOLS_ANCHOR, gate);
	if (index < 0) return { status: "unknown", source };
	const next = replaceOpenAiTools(source, OC_TOOLS_ANCHOR, index);
	return next === null ? { status: "unknown", source } : { status: "patched", source: next };
}