# Stagehand + AI 自動テスト報告書生成パイプライン 設計書

# Stage Evidencer

## 全体アーキテクチャ

```
test-suite.yaml（テスト定義）
  → TestRunner（Stagehand で実行 + 毎ステップ自動スクリーンショット）
    → Evidence[]（証迹データ配列）
      → ContextBuilder（LLM で報告書コンテキストを生成）
        → report-context.json（構造化コンテキスト）
        → evidence/（スクリーンショット群）
            ↓
    ＜ここから下流＞
    別 Agent が MCP 経由で report-context.json を読み取り
    → 試験報告書.xlsx を生成
```

テスト実行側の責務は **report-context.json と スクリーンショット群を出力するところまで**。
report-context.json には テスト実行時に発生した事実だけ を詰める。
書式・集計・報告書メタ情報（作成者等）は下流の責務。

## ディレクトリ構成

```
project/
├── config/
│   └── stagehand.config.ts       # Stagehand 初期設定
├── tests/
│   ├── login.yaml                # テストスイート定義
│   └── order-search.yaml
├── src/
│   ├── runner.ts                 # テスト実行エンジン
│   └── context-builder.ts        # 報告書コンテキスト生成（LLM）
├── output/
│   └── TC-LOGIN-001/
│       ├── report-context.json   # ★ 下流Agent向けコンテキスト
│       └── evidence/
│           ├── step01_before.png
│           ├── step01_after.png
│           └── ...
├── .env
└── package.json
```

## 1. テスト定義（YAML）

```yaml
# tests/login.yaml

suite:
  name: "ログイン機能テスト"
  id: "TC-LOGIN-001"
  target_url: "https://example.com/login"
  environment: "ステージング"

steps:
  - id: 1
    name: "ログイン画面表示"
    action: "ログイン画面が正常に表示されることを確認"
    type: "observe"
    expect: "ユーザー名とパスワードの入力欄、ログインボタンが表示される"

  - id: 2
    name: "ユーザー名入力"
    action: "ユーザー名欄に'testuser01'を入力"
    type: "act"
    variables:
      username: "testuser01"
    expect: "ユーザー名欄に値が入力される"

  - id: 3
    name: "パスワード入力"
    action: "パスワード欄に入力"
    type: "act"
    variables:
      password: "${TEST_PASSWORD}"
    expect: "パスワード欄に値が入力される（マスク表示）"

  - id: 4
    name: "ログインボタン押下"
    action: "ログインボタンをクリック"
    type: "act"
    expect: "ダッシュボード画面に遷移する"

  - id: 5
    name: "ダッシュボード表示確認"
    action: "ダッシュボード画面のタイトルと表示内容を確認"
    type: "extract"
    schema:
      page_title: "string"
      welcome_message: "string"
    expect: "「ようこそ testuser01 さん」が表示される"
```

## 2. テスト実行エンジン（runner.ts）

```typescript
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import yaml from "js-yaml";
import fs from "fs";
import path from "path";

// --- 型定義 ---
interface TestStep {
  id: number;
  name: string;
  action: string;
  type: "act" | "observe" | "extract";
  expect: string;
  variables?: Record<string, string>;
  schema?: Record<string, string>;
}

interface TestSuite {
  suite: {
    name: string;
    id: string;
    target_url: string;
    environment: string;
  };
  steps: TestStep[];
}

interface Evidence {
  stepId: number;
  stepName: string;
  action: string;
  expect: string;
  beforeScreenshot: string;
  afterScreenshot: string;
  result: "OK" | "NG";
  actual: string;
  extractedData?: any;
  timestamp: string;
  durationMs: number;
  error?: string;
}

async function runTestSuite(yamlPath: string): Promise<{
  testSuite: TestSuite;
  evidences: Evidence[];
}> {
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const testSuite = yaml.load(raw) as TestSuite;
  const { suite, steps } = testSuite;

  const outputDir = path.join("output", suite.id);
  const evidenceDir = path.join(outputDir, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  const stagehand = new Stagehand({
    env: "LOCAL",
    model: "google/gemini-2.5-flash",
    enableCaching: true,
    selfHeal: true,
  });
  await stagehand.init();
  const page = stagehand.context.pages()[0];

  await page.goto(suite.target_url);

  const evidences: Evidence[] = [];

  for (const step of steps) {
    const evidence = await executeStep(stagehand, page, step, evidenceDir);
    evidences.push(evidence);

    if (evidence.result === "NG") {
      console.error(`Step ${step.id} FAILED: ${evidence.error}`);
    }
  }

  await stagehand.close();
  return { testSuite, evidences };
}

async function executeStep(
  stagehand: Stagehand,
  page: any,
  step: TestStep,
  evidenceDir: string,
): Promise<Evidence> {
  const startTime = Date.now();
  const stepPrefix = `step${String(step.id).padStart(2, "0")}`;

  const beforeFile = `${stepPrefix}_before.png`;
  await page.screenshot({
    path: path.join(evidenceDir, beforeFile),
    fullPage: true,
  });

  let result: "OK" | "NG" = "OK";
  let actual = "";
  let extractedData: any = undefined;
  let error: string | undefined;

  try {
    const resolvedVars: Record<string, string> = {};
    if (step.variables) {
      for (const [key, value] of Object.entries(step.variables)) {
        resolvedVars[key] = value.startsWith("${")
          ? process.env[value.slice(2, -1)] || ""
          : value;
      }
    }

    switch (step.type) {
      case "act":
        await stagehand.act(step.action, { variables: resolvedVars });
        actual = `操作を正常に実行: ${step.action}`;
        break;

      case "observe":
        const actions = await stagehand.observe(step.action);
        actual =
          actions.length > 0
            ? `画面上に${actions.length}件の要素を確認`
            : "対象要素が見つからなかった";
        if (actions.length === 0) {
          result = "NG";
          error = "期待する画面要素が見つからなかった";
        }
        break;

      case "extract":
        const zodShape: Record<string, any> = {};
        if (step.schema) {
          for (const [key, type] of Object.entries(step.schema)) {
            zodShape[key] = type === "number" ? z.number() : z.string();
          }
        }
        extractedData = await stagehand.extract(
          step.action,
          z.object(zodShape),
        );
        actual = `データ取得: ${JSON.stringify(extractedData)}`;
        break;
    }
  } catch (e: any) {
    result = "NG";
    error = e.message;
    actual = `エラー発生: ${e.message}`;
  }

  const afterFile = `${stepPrefix}_after.png`;
  await page.screenshot({
    path: path.join(evidenceDir, afterFile),
    fullPage: true,
  });

  return {
    stepId: step.id,
    stepName: step.name,
    action: step.action,
    expect: step.expect,
    beforeScreenshot: beforeFile,
    afterScreenshot: afterFile,
    result,
    actual,
    extractedData,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    error,
  };
}

export { runTestSuite, TestSuite, TestStep, Evidence };
```

