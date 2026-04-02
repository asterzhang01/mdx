/**
 * 场景测试运行器
 *
 * 提供用户工作流模拟能力：
 *   - 模拟用户操作序列
 *   - 多设备同步场景
 *   - 网络延迟模拟
 *   - 文件系统同步模拟
 *   - Trace 收集与验证
 */
import { MemoryFileSystemAdapter } from "../../src/adapters/memory-fs-adapter.js";
// import { SyncEngine } from "../../src/sync-engine.js";
import {
  TraceManager,
  TraceLevel,
  TraceType,
  getGlobalTraceManager,
  setGlobalTraceManager,
  type TraceEntry,
} from "../../src/utils/trace.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface UserAction {
  /** 操作类型 */
  type: string;
  /** 操作参数 */
  params?: Record<string, unknown>;
  /** 预期延迟 (ms) */
  delay?: number;
}

export interface ScenarioStep {
  /** 步骤描述 */
  description?: string;
  /** 执行的操作 */
  action: string;
  /** 操作参数 */
  params?: Record<string, unknown>;
  /** 执行前等待 (ms) */
  waitBefore?: number;
  /** 执行后等待 (ms) */
  waitAfter?: number;
}

export interface ScenarioResult {
  /** 是否成功 */
  success: boolean;
  /** 执行步骤数 */
  stepCount: number;
  /** 总耗时 (ms) */
  duration: number;
  /** 最终内容 */
  finalContent?: string;
  /** 收集的 Trace */
  traces: TraceEntry[];
  /** 错误信息 */
  error?: string;
  /** 每步结果 */
  stepResults: StepResult[];
  /** 生成的文件 */
  files: string[];
}

export interface StepResult {
  /** 步骤索引 */
  index: number;
  /** 操作 */
  action: string;
  /** 是否成功 */
  success: boolean;
  /** 耗时 (ms) */
  duration: number;
  /** 错误信息 */
  error?: string;
  /** 产生的 Trace IDs */
  traceIds: string[];
}

export interface DeviceSimulation {
  /** 设备 ID */
  deviceId: string;
  /** 设备名称 */
  name: string;
  /** 同步引擎 */
  // engine: SyncEngine;
  /** 文件系统 */
  fs: MemoryFileSystemAdapter;
}

// ============================================================================
// 场景运行器
// ============================================================================

export class ScenarioRunner {
  private fs: MemoryFileSystemAdapter;
  // private engines: Map<string, SyncEngine> = new Map();
  private traceManager: TraceManager;
  private basePath: string;
  private stepResults: StepResult[] = [];
  private files: Set<string> = new Set();

  constructor(options: { basePath?: string; deviceId?: string } = {}) {
        this.basePath = options.basePath ?? "/test/scenario";
        this.fs = new MemoryFileSystemAdapter();
        this.traceManager = new TraceManager();
      }

  // -------------------------------------------------------------------------
  // 环境设置
  // -------------------------------------------------------------------------

  /**
   * 设置干净的测试环境
   */
  async setupCleanEnvironment(): Promise<void> {
    // this.engines.clear();
    this.stepResults = [];
    this.files.clear();
    this.traceManager.clear();

    // 创建基础目录 (mkdir 在 MemoryFileSystemAdapter 中是 no-op)
    await this.fs.mkdir(this.basePath);

    this.traceManager.info("ScenarioRunner", "setupCleanEnvironment", {
      basePath: this.basePath,
    });
  }

  /**
   * 创建新文档
   */
  async createDocument(
    docPath: string,
    content: string = "# Untitled\n\n"
  ): Promise<void> { // Promise<SyncEngine> {
    const fullPath = `${this.basePath}/${docPath}`;

    // 创建文档目录结构（在 MemoryFileSystemAdapter 中通过写入文件模拟）
    await this.fs.writeTextFile(`${fullPath}/index.md`, content);
    await this.fs.writeTextFile(`${fullPath}/.mdx/.initialized`, Date.now().toString());

    this.files.add(fullPath);

    this.traceManager.info("ScenarioRunner", "createDocument", {
      path: fullPath,
      contentLength: content.length,
    });
  }

  /**
   * 加载已有文档
   */
  async loadDocument(docPath: string): Promise<void> { // Promise<SyncEngine> {
    this.traceManager.info("ScenarioRunner", "loadDocument", {
      path: `${this.basePath}/${docPath}`,
    });
  }

