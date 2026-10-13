/**
 * zen-session.js — opencode 客户端会话的获取（供 index.js 使用）。
 *
 * 目标：拿到一个"账号已知"的会话 ID 作为 x-opencode-session 的真实来源。
 * 自 2026-10 上旬（实测推断，具体启用日期无公告）起，OpenCode Zen 免费档只认
 * 账号已知会话，自造会话必 403
 * FreeTierError（DSH 误报「API 密钥无效」）。而真实会话的唯一可靠来源是
 * 本机运行过的官方 opencode 客户端（它会创建并同步会话到账号），因此这里
 * 按「DB → 遗留 storage → 官方 CLI 无头创建」的优先级兜底。
 *
 * 纯逻辑与 I/O 分离：命令构造 / 模型挑选 / 目录候选等可单测的函数导出；
 * 文件系统 / 子进程调用全部 try/catch，任何失败都只返回可读原因，绝不抛错。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(import.meta.url));

// 二进制扫描的分块参数：真实 opencode.db 可超过 512MB，整文件 toString 会抛
// ERR_STRING_TOO_LONG，必须分块读；64B 重叠保证跨块边界不被截断（ses_ id 最长
// 46 字符）。
const SCAN_CHUNK = 8 * 1024 * 1024;
const SCAN_OVERLAP = 64;

/**
 * 本机 opencode 客户端数据根目录候选（官方用 ~/.local/share/opencode；
 * 历史版本用过 ~/.opencode）。
 */
export function zenDataRoots() {
	const home = homedir();
	return [join(home, ".local", "share", "opencode"), join(home, ".opencode")];
}

/**
 * 在给定的会话候选目录里复刻 "always latest" 过滤：从候选文件里提取
 * ses_ id。用于 DB 之外的遗留 storage 兜底。可选传入 roots 便于单测。
 */
export function scanStorageSessions(roots = zenDataRoots()) {
	try {
		const idRe = /ses_[A-Za-z0-9]{14,40}/g;
		let best = null;
		for (const root of roots) {
			const storage = join(root, "storage");
			if (!existsSync(storage)) continue;
			const walk = (dir, depth) => {
				if (depth > 2) return; // snapshot/shell 等深层子树不扫，避免打开大文件
				let entries;
				try {
					entries = readdirSync(dir, { withFileTypes: true });
				} catch {
					return;
				}
				for (const entry of entries) {
					const full = join(dir, entry.name);
					if (entry.isDirectory()) {
						if (["snapshot", "shell", "log", "repos"].includes(entry.name)) continue;
						walk(full, depth + 1);
					} else if (entry.isFile() && /\.(json|jsonl)$/.test(entry.name)) {
						try {
							const text = readFileSync(full, "utf8");
							const matches = text.match(idRe);
							if (!matches || !matches.length) continue;
							const stat = statSync(full);
							if (!best || stat.mtimeMs > best.mtime) {
								best = { id: matches[matches.length - 1], mtime: stat.mtimeMs };
							}
						} catch {
							/* 单文件读坏不整体失败 */
						}
					}
				}
			};
			walk(storage, 0);
		}
		return best ? best.id : null;
	} catch {
		return null;
	}
}

/**
 * 内部：分块读取单个 DB 文件，返回 { id -> 出现次数 } 的 Map；文件不可读 /
 * 为空时返回 null。分块 + 重叠保证大文件（>512MB）不触发 ERR_STRING_TOO_LONG、
 * 且跨块边界的 ses_ id 不丢失。
 */
function scanDbForSessions(dbPath) {
	try {
		const size = statSync(dbPath).size;
		if (size <= 0) return null;
		const fd = openSync(dbPath, "r");
		try {
			const seen = new Map();
			const buf = Buffer.alloc(SCAN_CHUNK);
			let pos = 0;
			while (pos < size) {
				const start = pos === 0 ? 0 : pos - SCAN_OVERLAP;
				const len = Math.min(SCAN_CHUNK, size - start);
				const n = readSync(fd, buf, 0, len, start);
				if (n <= 0) break;
				const text = buf.toString("latin1", 0, n);
				const re = /ses_[A-Za-z0-9]{14,40}/g;
				let m;
				while ((m = re.exec(text)) !== null) seen.set(m[0], (seen.get(m[0]) || 0) + 1);
				pos += SCAN_CHUNK;
				if (pos >= size) break;
			}
			return seen;
		} finally {
			try { closeSync(fd); } catch { /* ignore */ }
		}
	} catch {
		return null;
	}
}

