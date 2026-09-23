/**
 * dsh-plugin-zen-useragent — patch-core 纯函数单测。
 * 运行：node test/patch-core.test.mjs（或 node --test test/patch-core.test.mjs；
 *       Windows 上目录形式 node --test test/ 无法被 Node 解析，请用显式文件路径）
 * 覆盖：原生替换（含旧正则截断回归）、幂等、annotated 补标、unknown 不变、
 *       花括号/字符串/注释配平、v1/v2/v3→v4 升级、opencode 身份头自动补全、
 *       session 格式（ses_[0-9a-f]{12}[0-9A-Za-z]{14}）、真实安装文件的集成识别。
 * 末尾两条「真实安装文件」测试是本机部署自检：仅在文件存在时运行（其它机器上
 * 自动 skip，CI 上亦如此），路径可用 DSH_PLUGIN_TEST_LLM_PI_AI /
 * DSH_PLUGIN_TEST_PI_AI 环境变量覆盖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { MARKER, OLD_MARKER, OLD_MARKER_V2, OLD_MARKER_V3, PATCHED_FN, balancedSpan, locateRequestHeadersSpan, patchSource, MARKER_BASH, OC_TOOLS_ANCHOR, PATCHED_OPENCODE_TOOLS, patchOpenAiCompletions } from "../lib/patch-core.js";

/** 还原的原生 requestHeaders：函数体内嵌套对象在行首闭合（旧正则的截断点）。 */
const NATIVE = `function requestHeaders(headers) {
	const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
	const meta = {
		client: "deepseek-harness"
	};
	return Object.fromEntries(
		Object.entries({ ...attributionHeaders(), ...headers })
			.filter(([name]) => !reserved.has(name.toLowerCase()))
	);
}`;

/** v1 已部署的旧补丁体（行注释与 v1.0.2 发布版逐字节一致）。 */
const OLD_PATCHED_FN = `function requestHeaders(headers) {
	// zen-useragent:patched: deployment headers may override attribution headers
	const result = { ...attributionHeaders(), ...headers };
	return Object.fromEntries(
		Object.entries(result).map(([k, v]) => [k.toLowerCase(), v])
	);
}`;

/** v2 已部署的旧补丁体（行注释与 v1.1.0 发布版逐字节一致，24 位 hex session）。 */
const OLD_PATCHED_FN_V2 = `function requestHeaders(headers) {
	// zen-useragent:patched-v2: deployment headers may override attribution headers
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

/** v3 已部署的旧补丁体（v1.2.0 早期形态：session 已对齐格式，但 request 头名/格式
 *  与 project 仍不对 —— 网关 403 Generation.FreeTierError 的元凶）。 */
const OLD_PATCHED_FN_V3 = `function requestHeaders(headers) {
	// zen-useragent:patched-v3: deployment headers may override attribution headers
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
		if (!finalHeaders["x-opencode-project"]) finalHeaders["x-opencode-project"] = "global";
		if (!finalHeaders["x-opencode-session"]) {
			requestHeaders.session ??= "ses_" + hex(12) + alnum(14);
			finalHeaders["x-opencode-session"] = requestHeaders.session;
		}
		if (!finalHeaders["x-opencode-request"]) finalHeaders["x-opencode-request"] = "msg_" + hex(24);
	}
	return finalHeaders;
}`;

/**
 * 把补丁体的函数文本实例化成一个可调用的 requestHeaders，方便测运行时行为。
 * @param {string} fnText - 以 `function requestHeaders(headers) {` 开头的完整函数文本。
 */
function instantiate(fnText) {
	return new Function("attributionHeaders", `return (${fnText})`)(
		() => ({ "user-agent": "deepseek-harness/0.1.0-rc.6 (+https://github.com/deepseek-ai/deepseek-harness)" })
	);
}

test("原生结构整体替换：嵌套对象行首闭合不再截断（旧正则回归）", () => {
	const source = `// header\n${NATIVE}\n// footer`;
	const { status, source: next } = patchSource(source);
	assert.equal(status, "patched");
	assert.ok(next.includes(MARKER), "结果必须带补丁标记");
	assert.ok(!next.includes("const reserved ="), "旧特征行必须消失");
	assert.equal(next.split("function requestHeaders(headers) {").length - 1, 1, "锚点应只剩 1 个");
	assert.ok(next.startsWith("// header\n") && next.endsWith("\n// footer"), "周边内容不得被破坏");
	assert.equal(next, source.replace(NATIVE, PATCHED_FN), "应等于整函数替换结果");
});

