/**
 * dsh-plugin-zen-useragent — zen-session 纯函数 / 有限 I/O 单测。
 * 运行：node test/zen-session.test.mjs
 * 覆盖：免费模型挑选（big-pickle 优先 / *-free / 首个 opencode / ANSI 剔除）、
 *       CLI 二进制候选路径集合、遗留 storage 扫描（临时目录 fixture + snapshot
 *       目录跳过）、DB 读取（真实 sqlite 临时库 + 垃圾文件二进制扫描兜底）、
 *       CLI 不可见时 provision 优雅失败。
 * 所有测试都在临时目录内进行，不读/写真实 opencode 数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	binaryScanSessions,
	extractSessionIdsFromText,
	opencodeBinaryCandidates,
	pickFreeModelFromOutput,
	provisionZenSessionViaCli,
	resolveZenSessionId,
	scanStorageSessions,
} from "../lib/zen-session.js";

test("extractSessionIdsFromText 提取去重后的 ses_ id（JSON/table 输出都兼容）", () => {
	// 占位会话（非真实账号会话，避免把真实会话写进公开仓库）
	const json = `[{"id":"ses_aaaa0000000000AAAA0000000000"},{"id":"ses_bbbb0000000000BBBB0000000000"}]`;
	assert.deepEqual(extractSessionIdsFromText(json), [
		"ses_aaaa0000000000AAAA0000000000",
		"ses_bbbb0000000000BBBB0000000000",
	]);
	assert.deepEqual(extractSessionIdsFromText(`table row ${json} 重复一次 ${json}`), [
		"ses_aaaa0000000000AAAA0000000000",
		"ses_bbbb0000000000BBBB0000000000",
	], "重复出现只保留首个");
	assert.deepEqual(extractSessionIdsFromText("nothing here"), []);
	assert.deepEqual(extractSessionIdsFromText(null), []);
	assert.deepEqual(extractSessionIdsFromText("ses_short\nses_toooooolong_0123456789abcdef0123456789abcdef0123456789abcdef"), []);
});

test("pickFreeModelFromOutput prefers big-pickle over everything", () => {
	assert.equal(
		pickFreeModelFromOutput("opencode/claude-haiku-5-5\nopencode/big-pickle\nopencode/gpt-6-luna"),
		"opencode/big-pickle"
	);
});

test("pickFreeModelFromOutput prefers *-free when no big-pickle", () => {
	assert.equal(
		pickFreeModelFromOutput("opencode/gpt-6-luna\nopencode/ling-3.1-flash-free\nother/nope"),
		"opencode/ling-3.1-flash-free"
	);
});

test("pickFreeModelFromOutput falls back to first opencode model and strips ANSI", () => {
	assert.equal(
		pickFreeModelFromOutput("\u001b[1mopencode/claude-sonnet-5-5\u001b[0m\nguijiliudong/deepseek-ai/DeepSeek-V4-Flash"),
		"opencode/claude-sonnet-5-5"
	);
});

test("pickFreeModelFromOutput returns null for empty or non-opencode output", () => {
	assert.equal(pickFreeModelFromOutput(""), null);
	assert.equal(pickFreeModelFromOutput("guijiliudong/deepseek-ai/DeepSeek-V4-Flash\nabc"), null);
});

test("opencodeBinaryCandidates returns plausible candidate paths", () => {
	const list = opencodeBinaryCandidates();
	assert.ok(Array.isArray(list) && list.length > 0, "expected non-empty candidate list");
	for (const p of list) {
		assert.equal(typeof p, "string");
		assert.ok(p.length > 0, "candidate path must not be empty");
		assert.ok(
			p.endsWith(".exe") || p.endsWith(".cmd") || p.endsWith(".ps1") || p.endsWith("opencode"),
			`candidate must look like an opencode binary: ${p}`
		);
	}
});

test("scanStorageSessions picks the session from the most recently modified file, skipping snapshot/shell", () => {
	const root = mkdtempSync(join(tmpdir(), "zen-sess-scan-"));
	try {
		// 最新文件在 snapshot（应被跳过）
		mkdirSync(join(root, "storage", "snapshot"), { recursive: true });
		writeFileSync(join(root, "storage", "snapshot", "latest.json"), JSON.stringify({ id: "ses_SNAPSHOT0000000000000000" }));
		// 中间：session_diff 里的旧文件
		mkdirSync(join(root, "storage", "session_diff"), { recursive: true });
		writeFileSync(join(root, "storage", "session_diff", "old.json"), JSON.stringify({ id: "ses_OLDID00000000000000000001" }));
		// 最晚不外层候选：message 下的新文件
		mkdirSync(join(root, "storage", "message"), { recursive: true });
		writeFileSync(join(root, "storage", "message", "new.json"), JSON.stringify({ id: "ses_NEWID00000000000000000001" }));
		const found = scanStorageSessions([root]);
		assert.equal(found, "ses_NEWID00000000000000000001");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanStorageSessions returns null when storage has no sessions", () => {
	const root = mkdtempSync(join(tmpdir(), "zen-sess-empty-"));
	try {
		assert.equal(scanStorageSessions([root]), null);
		assert.equal(scanStorageSessions([join(root, "no-such-dir")]), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveZenSessionId reads the newest session from a real sqlite DB", () => {
	const root = mkdtempSync(join(tmpdir(), "zen-sess-db-"));
	try {
		const db = new DatabaseSync(join(root, "opencode.db"));
		db.exec("CREATE TABLE session_v2 (id TEXT, time_updated INTEGER)");
		db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("ses_older000000000000000000", 100);
		db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("ses_newer0000000000000000001", 200);
		db.close();
		assert.equal(resolveZenSessionId([root]), "ses_newer0000000000000000001");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveZenSessionId falls back to binary scan when sqlite cannot open the file", () => {
	const root = mkdtempSync(join(tmpdir(), "zen-sess-bin-"));
	try {
		const id = "ses_repeated00000000000abcdefgh";
		writeFileSync(join(root, "opencode.db"), `\u0000garbage\u0000${id}\u0000noise${id}\u0000again${id}`, "latin1");
		assert.equal(resolveZenSessionId([root]), id);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("binaryScanSessions：整文件扫描 / 分块扫描都能拿到频率最高的会话", () => {
	const root = mkdtempSync(join(tmpdir(), "zen-sess-binscan-"));
	try {
		const file = join(root, "opencode.db");
		const idA = "ses_aaaa0000000000000000000000";
		const idB = "ses_bbbb0000000000000000000000";
		// 小文件：b 出现 3 次 > a 出现 1 次
		writeFileSync(file, `${idA}${idB}\u0000${idB}\u0000${idB}`, "latin1");
		assert.equal(binaryScanSessions(file), idB);
		assert.equal(binaryScanSessions(join(root, "missing.db")), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("binaryScanSessions：大文件（跨 8MB 块边界）也能完整提取会话（防 ERR_STRING_TOO_LONG 回归）", () => {
	const root = mkdtempSync(join(tmpdir(), "zen-sess-sparse-"));
	try {
		const file = join(root, "opencode.db");
		const CHUNK = 8 * 1024 * 1024;
		const size = CHUNK * 3; // 24MB 稀疏文件（NTFS/ext4 快速分配，不占真实空间）
		const id = "ses_cccc0000000000DDDDDDDDDDDDDD";
		const fd = openSync(file, "w");
		try {
			truncateSync(file, size);
			// 把完整 id 放在第 2 块末尾、紧贴第 3 块边界的 30 字节前 —— 若不做
			// 重叠读取，该 id 会被块边界截断而丢失。
			const pos = CHUNK * 2 - 30;
			writeSync(fd, Buffer.from(id, "latin1"), 0, id.length, pos);
		} finally {
			closeSync(fd);
		}
		assert.equal(binaryScanSessions(file), id, "跨块边界的会话必须靠 64B 重叠恢复");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveZenSessionId returns null when no DB exists anywhere", () => {
	assert.equal(resolveZenSessionId([join(tmpdir(), "zen-no-db-" + Math.random().toString(36).slice(2))]), null);
});

test("provisionZenSessionViaCli degrades gracefully when the binary is missing", () => {
	const missing = join(tmpdir(), "zen-definitely-missing-" + Math.random().toString(36).slice(2) + ".exe");
	// 传入空 roots：即使测试机上有真实 opencode DB，也不会被误当成 provision 成功，
	// 只验证「CLI 缺失 → 优雅失败」本身。
	const emptyRoot = join(tmpdir(), "zen-no-db-" + Math.random().toString(36).slice(2));
	const r = provisionZenSessionViaCli(missing, [emptyRoot]);
	assert.equal(r.ok, false);
	assert.ok(typeof r.reason === "string" && r.reason.length > 0, "reason must be non-empty");
});
