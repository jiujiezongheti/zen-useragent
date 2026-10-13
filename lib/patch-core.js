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
 *
 * 另：PATCHED_FN 里 alnum() 用 `b % alphabet.length` 生成随机字母数字段
 * （62 字符表对 256 取模有轻微分布偏差）。OpenCode Zen 网关只校验值的正则
 * 格式 `[0-9A-Za-z]{14}`，不校验统计分布，功能无影响；修复需改函数体并升级
 * MARKER（v6），会让已部署的 v5 机器走一次无必要的升级路径，故保留现状。
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
 *  - v5（`zen-useragent:patched-v5`）：x-opencode-session 改为**烘焙真实会话
 *    ID** —— OpenCode Zen 网关对免费档校验
 *    `x-opencode-session` 是否为账号已知会话（全新/自造会话 → 403
 *    FreeTierError → DSH 误报「API 密钥无效」；抓包实证会话是主要硬门槛）。
 *    启用日期无官方公告，实测推断约 2026-10 上旬前后生效。
 *    插件启动时从本机 opencode 客户端数据库（~/.local/share/opencode/
 *    opencode.db 的 session_v2 表）取最近使用的会话 ID 烘焙进函数体；数据库
 *    不可读 / 无会话时回退为进程内随机生成（与 v4 相同）。已烘焙的文件若发现
 *    DB 里出现了更新的会话，会整段替换刷新（status "refreshed"）。
 *  - v6（`zen-useragent:patched-v6`）：**运行时自愈** —— 自造会话依旧不可行
 *    （网关校验账号已知会话，v5 消融实验证明），但 v5「启动时烘焙定死」有
 *    真实痛点：opencode 里开了新对话 / 会话被服务端作废 / 换账号后，必须
 *    重启 DSH 才重新解析。v6 在补丁体内置**运行时会话解析器**
 *    `__zenUseragentSessionProvider`：以 60s TTL 缓存扫描本机 opencode DB（与
 *    zen-session.js 二进制扫描同一算法，无需 node:sqlite），每次请求自动
 *    跟随 DB 里最新出现的账号会话；烘焙值 / 随机生成仅作「DB 完全不可读」
 *    时的兜底。已打 v6 的文件无需再随 DB 变化重新落盘（幂等，status 恒为
 *    "already"）。解析器通过全局 `__ZEN_USERAGENT_SESSION__`（可选函数）暴露
 *    测试/调试缝隙：存在时每次调用都以返回值为准（不经过 TTL），生产环境
 *    不定义该全局，走内置 DB 扫描。
 */
export const MARKER = "zen-useragent:patched-v6";

/**
 * bash 工具补丁标记：pi-ai 的 openai-completions.js 里存在该字符串即视为
 * 已打过「追加 bash 工具」补丁。
 *
 * v6 结论（用本地日志代理抓取真实 opencode 客户端请求 + 逐步消融实验得出）：
 * OpenCode Zen 网关对免费档的判定**只看请求体** —— `body.tools` 数组里必须
 * **同时**包含一个名为 `read` 的函数工具和一个名为 `shell` 或 `bash` 的函数工具
 * （数量/描述/JSON Schema 都不校验；请求头、UA、会话 id、header 组合一概不参与判定）。
 *
 * DSH 在 Windows 上暴露的工具是 `read` / `write` / `edit` / `glob` / `grep` /
 * `pwsh`（shell 工具叫 `pwsh`，不是 `bash`/`shell`），因此恰好缺了网关要求的
 * shell 名 → 免费档请求恒被判定为「非 opencode 客户端」并返回
 * `403 Generation.FreeTierError`。本补丁在 pi-ai 发送前往 `body.tools` 追加一个
 * bash 空壳工具（描述明示“仅供网关校验，不要真的调用”），补齐 read + bash 组合。
 *
 * 修正（v5）：后续抓包 + 消融实验证明免费档的**现行主要硬门槛
 * 是 `x-opencode-session` 必须是账号已知会话**（由 v5 会话烘焙解决），
 * tools 指纹已不参与判定。本 bash 补丁保留作历史兜底（旧网关 / 降级场景），
 * 且只影响 opencodezen 请求的 tools 数组内容，非 opencode 网关完全不变。
 */
export const MARKER_BASH = "zen-useragent:patched-bash";

/** v1 补丁标记行（带冒号），用于识别「已部署的旧补丁」并升级为 v4。 */
export const OLD_MARKER = "zen-useragent:patched:";

