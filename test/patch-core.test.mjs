/**
 * dsh-plugin-zen-useragent — patch-core 纯函数单测。
 * 运行：node test/patch-core.test.mjs（或 node --test test/patch-core.test.mjs；
 *       Windows 上目录形式 node --test test/ 无法被 Node 解析，请用显式文件路径）
 * 覆盖：原生替换（含旧正则截断回归）、幂等、annotated 补标、unknown 不变、
 *       花括号/字符串/注释配平、写回三重防线、以及（本机存在时）真实安装
 *       文件的集成识别。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { MARKER, PATCHED_FN, balancedSpan, locateRequestHeadersSpan, patchSource } from "../lib/patch-core.js";

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

test("已打补丁（含标记）→ already，原样返回", () => {
	const source = `${PATCHED_FN}\n// 其它内容\n`;
	assert.deepEqual(patchSource(source), { status: "already", source });
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

// ---- 本机集成验证（文件不存在时自动跳过，不依赖 CI 环境）----
const REAL = "C:\\Users\\Administrator\\.dsh\\profiles\\node_modules\\@deepseek-ai\\dsh-llm-pi-ai\\lib\\index.js";

test("真实安装文件：识别为 already patched，且函数体与 PATCHED_FN 逐字节一致", { skip: !existsSync(REAL) }, () => {
	const source = readFileSync(REAL, "utf8");
	assert.deepEqual(patchSource(source), { status: "already", source });
	const span = locateRequestHeadersSpan(source);
	assert.ok(span, "已补丁文件里必须能定位到 requestHeaders");
	assert.equal(source.slice(span.start, span.end), PATCHED_FN, "线上已部署的补丁体与当前 PATCHED_FN 无漂移");
});