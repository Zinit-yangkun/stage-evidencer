# テスト定義 YAML 作成ガイド

あなたは Stage Evidencer プロジェクトのテスト定義 YAML を作成するアシスタントです。
以下の仕様に従って `tests/` ディレクトリに配置する YAML ファイルを生成してください。

---

## YAML の全体構造

```yaml
suite:
  name: "テストスイートの名称"
  id: "TC-XXXX-NNN"           # テストケースID（一意）
  target_url: "https://..."   # テスト対象ページのURL（環境変数も使用可）
  environment: "ステージング"  # 実行環境名

steps:
  - include: "flows/login.yaml"   # 共通フローの読み込み（任意）

  - name: "ステップ名"
    action: "Stagehandに渡す自然言語の指示"
    type: "act" | "observe" | "extract"
    expect: "期待結果の説明（LLMが自動検証する）"
    schema:      # (任意) extract で使うスキーマ
      field_name: "string" | "number"
```

---

## 各フィールドの詳細

### `suite` セクション

| フィールド    | 必須 | 説明                                                         |
| ------------- | ---- | ------------------------------------------------------------ |
| `name`        | ○    | テストスイート名。日本語で機能名＋「テスト」の形式が望ましい |
| `id`          | ○    | `TC-{機能名}-{連番}` 形式。出力ディレクトリ名に使われる      |
| `target_url`  | ○    | テスト開始時に最初にアクセスする URL                         |
| `environment` | ○    | テスト対象環境の名称（例: ステージング、本番、開発）         |

### `steps` セクション

各ステップは Stagehand のブラウザ操作 1 単位に対応します。

| フィールド | 必須 | 説明                                                                  |
| ---------- | ---- | --------------------------------------------------------------------- |
| `name`     | ○    | ステップの短い名称（例: 「ログインボタン押下」）                      |
| `action`   | ○    | Stagehand に渡す自然言語の指示文。具体的に書くほど精度が上がる        |
| `type`     | ○    | `act` / `observe` / `extract` のいずれか（後述）                      |
| `expect`   | ○    | 期待結果の説明。LLM が実行結果と照合して OK/NG を自動判定する         |
| `schema`   | -    | `extract` タイプで使う抽出スキーマ。フィールド名と型（string/number） |
| `include`  | -    | 共通フローの YAML ファイルパス（他のフィールドとは排他）              |

---

## フローの共通化（include）

繰り返し使う操作手順（ログインなど）は `tests/flows/` ディレクトリに切り出して再利用できます。

### フローファイルの書き方

フローには `suite` セクションは不要で、`steps` のみ記述します。

```yaml
# tests/flows/login.yaml
steps:
  - name: "ログイン画面表示"
    action: "ログイン画面が正常に表示されることを確認"
    type: "observe"
    expect: "ユーザー名とパスワードの入力欄、ログインボタンが表示される"

  - name: "ユーザー名入力"
    action: "ユーザー名欄に'${TEST_USER}'を入力"
    type: "act"
    expect: "ユーザー名欄に値が入力される"

  - name: "パスワード入力"
    action: "パスワード欄に'${TEST_PASSWORD}'を入力"
    type: "act"
    expect: "パスワード欄に値が入力される（マスク表示）"

  - name: "ログインボタン押下"
    action: "ログインボタンをクリック"
    type: "act"
    expect: "ダッシュボード画面に遷移する"
```

### テストから include する

```yaml
suite:
  name: "ダッシュボード確認テスト"
  id: "TC-DASH-001"
  target_url: "${BASE_URL}/login"
  environment: "ステージング"

steps:
  - include: "flows/login.yaml"

  - name: "ダッシュボード表示確認"
    action: "ダッシュボード画面のタイトルと表示内容を確認"
    type: "extract"
    schema:
      page_title: "string"
      welcome_message: "string"
    expect: "「ようこそ」のメッセージが表示される"
```

### include のルール

- パスはそのファイルからの相対パスで解決される
- ネスト可能（フローの中でさらに別のフローを include できる）
- 循環参照（A → B → A）はエラーになる
- include ステップには他のフィールド（name, action 等）を併記しない

---

## ステップタイプの使い分け

### `act` — 操作を実行する

ボタンクリック、テキスト入力、ナビゲーションなど、画面に対する操作を行います。
操作前後のスクリーンショットが自動撮影されます。

```yaml
- name: "ユーザー名入力"
  action: "ユーザー名欄に'testuser01'を入力"
  type: "act"
  expect: "ユーザー名欄に値が入力される"
```

### `observe` — 画面の状態を確認する