/** v2 补丁标记行，用于识别「v2 旧补丁」并升级为 v4。 */
export const OLD_MARKER_V2 = "zen-useragent:patched-v2";

/** v3 补丁标记行，用于识别「v3 旧补丁」并升级为 v4。 */
export const OLD_MARKER_V3 = "zen-useragent:patched-v3";

/**
 * v4 补丁标记行：出现在「v1-v5 旧补丁 / 未打标补丁体」的整段升级 cleared
 * 名单里（v4/v5 与 v6 的函数体结构不同，升级 = 整段替换）。
 */
export const OLD_MARKER_V4 = "zen-useragent:patched-v4";

/** v5 补丁标记行，用于识别「v5 旧补丁」并升级为 v6（运行时自愈）。 */
export const OLD_MARKER_V5 = "zen-useragent:patched-v5";

/**
 * 运行时会话解析器的源码片段（插入在 requestHeaders 函数之前的模块级代码）。
 *
 * 语义（v6 核心）：
 *  - 以 60s TTL 缓存解析本机 opencode 客户端 DB（`~/.local/share/opencode/
 *    opencode.db`、`~/.opencode/opencode.db`、Windows `%APPDATA%/opencode/`），
 *    只“升级”不“降级”：解析一无所获时保留上一次已知会话（last-known-good），
 *    避免 DB 临时锁死导致已有会话被清掉；
 *  - 解析顺序（每个候选路径）：
 *      1) node:sqlite（`process.getBuiltinModule("node:sqlite")`，Node ≥ 22.5）
 *         精确读取 session_v2 / session 表按 time_updated 最新的一条 ——
 *         与 zen-session.js 的 resolveZenSessionId 同一查询。**必须 sqlite 优先**：
 *         真实用户（实测）的 opencode.db 可超过 512MB，整文件字符串扫描会抛
 *         ERR_STRING_TOO_LONG，二进制扫描直接失效；
 *      2) 二进制分块扫描兜底（8MB 块 + 64B 重叠，取出现频率最高的 ses_ id），
 *         覆盖 sqlite 不可用 / DB 损坏但可读的场景（与 zen-session.js 的
 *         扫描同算法，仅改为分块避免大文件超长字符串）；
 *  - 新出现的会话会在下一次扫描（≤60s）被自动采用 —— 用户在 opencode 里新开
 *    会话 / 会话被服务端作废 / 换账号，都无需重启 DSH；
 *  - 测试/调试缝隙：`globalThis.__ZEN_USERAGENT_SESSION__` 若为函数，则每次
 *    调用都直接以它的返回值为准（绕过 TTL 与内置解析），返回 null/undefined
 *    时沿用当前值。生产环境不会定义该全局。
 *
 * 内嵌代码只依赖 Node 全局（process / globalThis / Date / Map / Buffer）与
 * `process.getBuiltinModule`（Node ≥ 21.2；更老环境里取不到 fs/sqlite 时退回
 * 烘焙值，功能不降级）。
 */
