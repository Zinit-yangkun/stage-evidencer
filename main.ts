import { runTestSuite } from "./src/runner.js";
import { buildReportContext } from "./src/context-builder.js";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";

interface SuiteResult {
  yamlPath: string;
  suiteName: string;
  suiteId: string;
  passed: boolean;
  totalDurationMs: number;
}

function collectYamlFiles(dirPath: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
      files.push(path.join(dirPath, entry.name));
    }
  }
  return files.sort();
}

async function runSingle(yamlPath: string): Promise<SuiteResult> {
  const raw = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as any;

  console.log(`\n▶ テスト実行開始: ${raw.suite.name} (${yamlPath})`);
  const { testSuite, evidences } = await runTestSuite(yamlPath);

  const passed = evidences.every((e) => e.result === "OK");
  const totalDurationMs = evidences.reduce((sum, e) => sum + e.durationMs, 0);
  console.log(`✓ 実行完了: ${passed ? "PASS" : "FAIL"}`);

  const outputDir = path.join("output", testSuite.suite.id);
  console.log(`▶ 報告書コンテキスト生成中...`);
  buildReportContext(testSuite, evidences, outputDir);
  console.log(`✓ 出力完了: ${outputDir}/report-context.json`);

  return {
    yamlPath,
    suiteName: testSuite.suite.name,
    suiteId: testSuite.suite.id,
    passed,
    totalDurationMs,
  };
}

function printSummary(results: SuiteResult[]) {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const totalDurationMs = results.reduce((sum, r) => sum + r.totalDurationMs, 0);
  const totalDurationSec = (totalDurationMs / 1000).toFixed(1);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  テスト実行サマリー`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  スイート数: ${total} (成功: ${passed}, 失敗: ${failed})`);
  console.log(`  成功率: ${total > 0 ? ((passed / total) * 100).toFixed(1) : 0}%`);
  console.log(`  合計実行時間: ${totalDurationSec}s`);
  console.log(`${"─".repeat(60)}`);

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const durationSec = (r.totalDurationMs / 1000).toFixed(1);
    console.log(`  [${status}] ${r.suiteName} (${durationSec}s)`);
  }

  console.log(`${"═".repeat(60)}\n`);
}

async function main() {
  const target = process.argv[2] || "tests";
  const stat = fs.statSync(target);

  let yamlFiles: string[];
  if (stat.isDirectory()) {
    yamlFiles = collectYamlFiles(target);
    if (yamlFiles.length === 0) {
      console.error(`エラー: ${target} にYAMLファイルが見つかりません`);
      process.exit(1);
    }
    console.log(`▶ ${target} から ${yamlFiles.length} 件のテストスイートを検出`);
  } else {
    yamlFiles = [target];
  }

  const results: SuiteResult[] = [];
  for (const yamlPath of yamlFiles) {
    const result = await runSingle(yamlPath);
    results.push(result);
  }

  if (results.length > 1) {
    printSummary(results);
  }

  const hasFailure = results.some((r) => !r.passed);
  if (hasFailure) {
    process.exit(1);
  }
}

main().catch(console.error);
