/**
 * dsh-plugin-zen-useragent — patch-core 纯函数单测。
 * 运行：node test/patch-core.test.mjs（或 node --test test/patch-core.test.mjs；
 *       Windows 上目录形式 node --test test/ 无法被 Node 解析，请用显式文件路径）
 * 覆盖：原生替换（含旧正则截断回归）、幂等、annotated 补标、unknown 不变、
 *       花括号/字符串/注释配平、v1→v2 升级、opencode 身份头自动补全、
 *       真实安装文件的集成识别。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { MARKER, OLD_MARKER, PATCHED_FN, balancedSpan, locateRequestHeadersSpan, patchSource } from "../lib/patch-core.js";

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

test("已打 v2 补丁（含新标记）→ already，原样返回", () => {
	const source = `${PATCHED_FN}\n// 其它内容\n`;
	assert.deepEqual(patchSource(source), { status: "already", source });
});

test("v1 旧补丁 → upgraded，整段替换为 v2 且逐字节与新 PATCHED_FN 一致", () => {
	const source = `// header\n${OLD_PATCHED_FN}\n// footer`;
	const { status, source: next } = patchSource(source);
	assert.equal(status, "upgraded");
	assert.ok(!next.includes("zen-useragent:patched:"), "v1 旧标记行必须消失");
	assert.ok(next.includes(MARKER), "v2 新标记必须存在");
	assert.equal(next.split("function requestHeaders(headers) {").length - 1, 1, "锚点应只剩 1 个");
	assert.ok(next.startsWith("// header\n") && next.endsWith("\n// footer"), "周边内容不得被破坏");
	assert.equal(next, source.replace(OLD_PATCHED_FN, PATCHED_FN), "应等于整函数替换结果");
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
test("opencode UA → 自动补全身份头（session 进程内稳定，request 每次唯一）", () => {
	const requestHeaders = instantiate(PATCHED_FN);
	const first = requestHeaders({ "User-Agent": "opencode/1.18.21", "Referer": "https://opencode.ai" });
	assert.equal(first["user-agent"], "opencode/1.18.21", "UA 必须保留小写化后的配置值");
	assert.equal(first["referer"], "https://opencode.ai");
	assert.equal(first["x-opencode-client"], "cli");
	assert.equal(first["x-opencode-project"], "global");
	assert.match(first["x-opencode-session"], /^ses_[0-9a-f]+$/, "session 必须是 ses_ 前缀");
	assert.match(first["x-opencode-request"], /^msg_[0-9a-f]+$/, "request 必须是 msg_ 前缀");
	const second = requestHeaders({ "User-Agent": "opencode/1.18.21", "Referer": "https://opencode.ai" });
	assert.equal(second["x-opencode-session"], first["x-opencode-session"], "同一进程内 session 必须稳定");
	assert.notEqual(second["x-opencode-request"], first["x-opencode-request"], "每次请求 request id 必须唯一");
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
		"X-Opencode-Client": "desktop"
	});
	assert.equal(out["x-opencode-session"], "ses_manual_fixed", "手动配置不被覆盖");
	assert.equal(out["x-opencode-client"], "desktop", "手动配置不被覆盖");
});

// ---- 本机集成验证（文件不存在时自动跳过，不依赖 CI 环境）----
const REAL = "C:\\Users\\Administrator\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js";

test("真实安装文件：v1 旧补丁会被升级为 v2（或已是 v2），函数体与 PATCHED_FN 逐字节一致", { skip: !existsSync(REAL) }, () => {
	const source = readFileSync(REAL, "utf8");
	const { status, source: next } = patchSource(source);
	if (status === "already") {
		const span = locateRequestHeadersSpan(next);
		assert.ok(span, "已 v2 文件里必须能定位到 requestHeaders");
		assert.equal(next.slice(span.start, span.end), PATCHED_FN, "线上已部署的 v2 补丁体与当前 PATCHED_FN 无漂移");
		return;
	}
	assert.equal(status, "upgraded", "期望把 v1 旧补丁升级为 v2");
	assert.ok(!next.includes("zen-useragent:patched:"), "升级结果不得再含 v1 标记行");
	assert.ok(next.includes(MARKER), "升级结果必须含 v2 标记");
	const span = locateRequestHeadersSpan(next);
	assert.ok(span, "升级后必须能定位到 requestHeaders");
	assert.equal(next.slice(span.start, span.end), PATCHED_FN, "升级后的补丁体与当前 PATCHED_FN 逐字节一致");
});