/**
 * 分块二进制扫描单个 opencode.db 文件，返回出现频率最高的 ses_ id；
 * 读不到 / 无任何会话时返回 null。I/O 有限，可用临时文件单测。
 */
export function binaryScanSessions(dbPath) {
	const seen = scanDbForSessions(dbPath);
	if (!seen) return null;
	let best = null;
	let bestCount = 0;
	for (const [id, count] of seen) {
		if (count > bestCount) { best = id; bestCount = count; }
	}
	return best;
}

/**
 * 从本机 opencode 客户端数据库读取「账号已知」的最新会话 ID。
 * 主用 SQLite（node:sqlite，Node >= 22.5）：session_v2 表按 time_updated
 * 取最新；表布局更老时回退到 session 表。
 * 兜底：node:sqlite 不可用或 DB 打不开时对 DB 文件做分块二进制扫描，取出现
 * 频率最高的 ses_ id。
 * 任何异常都返回 null（调用方继续走 storage / CLI 兜底）。
 */
export function resolveZenSessionId(roots = zenDataRoots()) {
	// 1) SQLite —— 精确取「最近更新的会话」。
	try {
		const { DatabaseSync } = require("node:sqlite");
		for (const root of roots) {
			const dbPath = join(root, "opencode.db");
			if (!existsSync(dbPath)) continue;
			try {
				const db = new DatabaseSync(dbPath, { readOnly: true });
				try {
					for (const table of ["session_v2", "session"]) {
						try {
							const row = db
								.prepare(`SELECT id FROM ${table} ORDER BY time_updated DESC, id DESC LIMIT 1`)
								.get();
							if (row && typeof row.id === "string" && /^ses_[A-Za-z0-9]{14,40}$/.test(row.id)) {
								return row.id;
							}
						} catch {
							/* 表不存在或列名变化 → 试下一个 */
						}
					}
				} finally {
					try { db.close(); } catch { /* ignore */ }
				}
			} catch {
				/* DB 被占用/损坏 → 试下一个候选路径 */
			}
		}
	} catch {
		/* node:sqlite 不可用 → 走二进制扫描 */
	}
	// 2) 分块二进制扫描兜底（读取整个 DB 文件的活跃会话出现频次；分块适配
	//    超过 512MB 的真实 DB，避免整文件 toString 抛 ERR_STRING_TOO_LONG）。
	try {
		const seen = new Map();
		for (const root of roots) {
			const dbPath = join(root, "opencode.db");
			if (!existsSync(dbPath)) continue;
			const per = scanDbForSessions(dbPath);
			if (!per) continue;
			for (const [id, count] of per) seen.set(id, (seen.get(id) || 0) + count);
		}
		let best = null;
		let bestCount = 0;
		for (const [id, count] of seen) {
			if (count > bestCount) {
				best = id;
				bestCount = count;
			}
		}
		return best;
	} catch {
		return null;
	}
}

/**
 * 官方 opencode CLI 的候选可执行文件路径（按优先顺序；I/O 无关，可单测）。
 */