## 3. 報告書コンテキスト生成（context-builder.ts）

Excel は作らない。LLM で報告文面を生成し、実行データと合わせて JSON に保存するだけ。

```typescript
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { TestSuite, Evidence } from "./runner";

// --- 出力型 ---
interface ReportContext {
  meta: {
    testId: string;
    testName: string;
    environment: string;
    targetUrl: string;
    executedAt: string;
  };
  steps: StepContext[];
}

interface StepContext {
  stepId: number;

  // LLMが生成した正式な報告文面
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
    before: string;
    after: string;
    timestamp: string;
  };
}

// --- メイン ---
async function buildReportContext(
  testSuite: TestSuite,
  evidences: Evidence[],
  outputDir: string,
): Promise<ReportContext> {
  const llmReports = await generateReportText(testSuite, evidences);

  const context: ReportContext = {
    meta: {
      testId: testSuite.suite.id,
      testName: testSuite.suite.name,
      environment: testSuite.suite.environment,
      targetUrl: testSuite.suite.target_url,
      executedAt: evidences[0]?.timestamp ?? new Date().toISOString(),
    },

    steps: evidences.map((ev) => {
      const llm = llmReports.find((r) => r.stepId === ev.stepId);
      return {
        stepId: ev.stepId,
        report: {
          試験項目: llm?.試験項目 ?? ev.stepName,
          確認内容: llm?.確認内容 ?? ev.action,
          期待結果: llm?.期待結果 ?? ev.expect,
          実行結果: ev.result,
          備考: llm?.備考 ?? ev.error ?? "",
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
      };
    }),
  };

  const contextPath = path.join(outputDir, "report-context.json");
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf-8");

  return context;
}

// --- LLMで報告文面を生成 ---
interface LLMStepReport {
  stepId: number;
  試験項目: string;
  確認内容: string;
  期待結果: string;
  備考: string;
}

async function generateReportText(
  testSuite: TestSuite,
  evidences: Evidence[],
): Promise<LLMStepReport[]> {
  const client = new Anthropic();

  const evidenceSummary = evidences.map((e) => ({
    項番: e.stepId,
    試験項目: e.stepName,
    操作内容: e.action,
    期待結果: e.expect,
    実行結果: e.result,
    実際の動作: e.actual,
    取得データ: e.extractedData,
    エラー: e.error,
    実行時間ms: e.durationMs,
  }));

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `
あなたは日本のSIerで働く品質管理エンジニアです。
以下の自動テスト実行結果から、試験報告書に記載する内容を生成してください。

## テストスイート情報
- テスト名: ${testSuite.suite.name}
- テストID: ${testSuite.suite.id}
- 対象環境: ${testSuite.suite.environment}

## 実行結果
${JSON.stringify(evidenceSummary, null, 2)}

## 出力形式
以下のJSON配列のみを出力してください。前後に説明文は不要です:
[
  {
    "stepId": 1,
    "試験項目": "正式な試験項目名",
    "確認内容": "具体的な確認内容の記述",
    "期待結果": "正式な期待結果の記述",
    "備考": "NGの場合の原因や補足（OKの場合は空文字）"
  }
]