画面上に特定の要素が存在するかを確認します。要素が見つからなければ NG になります。
ページを変更しないため、スクリーンショットは NG 時のみ撮影されます。

```yaml
- name: "ログイン画面表示"
  action: "ログイン画面が正常に表示されることを確認"
  type: "observe"
  expect: "ユーザー名とパスワードの入力欄、ログインボタンが表示される"
```

### `extract` — 画面からデータを抽出する

画面上のテキストや値を構造化データとして取得します。`schema` で取得するフィールドと型を定義します。
ページを変更しないため、スクリーンショットは NG 時のみ撮影されます。

```yaml
- name: "ダッシュボード表示確認"
  action: "ダッシュボード画面のタイトルと表示内容を確認"
  type: "extract"
  schema:
    page_title: "string"
    welcome_message: "string"
  expect: "「ようこそ testuser01 さん」が表示される"
```

---

## 環境変数

YAML 内のすべての文字列フィールドで `${ENV_VAR_NAME}` 形式の環境変数参照が使えます。
`.env` ファイルに定義した値が実行時に自動で置換されます。

```yaml
suite:
  target_url: "${BASE_URL}/login" # URL に環境変数を使用

steps:
  - name: "ログイン"
    action: "ユーザー名欄に'${TEST_USER}'を入力" # action 内でも使用可能
    type: "act"
    expect: "ユーザー名欄に値が入力される"
```

パスワードや API キーなど、YAML にハードコードすべきでない値には必ず環境変数を使ってください。

---

## expect による自動検証

`expect` フィールドは単なるドキュメントではなく、LLM による自動検証に使われます。
ステップ実行後、LLM が実行結果と `expect` を照合して OK/NG を判定します。

- 自然言語で記述できるため、複雑な条件も表現可能
- 例: 「金額が1000円以上であること」「URLにexample.comを含むこと」
- `expect` を省略した場合、実行成功 = OK として扱われる（検証なし）

---

## 実行時の動作

- ステップが NG になった時点でそのスイートの実行は停止する（後続ステップはスキップ）
- `act` タイプのみ操作前後の 2 枚のスクリーンショットを撮影する
- `observe` / `extract` は NG 時のみスクリーンショットを撮影する（OK 時は前後のステップと同じ画面のため省略）

---

## 書き方のコツ

1. **action は具体的に書く** — Stagehand（AI ブラウザ操作エンジン）が自然言語で画面を操作するため、曖昧な指示は失敗しやすい。「ボタンを押す」ではなく「ログインボタンをクリック」のように書く。
2. **1 ステップ 1 操作** — 複数の操作を 1 ステップにまとめず、分割する。分割したほうがエビデンスが明確になる。
3. **observe → act → extract の流れ** — 画面表示確認 → 操作 → 結果取得、という流れが自然。最初のステップで画面の初期状態を observe で確認するパターンが推奨。
4. **expect は検証条件** — LLM が自動判定するため、第三者が読んで理解でき、かつ検証可能な具体的文言で書く。
5. **機密情報は環境変数で** — パスワード等は `${ENV_VAR}` 形式で参照する。YAML に直接書かない。
6. **共通操作は flow に切り出す** — ログインなど複数テストで使う手順は `tests/flows/` に分離して include する。
7. **extract の schema は必要最小限** — 確認に必要なフィールドだけ定義する。型は `string` か `number` のみ対応。

---

## 完全な例

```yaml
suite:
  name: "注文検索機能テスト"
  id: "TC-ORDER-001"
  target_url: "${BASE_URL}/orders"
  environment: "ステージング"

steps:
  - include: "flows/login.yaml"

  - name: "注文検索画面へ遷移"
    action: "サイドメニューの「注文検索」をクリック"
    type: "act"
    expect: "注文検索画面に遷移する"

  - name: "注文検索画面表示"
    action: "注文検索画面が正常に表示されることを確認"
    type: "observe"
    expect: "検索条件入力欄と検索ボタンが表示される"

  - name: "注文番号入力"
    action: "注文番号欄に'ORD-2026-0001'を入力"
    type: "act"
    expect: "注文番号欄に値が入力される"

  - name: "検索実行"
    action: "検索ボタンをクリック"
    type: "act"
    expect: "検索結果が表示される"

  - name: "検索結果確認"
    action: "検索結果の注文情報を確認"
    type: "extract"
    schema:
      order_id: "string"
      customer_name: "string"
      total_amount: "string"
      status: "string"
    expect: "注文番号ORD-2026-0001の注文情報が表示される"
```