export const SESSION_PROVIDER_SRC = `const __zenUseragentSessionProvider = (() => {
	const isWin = typeof process !== "undefined" && process.platform === "win32";
	const homeRaw = (typeof process !== "undefined" && (process.env.HOME || process.env.USERPROFILE)) || "";
	const home = String(homeRaw).replace(/[\\\\/]+$/, "");
	const dbPaths = [
		home + "/.local/share/opencode/opencode.db",
		home + "/.opencode/opencode.db",
		...(isWin && process.env.APPDATA ? [process.env.APPDATA + "/opencode/opencode.db"] : [])
	].filter(Boolean);
	const TTL = 60000;
	let cached = null;
	let lastAt = 0;
	const idShape = /^ses_[A-Za-z0-9]{14,40}$/;
	const resolveFromSqlite = (dbPath) => {
		let sqlite = null;
		try { sqlite = process && process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : null; } catch { sqlite = null; }
		if (!sqlite) return null;
		try {
			const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				for (const table of ["session_v2", "session"]) {
					try {
						const row = db.prepare("SELECT id FROM " + table + " ORDER BY time_updated DESC, id DESC LIMIT 1").get();
						if (row && typeof row.id === "string" && idShape.test(row.id)) return row.id;
					} catch { /* 表不存在或列变化 → 下一个 */ }
				}
			} finally { try { db.close(); } catch { /* ignore */ } }
		} catch { /* DB 打不开 → 二进制扫描兜底 */ }
		return null;
	};
	const resolveFromScan = (dbPath) => {
		let fs = null;
		try { fs = process && process.getBuiltinModule ? process.getBuiltinModule("node:fs") : null; } catch { fs = null; }
		if (!fs) return null;
		let size;
		try { size = fs.statSync(dbPath).size; } catch { return null; }
		if (size <= 0) return null;
		const seen = new Map();
		const CHUNK = 8 * 1024 * 1024;
		const OVERLAP = 64;
		let fd = null;
		try { fd = fs.openSync(dbPath, "r"); } catch { return null; }
		try {
			const buf = Buffer.alloc(CHUNK);
			let pos = 0;
			while (pos < size) {
				const start = pos === 0 ? 0 : pos - OVERLAP;
				const len = Math.min(CHUNK, size - start);
				const n = fs.readSync(fd, buf, 0, len, start);
				if (n <= 0) break;
				const text = buf.toString("latin1", 0, n);
				const re = /ses_[A-Za-z0-9]{14,40}/g;
				let m;
				while ((m = re.exec(text)) !== null) seen.set(m[0], (seen.get(m[0]) || 0) + 1);
				pos += CHUNK;
				if (pos >= size) break;
			}
		} catch { /* 读取失败 → 统计为空 */ }
		finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
		let best = null;
		let bestCount = 0;
		for (const [id, count] of seen) {
			if (count > bestCount) { best = id; bestCount = count; }
		}
		return best;
	};
	const resolve = () => {
		for (const p of dbPaths) {
			const id = resolveFromSqlite(p);
			if (id) return id;
			const scanned = resolveFromScan(p);
			if (scanned) return scanned;
		}
		return null;
	};
	const scan = () => {
		const seam = globalThis && typeof globalThis.__ZEN_USERAGENT_SESSION__ === "function";
		if (seam) {
			try {
				const v = globalThis.__ZEN_USERAGENT_SESSION__();
				if (typeof v === "string" && idShape.test(v)) cached = v;
			} catch { /* seam 抛错不影响生产路径 */ }
			return;
		}
		const now = Date.now();
		if (now - lastAt < TTL) return;
		lastAt = now;
		const id = resolve();
		if (id && id !== cached) cached = id;
	};
	scan();
	return () => { scan(); return cached; };
})();`;

/**
 * 构造补丁后的 requestHeaders 函数体（替换原生函数用的完整文本：模块级
 * __zenUseragentSessionProvider + requestHeaders 函数）。
 *
 * 行为：
 *  - 仍允许 provider 配置的 headers 覆盖 attribution user-agent（v1 能力）；
 *  - 当合并后的 user-agent 含 "opencode"（即该 provider 指向 opencode
 *    Zen/Go 网关）时，自动补全缺失的 opencode 身份头 —— 显式配置永远优先；
 *  - x-opencode-session：优先用运行时会话解析器 `__zenUseragentSessionProvider()`（实时跟随
 *    本机 opencode DB 里「账号已知」的最新会话，网关校验会话是否账号已知 ——
 *    自造/全新会话必 403 FreeTierError）；解析器拿不到时回退为传入的会话 ID
 *    字面量（烘焙值），再退化为进程内随机生成。x-opencode-request-id 每次请求
 *    随机（贴近 CLM 行为）。
 *  - session 与 request 的结构对齐真实 opencode CLM 客户端：
 *    头名 `x-opencode-session` / `x-opencode-request-id`，值分别为
 *    `ses_` / `msg_` + 12 位 hex + 14 位字母数字
 *    （`[0-9a-f]{12}[0-9A-Za-z]{14}`），其中 hex 段保证全小写。
 *  - 不再自动注入 x-opencode-project：真实 CLM 客户端不携带该头（v2/v3 曾
 *    注入 `global`），删除它使请求头与网关期望完全一致。
 */
export function buildPatchedFn(sessionId) {
	const baked = sessionId ? JSON.stringify(sessionId) : `"ses_" + hex(12) + alnum(14)`;
	return `${SESSION_PROVIDER_SRC}
function requestHeaders(headers) {
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
			finalHeaders["x-opencode-session"] = __zenUseragentSessionProvider() ?? ${baked};
		}
		if (!finalHeaders["x-opencode-request-id"]) {
			finalHeaders["x-opencode-request-id"] = "msg_" + hex(12) + alnum(14);
		}
	}
	return finalHeaders;
}`;
}

