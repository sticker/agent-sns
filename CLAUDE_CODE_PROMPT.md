# Threads AI Agent System — Claude Code 実装プロンプト

## プロジェクト概要

Threads（Meta）で AI・テック系アカウントを完全自動運用するマルチエージェントシステム。
6つの専門AIエージェントが分業し、リサーチ→分析→投稿生成→投稿実行→データ取得→監視の全サイクルを自動で回す。

**技術スタック:** TypeScript / Bun / Anthropic Claude API / Threads API
**目標:** `bun run pipeline` 1コマンドで日次サイクルが回り、`cron` でポスターが分散投稿する状態

---

## 現在のプロジェクト状態

プロジェクトの骨格（型定義、6エージェント、ナレッジファイル、パイプライン）は作成済み。
ただし以下の **重大なバグ・設計不備が多数ある** ので、修正しながら動く状態に持っていってほしい。

### ディレクトリ構成

```
agent-sns/
├── src/
│   ├── agents/           # 6エージェント
│   │   ├── researcher.ts   # ① リサーチャー（ネタ収集）
│   │   ├── analyst.ts      # ② アナリスト（分析）
│   │   ├── writer.ts       # ③ ライター（投稿生成）
│   │   ├── poster.ts       # ④ ポスター（投稿実行）
│   │   ├── fetcher.ts      # ⑤ フェッチャー（メトリクス取得）
│   │   └── supervisor.ts   # ⑥ スーパーバイザー（監視）
│   ├── core/
│   │   └── base-agent.ts   # エージェント基底クラス
│   ├── types/
│   │   └── index.ts        # 全型定義
│   └── pipeline.ts         # パイプライン（メインエントリ）
├── knowledge/              # ナレッジ（差し替えでジャンル変更可能）
│   ├── persona/ai_tech.json
│   ├── patterns/post_patterns.json
│   └── themes/ai_tech_tree.json
├── config/system.json
├── data/                   # 実行時データ（自動生成）
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 🔴 修正必須のバグ・不備一覧

以下を優先度順に全て修正すること。

### 【P0: 致命的バグ】

1. **`pipeline.ts` の `post` コマンドが未実装**
   - `bun run post` が何もしない。cron運用の要なので必ず実装する
   - キューから「現在のタイムスロットに該当する投稿」を1件取り出し、ポスターに渡して投稿
   - 投稿後、キューから削除し、`posts.json` のステータスを `posted` に更新
   - `dailyPostCount` をインクリメントする

2. **`dailyPostCount` が一度もインクリメントされない**
   - パイプライン中でもポスター実行時でもカウントが増えない
   - スーパーバイザーの日次上限チェック（15件）が機能していない

3. **`pipeline.ts` のパス解決が相対パス (`./data`) で壊れやすい**
   - `process.cwd()` が `threads-agents/` でないと全データファイルが見つからない
   - `import.meta.dir` (Bun) か `__dirname` を基準にした絶対パス解決に変更する

4. **`pipeline.ts` の `isRunning` フラグが終了時に `false` に戻らない**
   - パイプライン正常終了時も異常終了時も `isRunning = false` にする（finally ブロック）
   - 二重実行防止: 開始時に `isRunning === true` なら警告して終了する

5. **`PipelineResult` に `schedulerResult` があるが、対応するエージェントが存在しない**
   - `schedulerResult` を削除するか、用途に合わせてリネームする

### 【P1: 機能的な欠陥】

6. **ライターの類似度チェックが日本語で機能しない**
   - `checkSimilarity()` がスペース区切りでトークナイズしているが、日本語にはスペースがない
   - 文字レベルの n-gram (2-gram, 3-gram) に変更するか、`Intl.Segmenter` で日本語分かち書きする
   - Bun は `Intl.Segmenter` をサポートしているので推奨

7. **ライターの自己採点がバイアスを持つ（自分で書いて自分で採点）**
   - LLMは自分の出力に甘い点を付ける傾向がある
   - 対策案:
     a. 別のLLM呼び出しで採点する（推奨: systemPromptを「厳格な品質審査員」に設定した別chatで採点）
     b. 最低でも、ライターのsystemPromptに「採点は厳しくしろ。7.0以上は全体の60%以下にしろ」と明記

8. **ライターのリトライが未実装**
   - 参考記事には「2回書き直してもダメなら棄却」とあるが、現在は品質NG→即棄却
   - 品質スコアが閾値未満の場合、フィードバック付きで再生成を2回試みる

9. **ポスターがスケジュール遅延を考慮しない**
   - `assignToSlots()` が単純に先頭から割り当てるだけで、現在時刻を見ていない
   - cronで `bun run post` を実行した時点で「次のスロット」を判定し、まだ投稿されていないスロットに投稿する
   - 過去のスロット（もう過ぎた時間帯）はスキップする

10. **ポスター・フェッチャーが不要にBaseAgentを継承してAnthropicクライアントを初期化している**
    - LLMを使わないエージェントは別の軽量基底クラスにするか、BaseAgentからLLMインスタンス生成を遅延にする

11. **リサーチャーに未使用のimport (`readFileSync`, `writeFileSync`, `existsSync`)がある**
    - 削除する

12. **リサーチャーのsystemPromptがジャンルをハードコード（"AI・テック系"）**
    - ペルソナJSONからジャンル名を動的に参照する

13. **ライターのsystemPromptもペルソナルールをハードコード**
    - ペルソナJSONの `rules.mustFollow`, `rules.ngWords`, `persona.tone`, `persona.firstPerson` を動的に埋め込む
    - パターンも同様に `post_patterns.json` からプロンプトに組み込む

### 【P2: 運用品質】

14. **データの肥大化対策がない**
    - `research_items.json`: `usedCount > 2` かつ `collectedAt` が30日以上前のものを定期的に削除
    - `posts.json`: 必要に応じてアーカイブ（直近500件だけ保持）
    - `queue.json`: 投稿済みのものは残さない

15. **ログがconsole.logだけ**
    - `data/logs/` に日次のログファイルを書き出す (`pipeline_YYYYMMDD.log`)
    - 各エージェントの実行時間・結果サマリーを記録

16. **`.gitignore` がない**
    - `data/`, `node_modules/`, `.env`, `dist/` を除外する

17. **Threads APIのレートリミット処理が不十分**
    - ポスターの `createTextPost` → `publish` 間に待機が必要（公式は少なくとも数秒待てと推奨）
    - フェッチャーの 200ms 待機は足りない可能性がある。429エラー時にバックオフする

18. **`base-agent.ts` の `chat()` メソッドで `temperature` パラメータが受け取れるが API に渡していない**
    - `this.client.messages.create()` に `temperature` を追加する

19. **ThemeNode型とテーマツリーJSONの不一致**
    - `ThemeNode` 型には `postCount`, `avgPerformance`, `description` が必須だが、テーマツリーJSONの子ノードにはこれらがない
    - 型をoptionalにするか、JSONに初期値を追加する

20. **`config/system.json` の閾値と `types/index.ts` の定数が二重管理**
    - configから読む or 定数から読むの一本化

---

## 実装してほしい追加機能

### 必須

1. **`bun run post` コマンドの完全実装**
   - 現在時刻に最も近いタイムスロットを判定
   - キューから `status: "queued"` の投稿を1件取得
   - Threads APIで投稿実行
   - ステータス更新 + dailyPostCount インクリメント
   - cron用の1ショット設計（1回の実行で1件だけ投稿）

2. **ドライランモード (`bun run pipeline --dry-run`)**
   - API呼び出しせずにパイプライン全体を実行
   - LLMは呼ぶが、Threads APIは呼ばない
   - 生成された投稿の内容・品質スコアを確認できる
   - 初期セットアップ時の動作確認に必須

3. **crontab 設定スクリプトの生成**
   - `config/system.json` のタイムスロットからcrontabエントリを自動生成
   - 例: `30 7 * * * cd /path/to/threads-agents && bun run post >> data/logs/cron.log 2>&1`

### あると嬉しい

4. **バズピボット機能**
   - 投稿のメトリクスが閾値を超えた（バズった）場合、関連投稿を3本自動派生生成
   - アナリストが「バズ投稿」を検知 → リサーチャーが派生ネタを生成 → ライターが投稿作成

5. **簡易ダッシュボード (`bun run status`)**
   - 現在のシステム状態・キュー数・直近投稿のパフォーマンスを表示

---

## コード品質の指針

- **Bun のAPI**を積極的に使う（`Bun.file()`, `Bun.write()`, `import.meta.dir` 等）
- **エラーハンドリング**: 全ての外部API呼び出しにtry-catch + 適切なログ
- **型安全**: `as unknown as T` のようなキャストを可能な限り排除。型ガードを使う
- **テスト**: 最低限、ライターの類似度チェックとスーパーバイザーのKILL SWITCH のユニットテストを書く
- **コメント**: 日本語で。各関数に何をやっているかの1行コメント

---

## 動作確認の手順

修正が完了したら、以下の順序で動作確認する:

```bash
# 1. 依存関係インストール
bun install

# 2. 環境変数設定（まずはAnthropicのAPIキーだけでOK）
cp .env.example .env
# ANTHROPIC_API_KEY を設定

# 3. ドライランでパイプライン実行
bun run pipeline --dry-run

# 4. 生成された投稿の確認
cat data/queue/queue.json | bun -e "console.log(JSON.parse(await Bun.stdin.text()).length, '件のキュー')"

# 5. 品質スコアの分布確認
# → 平均7.0前後に収まっているか
# → 全部8.5以上みたいな甘い採点になっていないか

# 6. 類似度チェックの確認
# → 同じテーマ・パターンの投稿が連続していないか

# 7. システム状態の確認
bun run status
```

---

## 重要な設計原則（変更しないこと）

1. **1エージェント = 1タスク** — エージェントの責務を混ぜない
2. **ナレッジとロジックの分離** — `knowledge/` を差し替えるだけでジャンル変更
3. **状態はJSONで永続化** — AIが前回の文脈を持てる
4. **安全装置は最優先** — 品質/類似度/上限/間隔/KILL SWITCH を絶対にバイパスしない
