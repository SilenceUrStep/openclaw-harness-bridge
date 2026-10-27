import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beijingTimestamp, logAgentOps, shouldLogAgentOps } from "./agent-ops-log.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tmpLogFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-agentops-"));
  dirs.push(dir);
  const file = path.join(dir, "agent-ops.log");
  writeFileSync(file, "");
  return file;
}

/** jlog 对齐格式：YYYY-MM-DD HH:mm:ss.SSS [级别] [agent-ops] [工具名] 摘要 */
const LINE_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[(INFO|ERROR)\] \[agent-ops\] \[([^\]]+)\] (.*)$/;

function lastLine(file: string): string {
  const text = readFileSync(file, "utf8").trimEnd();
  expect(text.length).toBeGreaterThan(0);
  const lines = text.split("\n");
  return lines[lines.length - 1];
}

describe("agent-ops-log（v0.4.5 agent 层操作日志）", () => {
  it("exec：换行替换为 ⏎，超 120 字符截断", () => {
    const file = tmpLogFile();
    logAgentOps({ toolName: "exec", params: { command: "echo a\necho b\r\necho c" }, logFile: file });
    const line = lastLine(file);
    expect(line).toMatch(LINE_RE);
    expect(line).toContain("[exec] echo a⏎echo b⏎echo c");

    const long = "x".repeat(300);
    logAgentOps({ toolName: "exec", params: { command: long }, logFile: file });
    const m = lastLine(file).match(LINE_RE);
    expect(m?.[3]).toBe("x".repeat(120));
  });

  it("edit/write/apply_patch：摘要取 params.path", () => {
    for (const tool of ["edit", "write", "apply_patch"]) {
      const file = tmpLogFile();
      logAgentOps({ toolName: tool, params: { path: "/tmp/foo.md", content: "x" }, logFile: file });
      expect(lastLine(file)).toContain(`[${tool}] /tmp/foo.md`);
    }
  });

  it("harness_run：harness + taskId + status + durationMs", () => {
    const file = tmpLogFile();
    logAgentOps({
      toolName: "harness_run",
      params: { harness: "opencode", prompt: "修bug" },
      result: { taskId: "t-123", status: "running" },
      durationMs: 1234,
      logFile: file,
    });
    expect(lastLine(file)).toContain("[harness_run] opencode task=t-123 status=running 1234ms");
  });

  it("只读工具跳过不记（read/ls/grep/memory_search）", () => {
    for (const tool of ["read", "ls", "grep", "memory_search"]) {
      const file = tmpLogFile();
      logAgentOps({ toolName: tool, params: { path: "/tmp/x" }, logFile: file });
      expect(readFileSync(file, "utf8")).toBe("");
    }
    expect(shouldLogAgentOps("read")).toBe(false);
    expect(shouldLogAgentOps("exec")).toBe(true);
  });

  it("result 含 error 记 [ERROR]，错误信息截 120 字符", () => {
    const file = tmpLogFile();
    logAgentOps({
      toolName: "exec",
      params: { command: "exit 1" },
      result: { error: "e".repeat(300) },
      logFile: file,
    });
    const line = lastLine(file);
    expect(line).toMatch(/^\S+ \S+ \[ERROR\] \[agent-ops\] \[exec\]/);
    expect(line).toContain(`| error: ${"e".repeat(120)}`);
  });

  it("其他工具：摘要取 params 首个字符串值截 80 字符", () => {
    const file = tmpLogFile();
    logAgentOps({ toolName: "web_fetch", params: { url: "h".repeat(100), flag: "x" }, logFile: file });
    expect(lastLine(file)).toContain(`[web_fetch] ${"h".repeat(80)}`);
  });

  it("日志格式正则校验：北京时间时间戳 + INFO 级别 + agent-ops 来源", () => {
    const file = tmpLogFile();
    logAgentOps({ toolName: "exec", params: { command: "npm test" }, logFile: file });
    const line = lastLine(file);
    const m = line.match(LINE_RE);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe("INFO");
    expect(m?.[2]).toBe("exec");
    expect(m?.[3]).toBe("npm test");
  });

  it("appendFileSync 失败不抛错（fail-open：日志文件为目录时静默吞掉）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-agentops-bad-"));
    dirs.push(dir);
    expect(() =>
      logAgentOps({ toolName: "exec", params: { command: "ls" }, logFile: dir }),
    ).not.toThrow();
  });

  it("beijingTimestamp：北京时间 YYYY-MM-DD HH:mm:ss.SSS 格式", () => {
    const ts = beijingTimestamp(new Date("2026-10-27T05:00:05.542Z"));
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(ts.startsWith("2026-10-27 13:00:05.542")).toBe(true); // UTC+8
  });
});

