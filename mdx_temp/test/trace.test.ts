/**
 * Trace 系统单元测试
 *
 * 覆盖:
 *   - TraceManager 基础功能
 *   - startTrace / success / error 流程
 *   - log / info / warn / error 快捷方法
 *   - 查询与过滤
 *   - 订阅机制
 *   - 统计功能
 *   - 边界条件 (maxSize)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TraceManager,
  TraceLevel,
  TraceType,
  type TraceEntry,
} from "../src/trace.js";

describe("TraceManager", () => {
  let traceManager: TraceManager;

  beforeEach(() => {
    traceManager = new TraceManager();
  });

  // ==========================================================================
  // 基础功能
  // ==========================================================================

  describe("constructor", () => {
    it("should create with default options", () => {
      const manager = new TraceManager();
      expect(manager).toBeInstanceOf(TraceManager);
      expect(manager.size()).toBe(0);
    });

    it("should create with custom options", () => {
      const manager = new TraceManager({
        maxSize: 100,
        deviceId: "test-device",
        sessionId: "test-session",
        minLevel: TraceLevel.INFO,
      });
      expect(manager).toBeInstanceOf(TraceManager);
    });
  });

  describe("startTrace", () => {
    it("should create trace with unique id", () => {
      const trace1 = traceManager.startTrace("TestComponent", "testAction");
      const trace2 = traceManager.startTrace("TestComponent", "testAction");

      expect(trace1.id).toBeDefined();
      expect(trace2.id).toBeDefined();
      expect(trace1.id).not.toBe(trace2.id);
    });

    it("should record start timestamp", () => {
      const before = Date.now();
      traceManager.startTrace("TestComponent", "testAction");
      const after = Date.now();

      const traces = traceManager.getAll();
      expect(traces.length).toBe(1);
      expect(traces[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(traces[0].timestamp).toBeLessThanOrEqual(after);
    });

    it("should set correct component and action", () => {
      traceManager.startTrace("SyncEngine", "init");

      const traces = traceManager.getAll();
      expect(traces[0].component).toBe("SyncEngine");
      expect(traces[0].action).toBe("init:start");
    });

    it("should set correct type", () => {
      traceManager.startTrace("Test", "action", TraceType.SYNC);

      const traces = traceManager.getAll();
      expect(traces[0].type).toBe(TraceType.SYNC);
    });

    it("should support parentId for nested traces", () => {
      const parentTrace = traceManager.startTrace("Parent", "parentAction");
      traceManager.startTrace("Child", "childAction", TraceType.OPERATION, parentTrace.id);

      const traces = traceManager.getAll();
      const childTrace = traces.find((t) => t.component === "Child");
      expect(childTrace?.parentId).toBe(parentTrace.id);
    });

    it("should include deviceId and sessionId when provided", () => {
      const manager = new TraceManager({
        deviceId: "device-123",
        sessionId: "session-456",
      });
      manager.startTrace("Test", "action");

      const traces = manager.getAll();
      expect(traces[0].deviceId).toBe("device-123");
      expect(traces[0].sessionId).toBe("session-456");
    });
  });

  describe("trace success", () => {
    it("should record success trace with duration", async () => {
      const trace = traceManager.startTrace("Test", "operation");

      // Simulate some work
      await new Promise((resolve) => setTimeout(resolve, 20));

      trace.success({ result: "success" });

      const traces = traceManager.getAll();
      const successTrace = traces.find((t) => t.action === "operation:success");

      expect(successTrace).toBeDefined();
      expect(successTrace?.duration).toBeGreaterThanOrEqual(5); // 只要有延迟即可
      expect(successTrace?.data).toEqual({ result: "success" });
      expect(successTrace?.level).toBe(TraceLevel.INFO);
    });

    it("should work without data", () => {
      const trace = traceManager.startTrace("Test", "operation");
      trace.success();

      const traces = traceManager.getAll();
      const successTrace = traces.find((t) => t.action === "operation:success");
      expect(successTrace?.data).toBeUndefined();
    });
  });

  describe("trace error", () => {
    it("should record error trace with error details", () => {
      const trace = traceManager.startTrace("Test", "operation");
      const error = new Error("Test error message");

      trace.error(error);

      const traces = traceManager.getAll();
      const errorTrace = traces.find((t) => t.action === "operation:error");

      expect(errorTrace).toBeDefined();
      expect(errorTrace?.level).toBe(TraceLevel.ERROR);
      expect(errorTrace?.type).toBe(TraceType.ERROR);
      expect(errorTrace?.error?.message).toBe("Test error message");
      expect(errorTrace?.error?.stack).toBeDefined();
    });

    it("should support string error", () => {
      const trace = traceManager.startTrace("Test", "operation");
      trace.error("String error message");

      const traces = traceManager.getAll();
      const errorTrace = traces.find((t) => t.action === "operation:error");

      expect(errorTrace?.error?.message).toBe("String error message");
    });

    it("should include additional data", () => {
      const trace = traceManager.startTrace("Test", "operation");
      trace.error(new Error("Error"), { context: "additional info" });

      const traces = traceManager.getAll();
      const errorTrace = traces.find((t) => t.action === "operation:error");

      expect(errorTrace?.data).toEqual({ context: "additional info" });
    });
  });

  // ==========================================================================
  // 快捷方法
  // ==========================================================================

  describe("log", () => {
    it("should create trace entry with all fields", () => {
      traceManager.log(
        TraceLevel.INFO,
        TraceType.FILE,
        "FileManager",
        "read",
        { path: "/test/file.md" }
      );

      const traces = traceManager.getAll();
      expect(traces.length).toBe(1);
      expect(traces[0].level).toBe(TraceLevel.INFO);
      expect(traces[0].type).toBe(TraceType.FILE);
      expect(traces[0].component).toBe("FileManager");
      expect(traces[0].action).toBe("read");
      expect(traces[0].data).toEqual({ path: "/test/file.md" });
    });

    it("should respect minLevel filter", () => {
      const manager = new TraceManager({ minLevel: TraceLevel.WARN });

      manager.log(TraceLevel.DEBUG, TraceType.OPERATION, "Test", "debug");
      manager.log(TraceLevel.INFO, TraceType.OPERATION, "Test", "info");
      manager.log(TraceLevel.WARN, TraceType.OPERATION, "Test", "warn");
      manager.log(TraceLevel.ERROR, TraceType.OPERATION, "Test", "error");

      const traces = manager.getAll();
      expect(traces.length).toBe(2);
      expect(traces[0].action).toBe("warn");
      expect(traces[1].action).toBe("error");
    });

    it("should include error details when provided", () => {
      const error = new Error("Test error");
      traceManager.log(
        TraceLevel.ERROR,
        TraceType.ERROR,
        "Test",
        "failed",
        undefined,
        error
      );

      const traces = traceManager.getAll();
      expect(traces[0].error?.message).toBe("Test error");
    });
  });

  describe("info", () => {
    it("should log info level trace", () => {
      traceManager.info("Component", "action", { key: "value" });

      const traces = traceManager.getAll();
      expect(traces[0].level).toBe(TraceLevel.INFO);
      expect(traces[0].type).toBe(TraceType.OPERATION);
      expect(traces[0].data).toEqual({ key: "value" });
    });
  });

  describe("warn", () => {
    it("should log warn level trace", () => {
      traceManager.warn("Component", "warning", { reason: "test" });

      const traces = traceManager.getAll();
      expect(traces[0].level).toBe(TraceLevel.WARN);
    });
  });

  describe("error", () => {
    it("should log error with error object", () => {
      const error = new Error("Something went wrong");
      traceManager.error("Component", "failed", error, { context: "test" });

      const traces = traceManager.getAll();
      expect(traces[0].level).toBe(TraceLevel.ERROR);
      expect(traces[0].error?.message).toBe("Something went wrong");
    });
  });

  describe("perf", () => {
    it("should log performance trace", () => {
      traceManager.perf("SyncEngine", "save", 150, { size: 1024 });

      const traces = traceManager.getAll();
      expect(traces[0].level).toBe(TraceLevel.INFO);
      expect(traces[0].type).toBe(TraceType.PERFORMANCE);
      expect(traces[0].data).toEqual({ size: 1024, duration: 150 });
    });
  });

  // ==========================================================================
  // 查询与过滤
  // ==========================================================================

  describe("query", () => {
    beforeEach(() => {
      // Create diverse traces
      traceManager.info("ComponentA", "action1");
      traceManager.warn("ComponentA", "action2");
      traceManager.error("ComponentB", "action3", new Error("error"));
      traceManager.log(TraceLevel.INFO, TraceType.SYNC, "ComponentC", "sync");
    });

    it("should filter by level", () => {
      const results = traceManager.query({ level: TraceLevel.WARN });
      expect(results.length).toBe(2); // warn + error (error >= warn)
    });

    it("should filter by type", () => {
      const results = traceManager.query({ type: TraceType.SYNC });
      expect(results.length).toBe(1);
      expect(results[0].component).toBe("ComponentC");
    });

    it("should filter by component", () => {
      const results = traceManager.query({ component: "ComponentA" });
      expect(results.length).toBe(2);
    });

    it("should filter by action", () => {
      const results = traceManager.query({ action: "action1" });
      expect(results.length).toBe(1);
    });

    it("should filter by time range", () => {
      // 先记录当前时间，再添加 trace
      const startTime = Date.now();
      traceManager.info("Test", "newAction");
      const endTime = Date.now() + 1;

      const results = traceManager.query({ startTime, endTime });
      // 可能包含多个 trace（包括 beforeEach 中的）
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.action === "newAction")).toBe(true);
    });

    it("should filter by hasError", () => {
      const withError = traceManager.query({ hasError: true });
      expect(withError.length).toBe(1);
      expect(withError[0].action).toBe("action3");

      const withoutError = traceManager.query({ hasError: false });
      expect(withoutError.length).toBe(3);
    });

    it("should combine multiple filters", () => {
      traceManager.info("ComponentA", "specific");

      const results = traceManager.query({
        component: "ComponentA",
        level: TraceLevel.INFO,
      });
      // ComponentA 有 action1 (INFO) 和 action2 (WARN)，加上 specific (INFO)
      // level >= INFO 会包含 INFO 和 WARN，所以是 3 个
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.some((r) => r.action === "specific")).toBe(true);
    });
  });

  describe("getById", () => {
    it("should return trace by id", () => {
      traceManager.info("Test", "action");
      const trace = traceManager.getAll()[0];

      const found = traceManager.getById(trace.id);
      expect(found).toEqual(trace);
    });

    it("should return undefined for non-existent id", () => {
      const found = traceManager.getById("non-existent");
      expect(found).toBeUndefined();
    });
  });

  describe("getChildren", () => {
    it("should return child traces", () => {
      const parent = traceManager.startTrace("Parent", "parent");
      traceManager.startTrace("Child1", "child1", TraceType.OPERATION, parent.id);
      traceManager.startTrace("Child2", "child2", TraceType.OPERATION, parent.id);

      const children = traceManager.getChildren(parent.id);
      expect(children.length).toBe(2);
    });
  });

  describe("getTraceTree", () => {
    it("should return complete trace tree", () => {
      const parent = traceManager.startTrace("Parent", "parent");
      const child = traceManager.startTrace("Child", "child", TraceType.OPERATION, parent.id);
      traceManager.startTrace("GrandChild", "grandchild", TraceType.OPERATION, child.id);

      const tree = traceManager.getTraceTree(parent.id);
      expect(tree.length).toBe(3);
    });

    it("should return empty array for non-existent root", () => {
      const tree = traceManager.getTraceTree("non-existent");
      expect(tree).toEqual([]);
    });
  });

  // ==========================================================================
  // 导出功能
  // ==========================================================================

  describe("exportAsTimeline", () => {
    it("should export traces as timeline format", () => {
      traceManager.info("Test", "action1");
      traceManager.warn("Test", "action2");

      const timeline = traceManager.exportAsTimeline();
      expect(timeline.length).toBe(2);
      expect(timeline[0]).toHaveProperty("time");
      expect(timeline[0]).toHaveProperty("component");
      expect(timeline[0]).toHaveProperty("action");
      expect(timeline[0]).toHaveProperty("level");
    });
  });

  describe("exportToJSON", () => {
    it("should export traces as JSON string", () => {
      traceManager.info("Test", "action");

      const json = traceManager.exportToJSON();
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
    });
  });

  // ==========================================================================
  // 统计功能
  // ==========================================================================

  describe("getStats", () => {
    it("should calculate correct statistics", () => {
      const trace = traceManager.startTrace("Test", "operation");
      trace.success();

      traceManager.error("Test", "error1", new Error("error1"));
      traceManager.error("Test", "error2", new Error("error2"));
      traceManager.info("Test", "info");

      const stats = traceManager.getStats();
      expect(stats.totalCount).toBe(5); // start + success + 2 errors + info
      expect(stats.errorCount).toBe(2);
      expect(stats.byComponent["Test"]).toBe(5);
    });

    it("should calculate duration statistics", () => {
      const trace1 = traceManager.startTrace("Test", "op1");
      trace1.success();
      const trace2 = traceManager.startTrace("Test", "op2");
      trace2.success();

      const stats = traceManager.getStats();
      expect(stats.avgDuration).toBeGreaterThanOrEqual(0);
      expect(stats.maxDuration).toBeGreaterThanOrEqual(0);
      expect(stats.minDuration).toBeGreaterThanOrEqual(0);
    });

    it("should return zero for empty manager", () => {
      const stats = traceManager.getStats();
      expect(stats.totalCount).toBe(0);
      expect(stats.errorCount).toBe(0);
      expect(stats.avgDuration).toBe(0);
    });
  });

  // ==========================================================================
  // 订阅机制
  // ==========================================================================

  describe("subscribe", () => {
    it("should notify subscribers of new traces", () => {
      const listener = vi.fn();
      traceManager.subscribe(listener);

      traceManager.info("Test", "action");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "Test",
          action: "action",
        })
      );
    });

    it("should support multiple subscribers", () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      traceManager.subscribe(listener1);
      traceManager.subscribe(listener2);

      traceManager.info("Test", "action");

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it("should allow unsubscribe", () => {
      const listener = vi.fn();
      const unsubscribe = traceManager.subscribe(listener);

      traceManager.info("Test", "action1");
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      traceManager.info("Test", "action2");
      expect(listener).toHaveBeenCalledTimes(1); // Still 1
    });

    it("should handle subscriber errors gracefully", () => {
      const errorListener = vi.fn(() => {
        throw new Error("Subscriber error");
      });
      const normalListener = vi.fn();

      traceManager.subscribe(errorListener);
      traceManager.subscribe(normalListener);

      // Should not throw
      expect(() => traceManager.info("Test", "action")).not.toThrow();

      // Normal listener should still be called
      expect(normalListener).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 边界条件
  // ==========================================================================

  describe("maxSize limit", () => {
    it("should respect maxSize when adding traces", () => {
      const manager = new TraceManager({ maxSize: 3 });

      manager.info("Test", "action1");
      manager.info("Test", "action2");
      manager.info("Test", "action3");
      manager.info("Test", "action4");

      expect(manager.size()).toBe(3);
      const traces = manager.getAll();
      expect(traces[0].action).toBe("action2"); // Oldest removed
      expect(traces[2].action).toBe("action4");
    });

    it("should keep most recent traces when exceeding maxSize", () => {
      const manager = new TraceManager({ maxSize: 2 });

      for (let i = 1; i <= 5; i++) {
        manager.info("Test", `action${i}`);
      }

      const traces = manager.getAll();
      expect(traces.length).toBe(2);
      expect(traces[0].action).toBe("action4");
      expect(traces[1].action).toBe("action5");
    });
  });

  describe("clear", () => {
    it("should remove all traces", () => {
      traceManager.info("Test", "action1");
      traceManager.info("Test", "action2");

      expect(traceManager.size()).toBe(2);

      traceManager.clear();

      expect(traceManager.size()).toBe(0);
      expect(traceManager.getAll()).toEqual([]);
    });
  });

  describe("size", () => {
    it("should return correct count", () => {
      expect(traceManager.size()).toBe(0);

      traceManager.info("Test", "action1");
      expect(traceManager.size()).toBe(1);

      traceManager.info("Test", "action2");
      expect(traceManager.size()).toBe(2);
    });
  });
});

describe("Global TraceManager", () => {
  it("should provide singleton instance", async () => {
    const { getGlobalTraceManager, setGlobalTraceManager, TraceManager } =
      await import("../src/trace.js");

    const manager1 = getGlobalTraceManager();
    const manager2 = getGlobalTraceManager();

    expect(manager1).toBe(manager2);
    expect(manager1).toBeInstanceOf(TraceManager);
  });

  it("should allow setting custom global manager", async () => {
    const { getGlobalTraceManager, setGlobalTraceManager, TraceManager } =
      await import("../src/trace.js");

    const customManager = new TraceManager({ deviceId: "custom" });
    setGlobalTraceManager(customManager);

    const retrieved = getGlobalTraceManager();
    expect(retrieved).toBe(customManager);

    // Reset to default
    setGlobalTraceManager(new TraceManager());
  });
});
