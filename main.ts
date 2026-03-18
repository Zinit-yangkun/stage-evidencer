import { runTestSuite } from "./src/runner.js";
import { buildReportContext } from "./src/context-builder.js";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";

async function main() {
  const yamlPath = process.argv[2] || "tests/login.yaml";
  const raw = yaml.load(fs.readFileSync(yamlPath, "utf-8")) as any;

  console.log(`▶ テスト実行開始: ${raw.suite.name}`);
  const { testSuite, evidences } = await runTestSuite(yamlPath);

  const ok = evidences.filter((e) => e.result === "OK").length;
  const ng = evidences.filter((e) => e.result === "NG").length;
  console.log(`✓ 実行完了: OK=${ok}, NG=${ng}`);

  const outputDir = path.join("output", testSuite.suite.id);
  console.log(`▶ 報告書コンテキスト生成中...`);
  buildReportContext(testSuite, evidences, outputDir);
  console.log(`✓ 出力完了: ${outputDir}/report-context.json`);
}

main().catch(console.error);