test("幂等：patched 结果再跑一次 → already，内容不变", () => {
	const once = patchSource(`// x\n${NATIVE}`);
	assert.equal(once.status, "patched");
	const twice = patchSource(once.source);
	assert.deepEqual(twice, { status: "already", source: once.source });
});

test("字符串 / 模板字符串 / 注释里的花括号不影响配平", () => {
	const src = `function requestHeaders(headers) {
	const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
	const s = "}";
	const t = \`{\${x ? 1 : 2}}\`;
	/* } 注释里的花括号 } */
	return Object.fromEntries(
		Object.entries({ ...attributionHeaders(), ...headers })
			.filter(([name]) => !reserved.has(name.toLowerCase()))
	);
}`;
	const { status, source: next } = patchSource(src);
	assert.equal(status, "patched");
	assert.ok(next.includes(MARKER));
});

test("已打 v4 补丁（含新标记）→ already，原样返回", () => {
	const source = `${PATCHED_FN}\n// 其它内容\n`;
	assert.deepEqual(patchSource(source), { status: "already", source });
});

test("v1 旧补丁 → upgraded，整段替换为 v4 且逐字节与新 PATCHED_FN 一致", () => {
	const source = `// header\n${OLD_PATCHED_FN}\n// footer`;
	const { status, source: next } = patchSource(source);
	assert.equal(status, "upgraded");
	assert.ok(!next.includes(OLD_MARKER), "v1 旧标记行必须消失");
	assert.ok(next.includes(MARKER), "v4 新标记必须存在");
	assert.equal(next.split("function requestHeaders(headers) {").length - 1, 1, "锚点应只剩 1 个");
	assert.ok(next.startsWith("// header\n") && next.endsWith("\n// footer"), "周边内容不得被破坏");
	assert.equal(next, source.replace(OLD_PATCHED_FN, PATCHED_FN), "应等于整函数替换结果");
	// 升级后再跑一次 → already（幂等）
	assert.equal(patchSource(next).status, "already");
});

test("v2 旧补丁 → upgraded，整段替换为 v4 且逐字节与新 PATCHED_FN 一致", () => {
	const source = `// header\n${OLD_PATCHED_FN_V2}\n// footer`;
	const { status, source: next } = patchSource(source);
	assert.equal(status, "upgraded");
	assert.ok(!next.includes(OLD_MARKER), "v1 旧标记行必须消失");
	assert.ok(!next.includes(OLD_MARKER_V2), "v2 旧标记行必须消失");
	assert.ok(!next.includes(OLD_MARKER_V3), "v3 旧标记行必须消失");
	assert.ok(next.includes(MARKER), "v4 新标记必须存在");
	assert.equal(next.split("function requestHeaders(headers) {").length - 1, 1, "锚点应只剩 1 个");
	assert.ok(next.startsWith("// header\n") && next.endsWith("\n// footer"), "周边内容不得被破坏");
	assert.equal(next, source.replace(OLD_PATCHED_FN_V2, PATCHED_FN), "应等于整函数替换结果");
	// 升级后再跑一次 → already（幂等）
	assert.equal(patchSource(next).status, "already");
});

