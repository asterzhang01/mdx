/**
 * Trace 日志系统 - 全链路追踪与性能监控
 *
 * 提供：
 *   - 操作追踪：记录用户操作、系统事件
 *   - 性能监控：测量关键操作耗时
 *   - 错误追踪：捕获和记录错误上下文
 *   - 嵌套追踪：支持父子关系追踪
 *   - 实时订阅：支持监听 Trace 事件
 */

// ============================================================================
// Trace 级别
// ============================================================================

export enum TraceLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

// ============================================================================
// Trace 类型
// ============================================================================

export enum TraceType {
  OPERATION = "operation",
  SYNC = "sync",
  CRDT = "crdt",
  FILE = "file",
  PERFORMANCE = "perf",
  ERROR = "error",
  LIFECYCLE = "lifecycle",
}

// ============================================================================
// Trace 条目
// ============================================================================

export interface TraceEntry {
  id: string;
  timestamp: number;
  level: TraceLevel;
  type: TraceType;
  component: string;
  action: string;
  duration?: number;
  data?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  parentId?: string;
  deviceId?: string;
  sessionId?: string;
}

// ============================================================================
// Trace 过滤器
// ============================================================================

export interface TraceFilters {
  level?: TraceLevel;
  type?: TraceType;
  component?: string;
  action?: string;
  startTime?: number;
  endTime?: number;
  parentId?: string;
  hasError?: boolean;
}

// ============================================================================
// Trace 上下文 (用于嵌套追踪)
// ============================================================================

export interface TraceContext {
  id: string;
  parentId?: string;
  success(data?: Record<string, unknown>): void;
  error(error: Error | string, data?: Record<string, unknown>): void;
}

// ============================================================================
// Trace 统计
// ============================================================================

export interface TraceStats {
  totalCount: number;
  errorCount: number;
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
  byType: Record<string, number>;
  byComponent: Record<string, number>;
}

// ============================================================================
// TraceManager
// ============================================================================

export interface TraceManagerOptions {
  maxSize?: number;
  deviceId?: string;
  sessionId?: string;
  minLevel?: TraceLevel;
}

export class TraceManager {
  private traces: TraceEntry[] = [];
  private maxSize: number;
  private deviceId?: string;
  private sessionId?: string;
  private minLevel: TraceLevel;
  private listeners: Set<(entry: TraceEntry) => void> = new Set();
  private activeTraces: Map<string, TraceContextImpl> = new Map();

  constructor(options: TraceManagerOptions = {}) {
    this.maxSize = options.maxSize ?? 10000;
    this.deviceId = options.deviceId;
    this.sessionId = options.sessionId;
    this.minLevel = options.minLevel ?? TraceLevel.DEBUG;
  }

  startTrace(
    component: string,
    action: string,
    type: TraceType = TraceType.OPERATION,
    parentId?: string
  ): TraceContext {
    const id = this.generateId();
    const startTime = performance.now();

    const context = new TraceContextImpl(
      id,
      component,
      action,
      type,
      startTime,
      parentId,
      this.deviceId,
      this.sessionId,
      (entry) => this.addEntry(entry)
    );

    this.activeTraces.set(id, context);

    this.addEntry({
      id,
      timestamp: Date.now(),
      level: TraceLevel.DEBUG,
      type,
      component,
      action: `${action}:start`,
      parentId,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
    });

    return context;
  }

  log(
    level: TraceLevel,
    type: TraceType,
    component: string,
    action: string,
    data?: Record<string, unknown>,
    error?: Error
  ): void {
    if (level < this.minLevel) return;

    const entry: TraceEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      type,
      component,
      action,
      data,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
    };

    if (error) {
      entry.error = {
        message: error.message,
        stack: error.stack,
        code: (error as Error & { code?: string }).code,
      };
    }