## 記述ルール
- 常体（だ・である調）で記述
- 技術的に正確かつ簡潔に記述
- 「確認した」「問題なし」などの曖昧な表現は避け、具体的に何を確認したか記述
- 試験項目名は元のステップ名を正式な日本語に整える
`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
}

export { buildReportContext, ReportContext, StepContext };
```

## 4. エントリポイント（main.ts）

```typescript
import { runTestSuite } from "./src/runner";
import { buildReportContext } from "./src/context-builder";
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
  await buildReportContext(testSuite, evidences, outputDir);
  console.log(`✓ 出力完了: ${outputDir}/report-context.json`);
}

main().catch(console.error);
```

```bash
npx ts-node main.ts tests/login.yaml
```

## 5. 出力される report-context.json の例

```json
{
  "meta": {
    "testId": "TC-LOGIN-001",
    "testName": "ログイン機能テスト",
    "environment": "ステージング",
    "targetUrl": "https://example.com/login",
    "executedAt": "2026-03-17T10:30:00.000Z"
  },
  "steps": [
    {
      "stepId": 1,
      "report": {
        "試験項目": "ログイン画面の初期表示",
        "確認内容": "ログイン画面にアクセスし、ユーザー名入力欄、パスワード入力欄、ログインボタンの3要素が画面上に存在することを確認した",
        "期待結果": "ユーザー名入力欄、パスワード入力欄、ログインボタンが表示される",
        "実行結果": "OK",
        "備考": ""
      },
      "raw": {
        "action": "ログイン画面が正常に表示されることを確認",
        "actual": "画面上に3件の要素を確認",
        "durationMs": 1520
      },
      "evidence": {
        "before": "step01_before.png",
        "after": "step01_after.png",
        "timestamp": "2026-03-17T10:30:00.000Z"
      }
    },
    {
      "stepId": 2,
      "report": {
        "試験項目": "ユーザー名の入力",
        "確認内容": "ユーザー名入力欄にテストユーザーID「testuser01」を入力し、入力欄に値が反映されることを確認した",
        "期待結果": "ユーザー名欄に「testuser01」が入力される",
        "実行結果": "OK",
        "備考": ""
      },
      "raw": {
        "action": "ユーザー名欄に'testuser01'を入力",
        "actual": "操作を正常に実行: ユーザー名欄に'testuser01'を入力",
        "durationMs": 2100
      },
      "evidence": {
        "before": "step02_before.png",
        "after": "step02_after.png",
        "timestamp": "2026-03-17T10:30:02.000Z"
      }
    }
  ]
}
```

## 6. 下流 Agent との接続イメージ

下流の Excel 生成 Agent は、このディレクトリだけ受け取れば仕事ができる:

```
output/TC-LOGIN-001/
├── report-context.json    ← テスト実行の事実と LLM 整形済みテキスト
└── evidence/              ← スクリーンショット群
    ├── step01_before.png
    ├── step01_after.png
    └── ...
```

MCP 経由での接続パターン:

```
下流 Agent
  → MCP filesystem tool で report-context.json を読み取り
  → steps[].report をそのまま Excel の行データとして使用
  → 必要に応じて steps[].raw で補足判断
  → 書式・集計・作成者等は下流側で独自に決定
  → MCP excel-writer tool で xlsx を生成
  → 必要に応じて evidence/ 内の画像を xlsx に埋め込み
```

### 上流と下流の責務分離

| 関心事                       | 担当                               |
| ---------------------------- | ---------------------------------- |
| テスト実行・証迹収集         | 上流（本パイプライン）             |
| 各ステップの報告文面         | 上流（LLM で生成）                 |
| OK/NG 集計・合否判定         | 下流（steps を数えるだけ）         |
| 報告書の書式・体裁           | 下流（テンプレート or Agent 判断） |
| 作成者・承認者等のメタ情報   | 下流（プロジェクト設定から注入）   |
| スクリーンショットの埋め込み | 下流（必要に応じて）               |

## 7. 拡張ポイント

### NG時のスクリーンショット解析

NG発生時のみ、操作後スクリーンショットを Claude Vision に渡して
エラーの原因分析テキストを raw に追加する。
下流 Agent はそれを備考欄に反映できる。

### CI/CD連携

GitHub Actions で自動実行し、output/ ディレクトリを Artifacts として保存。
後続の報告書生成 workflow が Artifacts をダウンロードして Excel 化する。

### 既存の試験仕様書との連携

顧客から提供された試験仕様書（Excel）を読み取り、
YAML 形式に自動変換するスクリプトを追加すれば、
既存のワークフローとシームレスに統合できる。

### 複数テストスイートの統合報告書

複数の report-context.json を集約して
1つの統合報告書コンテキストを生成する aggregator を追加すれば、
機能単位ではなくリリース単位の報告書にも対応できる。