test("v3 旧补丁 → upgraded，整段替换为 v4 且逐字节与新 PATCHED_FN 一致", () => {
	const source = `// header\n${OLD_PATCHED_FN_V3}\n// footer`;
	const { status, source: next } = patchSource(source);
	assert.equal(status, "upgraded");
	assert.ok(!next.includes(OLD_MARKER), "v1 旧标记行必须消失");
	assert.ok(!next.includes(OLD_MARKER_V2), "v2 旧标记行必须消失");
	assert.ok(!next.includes(OLD_MARKER_V3), "v3 旧标记行必须消失");
	assert.ok(next.includes(MARKER), "v4 新标记必须存在");
	assert.equal(next.split("function requestHeaders(headers) {").length - 1, 1, "锚点应只剩 1 个");
	assert.ok(next.startsWith("// header\n") && next.endsWith("\n// footer"), "周边内容不得被破坏");
	assert.equal(next, source.replace(OLD_PATCHED_FN_V3, PATCHED_FN), "应等于整函数替换结果");
	// 升级后再跑一次 → already（幂等）
	assert.equal(patchSource(next).status, "already");
});

test("有补丁体但无标记（手动改过）→ annotated，补上标记", () => {
	const source = `const result = { ...attributionHeaders(), ...headers };\nreturn Object.fromEntries(\n\tObject.entries(result).map(([k, v]) => [k.toLowerCase(), v])\n);\n`;
	const { status, source: next } = patchSource(source);
	assert.equal(status, "annotated");
	assert.ok(next.includes(MARKER));
	// 补标后再跑 → already（幂等）
	assert.equal(patchSource(next).status, "already");
});

test("有补丁体特征但缺少标记行 → unknown，原样不动", () => {
	const source = "return Object.fromEntries(\n\tObject.entries(result).map(([k, v]) => [k.toLowerCase(), v])\n);\n";
	assert.deepEqual(patchSource(source), { status: "unknown", source });
});

test("完全无关的文件 → unknown，原样不动", () => {
	const source = "module.exports = { a: 1 };\n";
	assert.deepEqual(patchSource(source), { status: "unknown", source });
});

test("有特征行但没有 requestHeaders 函数 → unknown", () => {
	const source = "const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));\n// 函数没了\n";
	assert.deepEqual(patchSource(source), { status: "unknown", source });
});

test("出现多个 requestHeaders 函数 → unknown（不冒险）", () => {
	const source = `${NATIVE}\n\n${NATIVE}`;
	assert.deepEqual(patchSource(source), { status: "unknown", source });
});

test("balancedSpan 直接配平：字符串与注释内的括号被跳过", () => {
	const src = `function f() { const s = "}"; /* } */ const t = \`{\`; return { a: 1 }; }`;
	const braceIndex = src.indexOf("{");
	const span = balancedSpan(src, braceIndex);
	assert.ok(span, "块必须能闭合");
	assert.equal(src.slice(span.start, span.end), src.slice(braceIndex), "区间应从 `{` 起、到配平的 `}` 止");
});

// ---- 补丁体运行时行为：opencode 身份头自动补全 ----
test("opencode UA → 自动补全身份头（session 进程内稳定，request-id 每次唯一）", () => {
	const requestHeaders = instantiate(PATCHED_FN);
	const first = requestHeaders({ "User-Agent": "opencode/1.18.21", "Referer": "https://opencode.ai" });
	assert.equal(first["user-agent"], "opencode/1.18.21", "UA 必须保留小写化后的配置值");
	assert.equal(first["referer"], "https://opencode.ai");
	assert.equal(first["x-opencode-client"], "cli");
	assert.match(first["x-opencode-session"], /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "session 必须是 ses_ + 12hex + 14alnum 结构");
	assert.match(first["x-opencode-request-id"], /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "request-id 必须是 msg_ + 12hex + 14alnum 结构");
	assert.equal(first["x-opencode-request"], void 0, "不得再输出旧头名 x-opencode-request");
	assert.equal(first["x-opencode-project"], void 0, "不再自动注入 x-opencode-project");
	const second = requestHeaders({ "User-Agent": "opencode/1.18.21", "Referer": "https://opencode.ai" });
	assert.equal(second["x-opencode-session"], first["x-opencode-session"], "同一进程内 session 必须稳定");
	assert.notEqual(second["x-opencode-request-id"], first["x-opencode-request-id"], "每次请求 request-id 必须唯一");
});