export function opencodeBinaryCandidates() {
	const isWin = process.platform === "win32";
	const home = homedir();
	const out = [];
	if (isWin && process.env.APPDATA) {
		out.push(join(process.env.APPDATA, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe"));
	}
	const names = isWin ? ["opencode.exe", "opencode.cmd", "opencode.ps1"] : ["opencode"];
	for (const name of names) {
		out.push(join(home, ".opencode", "bin", name));
		out.push(join(home, ".local", "bin", name));
	}
	if (!isWin) {
		for (const base of ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"]) {
			for (const name of names) out.push(join(base, name));
		}
	}
	const pathVar = process.env.PATH ?? "";
	for (const dir of pathVar.split(isWin ? ";" : ":")) {
		if (dir && dir.trim()) {
			for (const name of names) out.push(join(dir.trim(), name));
		}
	}
	return out;
}

/** 找到第一个真实存在且是文件的 CLI 可执行路径；找不到返回 null。 */
export function findOpencodeBinary() {
	for (const candidate of opencodeBinaryCandidates()) {
		try {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		} catch {
			/* 路径不合法（超长等）→ 继续 */
		}
	}
	return null;
}

/**
 * 从 `opencode models` 输出里挑选一个免费模型（纯函数，可单测）。
 * 优先 big-pickle → 任意 *-free → 任意 opencode/ 模型（都会去 ANSI 码）。
 */
export function pickFreeModelFromOutput(output) {
	const clean = String(output ?? "").replace(/\u001b\[[0-9;]*m/g, "");
	const ids = clean
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^opencode\/[A-Za-z0-9._-]+$/.test(line));
	if (!ids.length) return null;
	return (
		ids.find((id) => id === "opencode/big-pickle")
		?? ids.find((id) => /-free$/i.test(id))
		?? ids.find((id) => id.startsWith("opencode/"))
		?? null
	);
}

/**
 * 以无交互方式运行 opencode CLI。返回 spawnSync 的结果对象（失败时
 * status/error 由调用方解释）；CLI 不存在时返回 null。
 */
function runCli(bin, args, timeoutMs) {
	const safe = args.map((a) => a.replace(/'/g, "''"));
	const env = { ...process.env, NO_COLOR: "1", CI: "1" };
	const opts = { encoding: "utf8", timeout: timeoutMs, windowsHide: true, env };
	const lower = String(bin).toLowerCase();
	if (lower.endsWith(".ps1")) {
		return spawnSync(
			"powershell",
			["-NoProfile", "-NonInteractive", "-Command", `& '${bin}' ${safe.map((a) => `'${a}'`).join(" ")}`],
			opts
		);
	}
	if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
		return spawnSync("cmd", ["/c", bin, ...args], opts);
	}
	return spawnSync(bin, args, opts);
}

/**
 * 从任意文本里提取去重后的 ses_ 会话 id（按出现顺序）。用于解析
 * `opencode session list` 的 JSON/table 输出；I/O 无关，可单测。
 */
export function extractSessionIdsFromText(text) {
	const re = /ses_[A-Za-z0-9]{14,40}/g;
	const out = [];
	const seen = new Set();
	let m;
	while ((m = re.exec(String(text ?? ""))) !== null) {
		if (!seen.has(m[0])) {
			seen.add(m[0]);
			out.push(m[0]);
		}
	}
	return out;
}

/**
 * 通过官方 opencode CLI 无头执行一次最小对话来「让真实客户端创建并同步
 * 会话」，随后从 DB 重新解析会话 ID。这是从未运行过 opencode 的用户唯一
 * 可靠的自动兜底。成功返回 { ok:true, sessionId, model }，失败返回
 * { ok:false, reason }；永不抛错。
 *
 * 顺序（全部在 try/catch 内，任一步失败自动降级下一步）：
 *   1) 快路径 `opencode session list --format json`：只读本地 DB、不跑模型、
 *      秒级返回；DB 被占用/损坏但 CLI 能读时直接拿到已有会话；
 *   2) `opencode models` 挑免费模型；
 *   3) `opencode run ping` 无头创建会话 —— 注意会话在模型调用前就已本地
 *      创建并同步，即使 run 因限流/网络返回非零，也先重新解析 DB，拿到了
 *      就算成功（比旧版「run 非 0 直接放弃」多救回不少机器）。
 */
export function provisionZenSessionViaCli(bin = findOpencodeBinary(), roots = zenDataRoots()) {
	try {
		if (!bin) return { ok: false, reason: "opencode CLI not found on this machine" };
		// 快路径：已有会话时零模型调用。
		const listRun = runCli(bin, ["session", "list", "--max-count", "10", "--format", "json"], 30000);
		if (listRun && listRun.status === 0) {
			const listed = extractSessionIdsFromText(`${listRun.stdout ?? ""}\n${listRun.stderr ?? ""}`);
			if (listed.length) return { ok: true, sessionId: listed[0], model: null };
		}
		let model = null;
		const modelsRun = runCli(bin, ["models"], 30000);
		if (modelsRun && modelsRun.status === 0) {
			model = pickFreeModelFromOutput(`${modelsRun.stdout ?? ""}\n${modelsRun.stderr ?? ""}`);
		}
		const args = model ? ["run", "ping", "--model", model] : ["run", "ping"];
		const run = runCli(bin, args, 150000);
		// 会话在模型调用前已创建并同步：run 成功与否都先尝试从 DB 重新解析。
		const sessionId = resolveZenSessionId(roots);
		if (sessionId) return { ok: true, sessionId, model };
		if (run && run.status === 0) {
			return { ok: false, reason: "CLI ran successfully but no session appeared in the opencode DB" };
		}
		const detail = (
			(run && run.error ? String(run.error.message) : "") ||
			(run ? (run.stderr ?? run.stdout) : "") ||
			`exit=${run ? run.status : "no result"}`
		).trim().slice(0, 200);
		return { ok: false, reason: detail || "unexpected CLI exit" };
	} catch (error) {
		return { ok: false, reason: String(error?.message ?? error) };
	}
}