/** 无真实会话时的默认函数体（进程内随机生成，同 v4）。 */
export const PATCHED_FN = buildPatchedFn(null);

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
 *   1) cleared 里列出的旧特征（ORIG_DETECT / 旧标记 / 旧烘焙值）必须消失；
 *   2) 新标记（MARKER）必须存在；
 *   3) 文件里 requestHeaders 锚点恰好只剩 1 个。
 */
function replaceFunction(source, span, cleared, fnText = PATCHED_FN) {
	const next = source.slice(0, span.start) + fnText + source.slice(span.end);
	for (const gone of cleared) {
		if (next.includes(gone)) return null;
	}
	if (!next.includes(MARKER)) return null;
	if (next.split(ANCHOR).length - 1 !== 1) return null;
	return next;
}

/**
 * 对源码做幂等补丁。纯函数，永不抛错。
 * opts.sessionId：真实 opencode 客户端 DB 里读出的「账号已知」会话 ID（可选），
 * 烘焙为补丁体的初始兜底值；运行时解析器会随后自动跟随 DB 最新会话
 * （v6），因此补丁体一经写入就无需再随 DB 变化刷新。
 * 返回 { status, source }：
 *   - "already"   已打过 v6 补丁，原样返回（v6 运行时自愈，不做启动时刷新）
 *   - "patched"   识别到原生结构并替换为 v6 补丁体
 *   - "upgraded"  识别到 v1-v5 旧补丁（或未打标的补丁体），整段替换为 v6 补丁体
 *   - "annotated" 补丁体可识别但函数区间无法定位 → 仅在标记行补上 v6 标记
 *   - "unknown"   结构不匹配，原样返回、绝不写盘（避免破坏升级后的新代码）
 */