test("非 opencode UA → 不注入任何 opencode 身份头", () => {
	const requestHeaders = instantiate(PATCHED_FN);
	const out = requestHeaders({ "User-Agent": "curl/8.0" });
	assert.ok(out["x-opencode-session"] === void 0, "非 opencode 请求不得带上 session");
	assert.ok(out["x-opencode-client"] === void 0, "非 opencode 请求不得带上 client");
});

test("显式配置的身份头永远优先于自动补全", () => {
	const requestHeaders = instantiate(PATCHED_FN);
	const out = requestHeaders({
		"User-Agent": "opencode/1.18.21",
		"X-Opencode-Session": "ses_manual_fixed",
		"X-Opencode-Client": "desktop",
		"X-Opencode-Request-Id": "msg_manual_fixed"
	});
	assert.equal(out["x-opencode-session"], "ses_manual_fixed", "手动配置不被覆盖");
	assert.equal(out["x-opencode-client"], "desktop", "手动配置不被覆盖");
	assert.equal(out["x-opencode-request-id"], "msg_manual_fixed", "手动配置不被覆盖");
});

// ---- 本机集成验证（文件不存在时自动跳过，不依赖 CI 环境）----
// 默认路径指向本机部署；其它机器可用环境变量覆盖或直接忽略（skip）。
const REAL = process.env.DSH_PLUGIN_TEST_LLM_PI_AI || "C:\\Users\\Administrator\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js";

test("真实安装文件：v1/v2/v3 旧补丁会被升级为 v4（或已是 v4），函数体与 PATCHED_FN 逐字节一致", { skip: !existsSync(REAL) }, () => {
	const source = readFileSync(REAL, "utf8");
	const { status, source: next } = patchSource(source);
	if (status === "already") {
		const span = locateRequestHeadersSpan(next);
		assert.ok(span, "已 v4 文件里必须能定位到 requestHeaders");
		assert.equal(next.slice(span.start, span.end), PATCHED_FN, "线上已部署的 v4 补丁体与当前 PATCHED_FN 无漂移");
		return;
	}
	assert.equal(status, "upgraded", "期望把 v1/v2/v3 旧补丁升级为 v4");
	assert.ok(!next.includes(OLD_MARKER), "升级结果不得再含 v1 标记行");
	assert.ok(!next.includes(OLD_MARKER_V2), "升级结果不得再含 v2 标记行");
	assert.ok(!next.includes(OLD_MARKER_V3), "升级结果不得再含 v3 标记行");
	assert.ok(next.includes(MARKER), "升级结果必须含 v4 标记");
	const span = locateRequestHeadersSpan(next);
	assert.ok(span, "升级后必须能定位到 requestHeaders");
	assert.equal(next.slice(span.start, span.end), PATCHED_FN, "升级后的补丁体与当前 PATCHED_FN 逐字节一致");
});

// ---- pi-ai openai-completions.js 的 bash 工具补丁 ----
/** 模拟的 pi-ai buildParams 主分支片段（原生未补丁形状）。 */
const OC_NATIVE = `    const deferredToolNames = compat.deferredToolsMode === "kimi" ? getDeferredToolNames(context.messages) : new Set();
    const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));
    if (activeTools && activeTools.length > 0) {
        params.tools = convertTools(activeTools, compat);
        if (compat.zaiToolStream) {
            params.tool_stream = true;
        }
    }
    else if (hasToolHistory(context.messages)) {
        // Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
        params.tools = [];
    }`;

