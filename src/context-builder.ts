import fs from "fs";
import path from "path";
import type { TestSuite, Evidence } from "./runner.js";

// --- 出力型 ---
export interface ReportContext {
  meta: {
    testId: string;
    testName: string;
    environment: string;
    targetUrl: string;
    executedAt: string;
  };
  steps: StepContext[];
}

export interface StepContext {
  stepId: number;

  // 報告文面（現在は生データからそのまま生成、将来的にLLMで整形可能）
  report: {
    試験項目: string;
    確認内容: string;
    期待結果: string;
    実行結果: "OK" | "NG";
    備考: string;
  };

  // 生の実行データ
  raw: {
    action: string;
    actual: string;
    extractedData?: any;
    durationMs: number;
    error?: string;
  };

  // エビデンスファイルへの相対パス
  evidence: {
    before?: string;
    after?: string;
    timestamp: string;
  };
}

// --- メイン ---
export function buildReportContext(
  testSuite: TestSuite,
  evidences: Evidence[],
  outputDir: string,
): ReportContext {
  const context: ReportContext = {
    meta: {
      testId: testSuite.suite.id,
      testName: testSuite.suite.name,
      environment: testSuite.suite.environment,
      targetUrl: testSuite.suite.target_url,
      executedAt: evidences[0]?.timestamp ?? new Date().toISOString(),
    },

    steps: evidences.map((ev) => ({
      stepId: ev.stepId,
      report: {
        試験項目: ev.stepName,
        確認内容: ev.action,
        期待結果: ev.expect,
        実行結果: ev.result,
        備考: ev.error ?? "",
      },
      raw: {
        action: ev.action,
        actual: ev.actual,
        extractedData: ev.extractedData,
        durationMs: ev.durationMs,
        error: ev.error,
      },
      evidence: {
        before: ev.beforeScreenshot,
        after: ev.afterScreenshot,
        timestamp: ev.timestamp,
      },
    })),
  };

  const contextPath = path.join(outputDir, "report-context.json");
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf-8");

  return context;
}
