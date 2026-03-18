import { Stagehand, type Page } from "@browserbasehq/stagehand";
import { z } from "zod";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";
import stagehandConfig from "../config/stagehand.config.js";

// --- 型定義 ---
export interface TestStep {
  id: number;
  name: string;
  action: string;
  type: "act" | "observe" | "extract";
  expect: string;
  variables?: Record<string, string>;
  schema?: Record<string, string>;
}

interface RawStep {
  include?: string;
  name?: string;
  action?: string;
  type?: "act" | "observe" | "extract";
  expect?: string;
  variables?: Record<string, string>;
  schema?: Record<string, string>;
}

export interface TestSuite {
  suite: {
    name: string;
    id: string;
    target_url: string;
    environment: string;
  };
  steps: TestStep[];
}

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] || "");
  }
  if (Array.isArray(obj)) return obj.map(resolveEnvVars);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, resolveEnvVars(v)]),
    );
  }
  return obj;
}

function resolveSteps(
  rawSteps: RawStep[],
  baseDir: string,
  ancestors: Set<string> = new Set(),
): TestStep[] {
  const resolved: Omit<TestStep, "id">[] = [];
  for (const step of rawSteps) {
    if (step.include) {
      const flowPath = path.resolve(baseDir, step.include);
      if (ancestors.has(flowPath)) {
        throw new Error(`Circular include detected: ${flowPath}`);
      }
      const flowRaw = yaml.load(fs.readFileSync(flowPath, "utf-8")) as {
        steps: RawStep[];
      };
      const flowDir = path.dirname(flowPath);
      const nextAncestors = new Set(ancestors).add(flowPath);
      resolved.push(...resolveSteps(flowRaw.steps, flowDir, nextAncestors));
    } else {
      resolved.push({
        name: step.name!,
        action: step.action!,
        type: step.type!,
        expect: step.expect!,
        variables: step.variables,
        schema: step.schema,
      });
    }
  }
  return resolved.map((s, i) => ({ ...s, id: i + 1 }));
}

export interface Evidence {
  stepId: number;
  stepName: string;
  action: string;
  expect: string;
  beforeScreenshot?: string;
  afterScreenshot?: string;
  result: "OK" | "NG";
  actual: string;
  extractedData?: any;
  timestamp: string;
  durationMs: number;
  error?: string;
}

export async function runTestSuite(yamlPath: string): Promise<{
  testSuite: TestSuite;
  evidences: Evidence[];
}> {
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const rawSuite = resolveEnvVars(yaml.load(raw)) as { suite: TestSuite["suite"]; steps: RawStep[] };
  const baseDir = path.dirname(path.resolve(yamlPath));
  const steps = resolveSteps(rawSuite.steps, baseDir);
  const testSuite: TestSuite = { suite: rawSuite.suite, steps };

  const outputDir = path.join("output", testSuite.suite.id);
  fs.rmSync(outputDir, { recursive: true, force: true });
  const evidenceDir = path.join(outputDir, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const stagehand = new Stagehand(stagehandConfig);
  await stagehand.init();
  const page = stagehand.page;

  await page.goto(testSuite.suite.target_url);

  const evidences: Evidence[] = [];

  for (const step of steps) {
    const evidence = await executeStep(page, step, evidenceDir);
    evidences.push(evidence);

    if (evidence.result === "NG") {
      console.error(`Step ${step.id} FAILED: ${evidence.error}`);
      break;
    }
  }

  await stagehand.close();
  return { testSuite, evidences };
}

async function executeStep(
  page: Page,
  step: TestStep,
  evidenceDir: string,
): Promise<Evidence> {
  const startTime = Date.now();
  const stepPrefix = `step${String(step.id).padStart(2, "0")}`;
  const needsBeforeAfter = step.type === "act";

  if (needsBeforeAfter) {
    await page.screenshot({
      path: path.join(evidenceDir, `${stepPrefix}_1_before.jpg`),
      fullPage: true,
      type: "jpeg",
      quality: 80,
    });
  }

  let result: "OK" | "NG" = "OK";
  let actual = "";
  let extractedData: any = undefined;
  let error: string | undefined;

  try {
    switch (step.type) {
      case "act": {
        await page.act(step.action);
        actual = `操作を正常に実行: ${step.action}`;
        break;
      }

      case "observe": {
        const observations = await page.observe(step.action);
        actual =
          observations.length > 0
            ? `画面上に${observations.length}件の要素を確認`
            : "対象要素が見つからなかった";
        if (observations.length === 0) {
          result = "NG";
          error = "期待する画面要素が見つからなかった";
        }
        break;
      }

      case "extract": {
        const zodShape: Record<string, z.ZodTypeAny> = {};
        if (step.schema) {
          for (const [key, type] of Object.entries(step.schema)) {
            zodShape[key] = type === "number" ? z.number() : z.string();
          }
        }
        extractedData = await page.extract({
          instruction: step.action,
          schema: z.object(zodShape),
        });
        actual = `データ取得: ${JSON.stringify(extractedData)}`;
        break;
      }
    }

    if (result === "OK" && step.expect) {
      const verdict = await page.extract({
        instruction: [
          `以下の期待結果が満たされているか判定してください。`,
          `期待結果: ${step.expect}`,
          `実際の状態: ${actual}`,
        ].join("\n"),
        schema: z.object({
          pass: z.boolean().describe("期待結果を満たしていればtrue"),
          reason: z.string().describe("判定理由"),
        }),
      });
      if (!verdict.pass) {
        result = "NG";
        error = verdict.reason;
      }
      actual = verdict.reason;
    }
  } catch (e: any) {
    result = "NG";
    error = e.message;
    actual = `エラー発生: ${e.message}`;
  }

  let screenshotFile: string | undefined;
  if (needsBeforeAfter) {
    screenshotFile = `${stepPrefix}_2_after.jpg`;
    await page.screenshot({
      path: path.join(evidenceDir, screenshotFile),
      fullPage: true,
      type: "jpeg",
      quality: 80,
    });
  } else if (result === "NG") {
    screenshotFile = `${stepPrefix}_ng.jpg`;
    await page.screenshot({
      path: path.join(evidenceDir, screenshotFile),
      fullPage: true,
      type: "jpeg",
      quality: 80,
    });
  }

  return {
    stepId: step.id,
    stepName: step.name,
    action: step.action,
    expect: step.expect,
    beforeScreenshot: needsBeforeAfter ? `${stepPrefix}_1_before.jpg` : undefined,
    afterScreenshot: screenshotFile,
    result,
    actual,
    extractedData,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    error,
  };
}