test("pi-ai 原生结构 → patched：tools 生成段被替换为 bash 注入版", () => {
	const source = `// header\n${OC_NATIVE}\n// footer`;
	const { status, source: next } = patchOpenAiCompletions(source);
	assert.equal(status, "patched");
	assert.ok(next.includes(MARKER_BASH), "bash 补丁标记必须存在");
	assert.ok(!next.includes("params.tools = convertTools(activeTools, compat);"), "原生 tools 赋值行必须被替换");
	assert.ok(next.includes("const isOpencodeZen = model.provider === \"opencodezen\""), "opencodezen 判定必须注入");
	assert.ok(next.includes("[...activeTools, { name: \"bash\"") || next.includes('name: "bash"'), "bash 空壳工具必须被追加");
	assert.ok(next.startsWith("// header\n") && next.endsWith("\n// footer"), "周边内容不得被破坏");
	assert.ok(next.split("const activeTools = context.tools").length - 1 === 1, "activeTools 定义行必须保留一份");
	// 补丁后再跑 → already（幂等）
	assert.equal(patchOpenAiCompletions(next).status, "already");
});

test("pi-ai 已补丁（含标记）→ already，原样不动", () => {
	const source = `// header\n${PATCHED_OPENCODE_TOOLS}\n${OC_NATIVE}\n// footer`;
	assert.deepEqual(patchOpenAiCompletions(source), { status: "already", source });
});

test("pi-ai 无关文件 / 缺少锚点 → unknown，原样不动", () => {
	const source = "module.exports = { a: 1 };\n";
	assert.deepEqual(patchOpenAiCompletions(source), { status: "unknown", source });
});

test("pi-ai 有 activeTools 但没有 buildParams 主分支锚点 → unknown", () => {
	const source = `const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));\nreturn activeTools;\n`;
	assert.deepEqual(patchOpenAiCompletions(source), { status: "unknown", source });
});

test("pi-ai 补丁后的注入段在模型非 opencodezen 时保持 tools 原样（纯逻辑推演）", () => {
	const needle = "const isOpencodeZen = model.provider === \"opencodezen\" || String(model.baseUrl ?? \"\").toLowerCase().includes(\"opencode\");";
	assert.ok(PATCHED_OPENCODE_TOOLS.includes(needle), "注入段必须含 opencodezen/baseUrl 判定");
	assert.ok(OC_TOOLS_ANCHOR !== PATCHED_OPENCODE_TOOLS, "替换文本不能只是锚点本身");
	assert.ok(PATCHED_OPENCODE_TOOLS.includes("params.tools = convertTools(zenTools, compat);"), "最终赋值必须用 zenTools");
});

// ---- 本机集成验证：真实 pi-ai 文件（存在才跑）----
const REAL_PI_AI = process.env.DSH_PLUGIN_TEST_PI_AI || "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@earendil-works\\pi-ai\\dist\\api\\openai-completions.js";

test("真实 pi-ai 文件：已打 bash 补丁或可被打补丁，标记/锚点结构正确", { skip: !existsSync(REAL_PI_AI) }, () => {
	const source = readFileSync(REAL_PI_AI, "utf8");
	const { status, source: next } = patchOpenAiCompletions(source);
	if (status === "already") {
		assert.ok(next.includes(MARKER_BASH), "已补丁文件必须含 bash 标记");
		return;
	}
	assert.equal(status, "patched", "期望对原生 pi-ai 打补丁");
	assert.ok(next.includes(MARKER_BASH), "补丁结果必须含 bash 标记");
	assert.ok(!next.split("\n").some((l) => l.includes(OC_TOOLS_ANCHOR)), "原生 tools 赋值锚点应被替换");
	assert.ok(next.includes("[...activeTools, { name: \"bash\""), "bash 空壳必须出现");
});