    this.addEntry(entry);
  }

  info(component: string, action: string, data?: Record<string, unknown>): void {
    this.log(TraceLevel.INFO, TraceType.OPERATION, component, action, data);
  }

  warn(component: string, action: string, data?: Record<string, unknown>): void {
    this.log(TraceLevel.WARN, TraceType.OPERATION, component, action, data);
  }

  error(
    component: string,
    action: string,
    error: Error,
    data?: Record<string, unknown>
  ): void {
    this.log(TraceLevel.ERROR, TraceType.ERROR, component, action, data, error);
  }

  perf(
    component: string,
    action: string,
    duration: number,
    data?: Record<string, unknown>
  ): void {
    this.log(TraceLevel.INFO, TraceType.PERFORMANCE, component, action, {
      ...data,
      duration,
    });
  }

  getAll(): TraceEntry[] {
    return [...this.traces];
  }

  query(filters: TraceFilters): TraceEntry[] {
    return this.traces.filter((entry) => {
      if (filters.level !== undefined && entry.level < filters.level) {
        return false;
      }
      if (filters.type !== undefined && entry.type !== filters.type) {
        return false;
      }
      if (filters.component !== undefined && entry.component !== filters.component) {
        return false;
      }
      if (filters.action !== undefined && entry.action !== filters.action) {
        return false;
      }
      if (filters.startTime !== undefined && entry.timestamp < filters.startTime) {
        return false;
      }
      if (filters.endTime !== undefined && entry.timestamp > filters.endTime) {
        return false;
      }
      if (filters.parentId !== undefined && entry.parentId !== filters.parentId) {
        return false;
      }
      if (filters.hasError !== undefined) {
        const hasError = entry.error !== undefined;
        if (hasError !== filters.hasError) return false;
      }
      return true;
    });
  }

  getById(id: string): TraceEntry | undefined {
    return this.traces.find((t) => t.id === id);
  }

  getChildren(parentId: string): TraceEntry[] {
    return this.traces.filter((t) => t.parentId === parentId);
  }

  getTraceTree(rootId: string): TraceEntry[] {
    const result: TraceEntry[] = [];
    const root = this.getById(rootId);
    if (!root) return result;

    result.push(root);
    const children = this.getChildren(rootId);
    for (const child of children) {
      result.push(...this.getTraceTree(child.id));
    }
    return result;
  }

  exportAsTimeline(): Array<{
    time: string;
    component: string;
    action: string;
    duration?: number;
    level: string;
  }> {
    return this.traces.map((t) => ({
      time: new Date(t.timestamp).toISOString(),
      component: t.component,
      action: t.action,
      duration: t.duration,
      level: TraceLevel[t.level],
    }));
  }

  exportToJSON(): string {
    return JSON.stringify(this.traces, null, 2);
  }

  getStats(): TraceStats {
    const withDuration = this.traces.filter((t) => t.duration !== undefined);
    const durations = withDuration.map((t) => t.duration!);

    const byType: Record<string, number> = {};
    const byComponent: Record<string, number> = {};

    for (const trace of this.traces) {
      byType[trace.type] = (byType[trace.type] ?? 0) + 1;
      byComponent[trace.component] = (byComponent[trace.component] ?? 0) + 1;
    }

    return {
      totalCount: this.traces.length,
      errorCount: this.traces.filter(
        (t) => t.level >= TraceLevel.ERROR || t.error !== undefined
      ).length,
      avgDuration:
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : 0,
      maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
      minDuration: durations.length > 0 ? Math.min(...durations) : 0,
      byType,
      byComponent,
    };
  }

  subscribe(listener: (entry: TraceEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.traces = [];
    this.activeTraces.clear();
  }

  size(): number {
    return this.traces.length;
  }

  private addEntry(entry: TraceEntry): void {
    this.traces.push(entry);

    if (this.traces.length > this.maxSize) {
      this.traces = this.traces.slice(-this.maxSize);
    }

    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // ignore
      }
    }
  }

  private generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

class TraceContextImpl implements TraceContext {
  public readonly id: string;
  public readonly parentId: string | undefined;
  private component: string;
  private action: string;
  private type: TraceType;
  private startTime: number;
  private deviceId: string | undefined;
  private sessionId: string | undefined;
  private onComplete: (entry: TraceEntry) => void;

  constructor(
    id: string,
    component: string,
    action: string,
    type: TraceType,
    startTime: number,
    parentId: string | undefined,
    deviceId: string | undefined,
    sessionId: string | undefined,
    onComplete: (entry: TraceEntry) => void
  ) {
    this.id = id;
    this.component = component;
    this.action = action;
    this.type = type;
    this.startTime = startTime;
    this.parentId = parentId;
    this.deviceId = deviceId;
    this.sessionId = sessionId;
    this.onComplete = onComplete;
  }

  success(data?: Record<string, unknown>): void {
    const duration = performance.now() - this.startTime;
    this.onComplete({
      id: this.id,
      timestamp: Date.now(),
      level: TraceLevel.INFO,
      type: this.type,
      component: this.component,
      action: `${this.action}:success`,
      duration,
      data,
      parentId: this.parentId,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
    });
  }

  error(error: Error | string, data?: Record<string, unknown>): void {
    const duration = performance.now() - this.startTime;
    const errorObj = error instanceof Error ? error : new Error(error);

    this.onComplete({
      id: this.id,
      timestamp: Date.now(),
      level: TraceLevel.ERROR,
      type: TraceType.ERROR,
      component: this.component,
      action: `${this.action}:error`,
      duration,
      data,
      error: {
        message: errorObj.message,
        stack: errorObj.stack,
      },
      parentId: this.parentId,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
    });
  }
}

let globalTraceManager: TraceManager | null = null;

export function getGlobalTraceManager(): TraceManager {
  if (!globalTraceManager) {
    globalTraceManager = new TraceManager();
  }
  return globalTraceManager;
}

export function setGlobalTraceManager(manager: TraceManager): void {
  globalTraceManager = manager;
}