  // -------------------------------------------------------------------------
  // 场景执行
  // -------------------------------------------------------------------------

  /**
   * 运行场景步骤序列
   */
  async run(steps: ScenarioStep[]): Promise<ScenarioResult> {
    const startTime = performance.now();
    this.stepResults = [];

    this.traceManager.startTrace("ScenarioRunner", "run", TraceType.OPERATION);

    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepStartTime = performance.now();
        const traceIds: string[] = [];

        if (step.waitBefore) {
          await this.delay(step.waitBefore);
        }

        const trace = this.traceManager.startTrace(
          "ScenarioRunner",
          `step:${step.action}`,
          TraceType.OPERATION
        );

        try {
          await this.executeStep(step);
          trace.success({ stepIndex: i });
          traceIds.push(trace.id);

          this.stepResults.push({
            index: i,
            action: step.action,
            success: true,
            duration: performance.now() - stepStartTime,
            traceIds,
          });
        } catch (error) {
          trace.error(error as Error, { stepIndex: i });
          traceIds.push(trace.id);

          this.stepResults.push({
            index: i,
            action: step.action,
            success: false,
            duration: performance.now() - stepStartTime,
            error: (error as Error).message,
            traceIds,
          });

          break;
        }

        if (step.waitAfter) {
          await this.delay(step.waitAfter);
        }
      }

      const duration = performance.now() - startTime;
      const success = this.stepResults.every((r) => r.success);

