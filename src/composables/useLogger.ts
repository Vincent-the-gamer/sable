/**
 * 全局日志捕获 Store —— 拦截 console.log/warn/error/debug，
 * 使日志在打包后的应用中也能在调试面板查看。
 *
 * 在 main.ts 中调用 initLogger() 即开始全局捕获，
 * DebugPage 通过 useLogger() 读取共享的日志列表。
 */

import { ref, computed } from "vue";

export interface LogEntry {
  id: number;
  type: "log" | "warn" | "error" | "debug";
  message: string;
  timestamp: number;
}

const logs = ref<LogEntry[]>([]);
const maxLogs = 500;
let nextId = 0;
let installed = false;

/** 保存原始 console 方法，以便恢复 */
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "object") {
        try {
          return JSON.stringify(a, null, 2);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(" ");
}

function addLog(type: LogEntry["type"], message: string) {
  logs.value.push({ id: nextId++, type, message, timestamp: Date.now() });
  if (logs.value.length > maxLogs) {
    logs.value.splice(0, logs.value.length - maxLogs);
  }
}

/** 安装全局 console 拦截 */
export function initLogger(): void {
  if (installed) return;
  installed = true;

  console.log = (...args: unknown[]) => {
    addLog("log", formatArgs(args));
    originalConsole.log(...args);
  };
  console.warn = (...args: unknown[]) => {
    addLog("warn", formatArgs(args));
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    addLog("error", formatArgs(args));
    originalConsole.error(...args);
  };
  console.debug = (...args: unknown[]) => {
    addLog("debug", formatArgs(args));
    originalConsole.debug(...args);
  };
}

/** 卸载 console 拦截（一般不需要调用） */
export function uninitLogger(): void {
  if (!installed) return;
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
  installed = false;
}

/** 清空日志 */
export function clearLogs(): void {
  logs.value = [];
}

/** Vue 组合式函数：获取共享的日志状态 */
export function useLogger() {
  const logCounts = computed(() => {
    const c = { log: 0, warn: 0, error: 0, debug: 0 };
    for (const l of logs.value) c[l.type]++;
    return c;
  });

  return {
    logs,
    logCounts,
    clearLogs,
  };
}