describe("agent-ops 日志轮转（v0.4.6 maxBytes/keep）", () => {
  it("超 maxBytes 触发轮转：旧内容滚到 .1，新行写主文件", () => {
    const file = tmpLogFile();
    writeFileSync(file, "x".repeat(500));
    logAgentOps({ toolName: "exec", params: { command: "after-rotate" }, logFile: file, maxBytes: 100 });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(500));
    const main = readFileSync(file, "utf8");
    expect(main).toContain("[exec] after-rotate");
    expect(main).not.toContain("x".repeat(500));
  });

  it("未超 maxBytes 不轮转，照常追加", () => {
    const file = tmpLogFile();
    writeFileSync(file, "small\n");
    logAgentOps({ toolName: "exec", params: { command: "ls" }, logFile: file, maxBytes: 10_000 });
    expect(existsSync(`${file}.1`)).toBe(false);
    expect(readFileSync(file, "utf8")).toContain("small\n");
    expect(readFileSync(file, "utf8")).toContain("[exec] ls");
  });

  it("keep 截断：滚动时从大到小 renameSync，删超出 keep 的最老份", () => {
    const file = tmpLogFile();
    writeFileSync(file, "MAIN");
    writeFileSync(`${file}.1`, "OLD1");
    writeFileSync(`${file}.2`, "OLD2");
    logAgentOps({ toolName: "exec", params: { command: "ls" }, logFile: file, maxBytes: 1, keep: 2 });
    expect(readFileSync(`${file}.1`, "utf8")).toBe("MAIN");
    expect(readFileSync(`${file}.2`, "utf8")).toBe("OLD1");
    expect(existsSync(`${file}.3`)).toBe(false); // OLD2 滚出 keep=2 窗口被删
  });

  it("keep 调小后清理历史遗留超序号旧份", () => {
    const file = tmpLogFile();
    writeFileSync(file, "MAIN");
    writeFileSync(`${file}.5`, "LEGACY5");
    logAgentOps({ toolName: "exec", params: { command: "ls" }, logFile: file, maxBytes: 1, keep: 2 });
    expect(existsSync(`${file}.5`)).toBe(false);
  });

  it("轮转失败静默（fail-open：.1 被目录占位致 rm 失败，仍照常写主文件）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-agentops-rot-bad-"));
    dirs.push(dir);
    const file = path.join(dir, "agent-ops.log");
    writeFileSync(file, "y".repeat(100));
    mkdirSync(`${file}.1`); // 目录占位：rmSync 无 recursive 会抛 ERR_FS_EISDIR
    expect(() =>
      logAgentOps({ toolName: "exec", params: { command: "ls" }, logFile: file, maxBytes: 10, keep: 1 }),
    ).not.toThrow();
    expect(readFileSync(file, "utf8")).toContain("[exec] ls");
  });

  it("日志文件不存在时跳过轮转不报错（首次写入）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-agentops-rot-new-"));
    dirs.push(dir);
    const file = path.join(dir, "agent-ops.log");
    logAgentOps({ toolName: "exec", params: { command: "ls" }, logFile: file, maxBytes: 10 });
    expect(readFileSync(file, "utf8")).toContain("[exec] ls");
  });
});