export function patchSource(source, opts = {}) {
	const sessionId = typeof opts.sessionId === "string" && opts.sessionId ? opts.sessionId : null;
	const fnText = buildPatchedFn(sessionId);
	if (source.includes(MARKER)) {
		// 已打 v6：运行时解析器自动跟随 DB，无需在启动时重写（幂等，正常零写入）。
		return { status: "already", source };
	}
	const span = locateRequestHeadersSpan(source);
	// 原生结构：整段替换
	if (source.includes(ORIG_DETECT)) {
		if (!span) return { status: "unknown", source };
		const next = replaceFunction(source, span, [ORIG_DETECT], fnText);
		return next === null ? { status: "unknown", source } : { status: "patched", source: next };
	}
	// 某种已补丁形状（v1-v5 旧补丁 / 未打标补丁体）：可定位则整段升级
	if (source.includes(PATCHED_DETECT)) {
		if (span) {
			const next = replaceFunction(source, span, [OLD_MARKER, OLD_MARKER_V2, OLD_MARKER_V3, OLD_MARKER_V4, OLD_MARKER_V5], fnText);
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
/**
 * 旧版 pi-ai（<= 0.86）的补丁体：工具来源变量是 `activeTools`。
 * 说明见文件顶部 MARKER_BASH。
 */
export const PATCHED_OPENCODE_TOOLS = `// ${MARKER_BASH}: add a bash shell so the Zen gateway recognizes this as opencode
		const isOpencodeZen = model.provider === "opencodezen" || String(model.baseUrl ?? "").toLowerCase().includes("opencode");
		const zenTools = isOpencodeZen && !activeTools.some((tool) => tool.name === "bash")
			? [...activeTools, { name: "bash", description: "Zen gateway requires a \\"bash\\" tool to be present; do not actually call it.", parameters: { type: "object", properties: {} } }]
			: activeTools;
		params.tools = convertTools(zenTools, compat);`;

/**
 * pi-ai >= 0.87 的补丁体。DSH 0.2.0 起 pi-ai 升到 0.87.x，buildParams 不再有
 * `activeTools`，改为
 *   if (transcriptTools.requestTools.length > 0) {
 *       params.tools = convertTools(transcriptTools.requestTools, compat);
 *   }
 * 除工具来源变量名不同外，行为与 PATCHED_OPENCODE_TOOLS 完全一致。
 */
export const PATCHED_OPENCODE_TOOLS_V2 = `// ${MARKER_BASH}: add a bash shell so the Zen gateway recognizes this as opencode
		const isOpencodeZen = model.provider === "opencodezen" || String(model.baseUrl ?? "").toLowerCase().includes("opencode");
		const zenTools = isOpencodeZen && !transcriptTools.requestTools.some((tool) => tool.name === "bash")
			? [...transcriptTools.requestTools, { name: "bash", description: "Zen gateway requires a \\"bash\\" tool to be present; do not actually call it.", parameters: { type: "object", properties: {} } }]
			: transcriptTools.requestTools;
		params.tools = convertTools(zenTools, compat);`;

/** 旧版（<= 0.86）openai-completions tools 生成锚点（必须精确匹配才替换）。 */
export const OC_TOOLS_ANCHOR = "params.tools = convertTools(activeTools, compat);";

/** 旧版（<= 0.86）原生文件特征行：存在它才认为 openai-completions.js 是「原生结构」。 */
const OC_ORIG_DETECT = "const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));";

/**
 * pi-ai >= 0.87 的 tools 生成锚点 / 原生特征行。
 * DSH 升级到 0.2.0 后 pi-ai 结构变化，旧锚点匹配不上（补丁被静默跳过 → 免费档
 * 403 FreeTierError → DSH 误报「API 密钥无效」），这里对新结构单独支持。
 */
export const OC_TOOLS_ANCHOR_V2 = "params.tools = convertTools(transcriptTools.requestTools, compat);";
const OC_ORIG_DETECT_V2 = "if (transcriptTools.requestTools.length > 0) {";

/** 已补 bash 的特征行（旧形状）：存在它说明文件已被旧补丁处理过（任何形状）。 */
const OC_PATCHED_DETECT = "isOpencodeZen && !activeTools.some";

/**
 * 替换旧版（<= 0.86）openai-completions.js 里的 tools 生成段。三重校验与
 * requestHeaders 补丁相同的原则：替换后标记存在、原生锚点消失、且原生结构
 * （activeTools 定义行）仍保留。不满足时返回 null（降级）。
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
 * 替换 pi-ai >= 0.87 的 tools 生成段（PATCHED_OPENCODE_TOOLS_V2）。三重校验同
 * replaceOpenAiTools：标记存在、锚点消失、`requestTools.length` 判断保留。
 */
function replaceOpenAiToolsV2(source, index) {
	const next = source.slice(0, index) + PATCHED_OPENCODE_TOOLS_V2 + source.slice(index + OC_TOOLS_ANCHOR_V2.length);
	if (!next.includes(MARKER_BASH)) return null;
	if (next.includes(OC_TOOLS_ANCHOR_V2)) return null;
	if (!next.includes(OC_ORIG_DETECT_V2)) return null;
	return next;
}

/**
 * 对 pi-ai `openai-completions.js` 源码做幂等补丁。纯函数，永不抛错。
 * 依次尝试两种 buildParams 结构：
 *   - pi-ai >= 0.87（transcriptTools.requestTools）—— DSH 0.2.0 起；
 *   - pi-ai <= 0.86（activeTools）—— 旧安装。
 * 返回 { status, source }：
 *   - "already"   已打过 bash 补丁（含标记），原样返回
 *   - "patched"   识别到原生结构并替换为补丁体
 *   - "unknown"   结构不匹配，原样返回、绝不写盘
 */
export function patchOpenAiCompletions(source) {
	if (source.includes(MARKER_BASH)) return { status: "already", source };
	// pi-ai >= 0.87：锚点唯一，且外层是 requestTools 长度判断。
	const v2 = source.indexOf(OC_TOOLS_ANCHOR_V2);
	if (v2 >= 0) {
		if (source.indexOf(OC_TOOLS_ANCHOR_V2, v2 + 1) >= 0) return { status: "unknown", source }; // 不唯一，不冒险
		if (!source.includes(OC_ORIG_DETECT_V2)) return { status: "unknown", source };
		const next = replaceOpenAiToolsV2(source, v2);
		return next === null ? { status: "unknown", source } : { status: "patched", source: next };
	}
	// 旧版 pi-ai：activeTools 主分支。
	if (!source.includes(OC_ORIG_DETECT)) return { status: "unknown", source };
	// 锚点可能在文件中出现多次（kimi deferred tools 分支也有一次 convertTools）。
	// 我们只替换 buildParams 里紧随 activeTools 定义之后的那一次：要求上下文是
	// `params.tools = convertTools(activeTools, compat);` 且前一条是 buildParams
	// 主分支的 `if (activeTools && activeTools.length > 0) {`。
	const needle = "if (activeTools && activeTools.length > 0) {";
	const gate = source.indexOf(needle);
	if (gate < 0) return { status: "unknown", source };
	const index = source.indexOf(OC_TOOLS_ANCHOR, gate);
	if (index < 0) return { status: "unknown", source };
	const next = replaceOpenAiTools(source, OC_TOOLS_ANCHOR, index);
	return next === null ? { status: "unknown", source } : { status: "patched", source: next };
}