      return {
        success,
        stepCount: steps.length,
        duration,
        traces: this.traceManager.getAll(),
        stepResults: this.stepResults,
        files: Array.from(this.files),
        finalContent: this.getPrimaryContent(),
      };
    } catch (error) {
      return {
        success: false,
        stepCount: steps.length,
        duration: performance.now() - startTime,
        traces: this.traceManager.getAll(),
        stepResults: this.stepResults,
        files: Array.from(this.files),
        error: (error as Error).message,
      };
    }
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(step: ScenarioStep): Promise<void> {
    const { action, params = {} } = step;

    switch (action) {
      case "createDocument":
        await this.createDocument(
          (params.path as string) ?? "doc.mdx",
          (params.content as string) ?? "# New Document\n\n"
        );
        break;

      case "reopenDocument": {
        const docPath = (params.path as string) ?? "doc.mdx";
        await this.loadDocument(docPath);
        break;
      }

      case "wait":
        await this.delay((params.ms as number) ?? 100);
        break;

      case "simulateNetworkDelay":
        await this.delay((params.ms as number) ?? 100);
        break;

      case "renameDocument": {
        const oldPath = params.oldPath as string;
        const newPath = params.newPath as string;
        await this.renameDocument(oldPath, newPath);
        break;
      }

      case "verifyDocumentName": {
        const expectedPath = params.expectedPath as string;
        const exists = await this.fs.exists(`${this.basePath}/${expectedPath}`);
        if (!exists) {
          throw new Error(`Expected document ${expectedPath} does not exist`);
        }
        break;
      }

      default:
        console.warn(`Unknown or disabled action: ${action}`);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // 多设备模拟
  // -------------------------------------------------------------------------

  /**
   * 模拟多设备场景
   */
  async simulateMultiDevice(
    devices: Array<{ id: string; name: string }>,
    scenario: (devices: DeviceSimulation[]) => Promise<void>
  ): Promise<void> {
    const deviceSims: DeviceSimulation[] = [];

    for (const device of devices) {
      const deviceFs = new MemoryFileSystemAdapter();
      const devicePath = `${this.basePath}/devices/${device.id}`;
      await deviceFs.mkdir(devicePath);

      deviceSims.push({
        deviceId: device.id,
        name: device.name,
        // engine,
        fs: deviceFs,
      });

      this.traceManager.info("ScenarioRunner", "createDevice", {
        deviceId: device.id,
        name: device.name,
      });
    }

    await scenario(deviceSims);
  }

  /**
   * 模拟文件同步
   */
  async simulateFileSync(
    fromFs: MemoryFileSystemAdapter,
    toFs: MemoryFileSystemAdapter,
    filePath: string
  ): Promise<void> {
    const content = await fromFs.readTextFile(filePath);
    await toFs.writeTextFile(filePath, content);

    this.traceManager.info("ScenarioRunner", "simulateFileSync", {
      filePath,
    });
  }

  // -------------------------------------------------------------------------
  // 辅助方法
  // -------------------------------------------------------------------------

  /**
   * 获取主文档内容
   */
  private getPrimaryContent(): string | undefined {
    return undefined;
  }

  /**
   * 延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -------------------------------------------------------------------------
  // 验证辅助
  // -------------------------------------------------------------------------

  /**
   * 验证 Trace 序列
   */
  validateTraceSequence(
    expected: Array<{ component: string; action: string }>
  ): boolean {
    const traces = this.traceManager.getAll();

    if (traces.length < expected.length) {
      return false;
    }

    for (let i = 0; i < expected.length; i++) {
      if (
        traces[i].component !== expected[i].component ||
        traces[i].action !== expected[i].action
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取 Trace 统计
   */
  getTraceStats() {
    return this.traceManager.getStats();
  }

  /**
   * 查询 Trace
   */
  queryTraces(filters: Parameters<TraceManager["query"]>[0]) {
    return this.traceManager.query(filters);
  }

  /**
   * 获取所有 Trace
   */
  getAllTraces(): TraceEntry[] {
    return this.traceManager.getAll();
  }

  /**
   * 重命名文档
   */
  async renameDocument(oldPath: string, newPath: string): Promise<void> {
    const oldFullPath = `${this.basePath}/${oldPath}`;
    const newFullPath = `${this.basePath}/${newPath}`;

    const exists = await this.fs.exists(oldFullPath);
    if (!exists) {
      throw new Error(`Document ${oldPath} does not exist`);
    }

    const allPaths = this.fs.listAllPaths();
    const pathsToRename = allPaths.filter((p) =>
      p.startsWith(oldFullPath + "/") || p === oldFullPath
    );

    for (const oldFilePath of pathsToRename) {
      const newFilePath = oldFilePath.replace(oldFullPath, newFullPath);
      const data = await this.fs.readFile(oldFilePath);
      await this.fs.writeFile(newFilePath, data);
      await this.fs.unlink(oldFilePath);
    }

    this.files.delete(oldFullPath);
    this.files.add(newFullPath);

    this.traceManager.info("ScenarioRunner", "renameDocument", {
      oldPath,
      newPath,
      filesRenamed: pathsToRename.length,
    });
  }

  /**
   * 获取文件系统适配器（用于验证）
   */
  getFs(): MemoryFileSystemAdapter {
    return this.fs;
  }

  /**
   * 获取基础路径
   */
  getBasePath(): string {
    return this.basePath;
  }

  /**
   * 清理资源
   */
  destroy(): void {
    this.traceManager.clear();
  }
}

// ============================================================================
// 场景断言辅助
// ============================================================================

export function expectScenarioSuccess(result: ScenarioResult): void {
  if (!result.success) {
    const failedSteps = result.stepResults
      .filter((r) => !r.success)
      .map((r) => `Step ${r.index} (${r.action}): ${r.error}`)
      .join("\n");
    throw new Error(`Scenario failed:\n${failedSteps}`);
  }
}

export function expectNoErrorTraces(result: ScenarioResult): void {
  const errorTraces = result.traces.filter(
    (t) => t.level >= TraceLevel.ERROR || t.error !== undefined
  );
  if (errorTraces.length > 0) {
    const errors = errorTraces
      .map((t) => `[${t.component}] ${t.action}: ${t.error?.message ?? "Unknown"}`)
      .join("\n");
    throw new Error(`Found error traces:\n${errors}`);
  }
}

export function expectPerformanceWithin(
  result: ScenarioResult,
  maxDuration: number
): void {
  if (result.duration > maxDuration) {
    throw new Error(
      `Scenario took ${result.duration}ms, expected within ${maxDuration}ms`
    );
  }
}

export function expectStepOrder(
  result: ScenarioResult,
  expectedActions: string[]
): void {
  const actualActions = result.stepResults.map((r) => r.action);
  const matches = expectedActions.every(
    (action, index) => actualActions[index] === action
  );
  if (!matches) {
    throw new Error(
      `Expected steps: ${expectedActions.join(", ")}\nActual: ${actualActions.join(", ")}`
    );
  }
}
