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
  DEBUG = 0, // 开发调试
  INFO = 1, // 一般信息
  WARN = 2, // 警告
  ERROR = 3, // 错误
  FATAL = 4, // 致命错误
}

// ============================================================================
// Trace 类型
// ============================================================================

export enum TraceType {
  OPERATION = "operation", // 用户操作
  SYNC = "sync", // 同步事件
  CRDT = "crdt", // CRDT 变更
  FILE = "file", // 文件操作
  PERFORMANCE = "perf", // 性能指标
  ERROR = "error", // 错误
  LIFECYCLE = "lifecycle", // 生命周期
}

// ============================================================================
// Trace 条目
// ============================================================================

export interface TraceEntry {
  /** 唯一 ID */
  id: string;
  /** 时间戳 (毫秒) */
  timestamp: number;
  /** Trace 级别 */
  level: TraceLevel;
  /** Trace 类型 */
  type: TraceType;
  /** 组件名 (e.g., 'SyncEngine', 'Sidebar') */
  component: string;
  /** 动作 (e.g., 'init', 'save', 'applyChange') */
  action: string;
  /** 执行时长 (ms) */
  duration?: number;
  /** 上下文数据 */
  data?: Record<string, unknown>;
  /** 错误信息 */
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  /** 父 Trace ID (用于嵌套) */
  parentId?: string;
  /** 设备 ID */
  deviceId?: string;
  /** 会话 ID */
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
  /** Trace ID */
  id: string;
  /** 父 Trace ID */
  parentId?: string;
  /** 标记成功完成 */
  success(data?: Record<string, unknown>): void;
  /** 标记失败 */
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
  byType: Record<TraceType, number>;
  byComponent: Record<string, number>;
}

// ============================================================================
// TraceManager
// ============================================================================

export interface TraceManagerOptions {
  /** 最大存储条目数 (默认 10000) */
  maxSize?: number;
  /** 默认设备 ID */
  deviceId?: string;
  /** 默认会话 ID */
  sessionId?: string;
  /** 最小记录级别 (默认 DEBUG) */
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

  // -------------------------------------------------------------------------
  // 核心方法
  // -------------------------------------------------------------------------

  /**
   * 开始一个 Trace，返回上下文用于标记完成
   */
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

    // 立即记录开始事件
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

  /**
   * 记录即时 Trace
   */
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

  /**
   * 快捷方法：记录信息
   */
  info(
    component: string,
    action: string,
    data?: Record<string, unknown>
  ): void {
    this.log(TraceLevel.INFO, TraceType.OPERATION, component, action, data);
  }

  /**
   * 快捷方法：记录警告
   */
  warn(
    component: string,
    action: string,
    data?: Record<string, unknown>
  ): void {
    this.log(TraceLevel.WARN, TraceType.OPERATION, component, action, data);
  }

  /**
   * 快捷方法：记录错误
   */
  error(
    component: string,
    action: string,
    error: Error,
    data?: Record<string, unknown>
  ): void {
    this.log(TraceLevel.ERROR, TraceType.ERROR, component, action, data, error);
  }

  /**
   * 记录性能指标
   */
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

  // -------------------------------------------------------------------------
  // 查询与导出
  // -------------------------------------------------------------------------

  /**
   * 获取所有 Trace
   */
  getAll(): TraceEntry[] {
    return [...this.traces];
  }

  /**
   * 查询 Trace
   */
  query(filters: TraceFilters): TraceEntry[] {
    return this.traces.filter((entry) => {
      if (filters.level !== undefined && entry.level < filters.level) {
        return false;
      }
      if (filters.type !== undefined && entry.type !== filters.type) {
        return false;
      }
      if (
        filters.component !== undefined &&
        entry.component !== filters.component
      ) {
        return false;
      }
      if (filters.action !== undefined && entry.action !== filters.action) {
        return false;
      }
      if (
        filters.startTime !== undefined &&
        entry.timestamp < filters.startTime
      ) {
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

  /**
   * 获取单个 Trace
   */
  getById(id: string): TraceEntry | undefined {
    return this.traces.find((t) => t.id === id);
  }

  /**
   * 获取子 Trace
   */
  getChildren(parentId: string): TraceEntry[] {
    return this.traces.filter((t) => t.parentId === parentId);
  }

  /**
   * 获取 Trace 树
   */
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

  /**
   * 导出为时间线格式
   */
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

  /**
   * 导出为 JSON
   */
  exportToJSON(): string {
    return JSON.stringify(this.traces, null, 2);
  }

  // -------------------------------------------------------------------------
  // 统计
  // -------------------------------------------------------------------------

  /**
   * 获取统计信息
   */
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
      byType: byType as Record<TraceType, number>,
      byComponent,
    };
  }

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------

  /**
   * 订阅新 Trace
   */
  subscribe(listener: (entry: TraceEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // 管理
  // -------------------------------------------------------------------------

  /**
   * 清空所有 Trace
   */
  clear(): void {
    this.traces = [];
    this.activeTraces.clear();
  }

  /**
   * 获取当前 Trace 数量
   */
  size(): number {
    return this.traces.length;
  }

  // -------------------------------------------------------------------------
  // 私有方法
  // -------------------------------------------------------------------------

  private addEntry(entry: TraceEntry): void {
    this.traces.push(entry);

    // 限制大小
    if (this.traces.length > this.maxSize) {
      this.traces = this.traces.slice(-this.maxSize);
    }

    // 通知订阅者
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // 忽略订阅者错误
      }
    }
  }

  private generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ============================================================================
// TraceContext 实现
// ============================================================================

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

// ============================================================================
// 全局 TraceManager 实例 (可选)
// ============================================================================

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
