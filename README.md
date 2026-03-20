# Threads AI Agent System

Threads（Meta）を AI エージェントで自動運用するシステム。
6つの専門エージェントが独立して動作し、ネタ収集→分析→投稿生成→人間レビュー→投稿→監視のサイクルを回す。

> **LLM**: Claude Opus（`claude -p` ヘッドレスモード / サブスクリプション内動作）
> **ランタイム**: Bun + TypeScript
> **外部依存**: ゼロ（devDeps のみ）

---

## アーキテクチャ

```
                     cron / launchd
                          │
         ┌────────────────┼────────────────────┐
         ▼                ▼                    ▼
  ┌─────────────┐  ┌─────────────┐   ┌──────────────┐
  │  Researcher  │  │   Analyst   │   │  Supervisor   │
  │  毎朝 6:00   │  │  毎朝 6:30  │   │   毎時        │
  │  LLM (opus)  │  │  LLM (opus) │   │  ルールベース  │
  └──────┬──────┘  └──────┬──────┘   └──────┬───────┘
         │                │                  │
         ▼                ▼                  ▼
  ┌──────────────────────────────────────────────┐
  │           data/ (JSON ステートストア)           │
  └──────────────────────┬───────────────────────┘
                         │
                         ▼
                ┌─────────────────┐
                │     Writer       │
                │   毎朝 7:00      │
                │   LLM (opus)     │
                └────────┬────────┘
                         │ status: "draft"
                         ▼
                ┌─────────────────┐
                │   Review Queue   │     ← bun run review
                │   人間がレビュー   │
                └────────┬────────┘
                         │ status: "queued"
                         ▼
                ┌─────────────────┐     ┌──────────┐
                │     Poster       │     │ Fetcher  │
                │   各スロット時刻   │     │ 1日2回   │
                │   Threads API    │     │ メトリクス │
                └─────────────────┘     └──────────┘
```

### エージェント一覧

| エージェント | 役割 | LLM | 実行頻度 |
|-------------|------|-----|---------|
| **Researcher** | テーマツリーから手薄なネタを補充 | opus | 1日1回 |
| **Analyst** | 投稿パフォーマンスを分析、ライターにフィードバック | opus | 1日1回 |
| **Writer** | 投稿を生成、独立レビュアーで採点、品質チェック | opus | 1日1回 |
| **Poster** | 承認済み投稿を Threads API で投稿 | 不要 | 各スロット |
| **Fetcher** | 投稿のメトリクス（views, likes 等）を取得 | 不要 | 1日2回 |
| **Supervisor** | エラー監視、パターン検出、キルスイッチ管理 | 不要 | 毎時 |

### 自己改善ループ

各 LLM エージェントは実行後に**振り返り**を行い、`data/memory/{agent}.json` に学びを蓄積。
次回実行時にプロンプトへ注入することで、回を重ねるごとに精度が向上する。

```
実行 → 結果ログ → 振り返り(LLM) → 学びを保存 → 次回プロンプトに注入
  ↑                                                     │
  └─────────────────────────────────────────────────────┘
```

---

## セットアップ

### 前提条件

- [Bun](https://bun.sh/) がインストール済み
- [Claude Code](https://claude.ai/code) がインストール済み & ログイン済み（`claude -p` が動くこと）
- Threads API のアクセストークン（投稿する場合）

### インストール

```bash
git clone <repo-url> && cd agent-sns
bun install
```

### 環境変数

```bash
# Threads API（投稿・メトリクス取得に必要）
export THREADS_ACCESS_TOKEN="your_token"
export THREADS_USER_ID="your_user_id"
```

### 動作確認

```bash
# システム状態を確認
bun run status

# リサーチャーを単独実行
bun run agent:research

# ライターを実行（投稿を draft として生成）
bun run agent:write

# 生成された投稿をレビュー
bun run review
```

---

## 運用コマンド一覧

### エージェント実行

```bash
bun run agent:research     # ネタ収集
bun run agent:analyze      # パフォーマンス分析
bun run agent:write        # 投稿生成（→ draft）
bun run agent:post         # 承認済み投稿を1件投稿
bun run agent:fetch        # メトリクス取得
bun run agent:supervise    # システム監視
```

### 運用ツール

```bash
bun run review             # 投稿レビューUI（承認/却下/編集）
bun run status             # ダッシュボード表示
bun run setup-cron         # crontab エントリ生成
bun run kill               # 緊急停止（キルスイッチ）
```

### キルスイッチ

```bash
# 緊急停止
bun run kill

# 復旧
bun run agent:supervise -- --reset
```

---

## cron 設定

`bun run setup-cron` を実行すると、config に基づいた crontab エントリが出力される。

```bash
# 生成例
bun run setup-cron

# 出力された内容を crontab に追加
crontab -e
```

### デフォルトスケジュール

| 時刻 | エージェント | 内容 |
|------|-------------|------|
| 06:00 | Researcher | ネタ収集 |
| 06:30 | Analyst | 分析 |
| 07:00 | Writer | 投稿生成 |
| 07:30, 09:00, ... | Poster | 各スロットで投稿 |
| 10:00, 22:00 | Fetcher | メトリクス取得 |
| 毎時 | Supervisor | 監視 |

**重要**: Writer が生成した投稿は `draft` 状態。`bun run review` で承認しないと投稿されない。

---

## 投稿フロー

```
Writer が生成
    │
    ▼
┌──────────┐
│  draft   │  ← bun run review でレビュー
└────┬─────┘
     │
  ┌──┴──┐
  ▼     ▼
queued  rejected
  │
  ▼ (cron で bun run agent:post)
posted
```

### レビュー UI

```bash
$ bun run review

╔════════════════════════════════════════════════════════╗
║  [1/5] post_20260320_001                              ║
║  パターン: short_statement │ テーマ: ai_tools          ║
║  平均スコア: 7.8                                       ║
╠════════════════════════════════════════════════════════╣
║  📊 品質スコア詳細                                     ║
║  フック力        ████████░░ 8.0                        ║
║  有用性          ███████░░░ 7.0                        ║
║  ...                                                  ║
╠════════════════════════════════════════════════════════╣
║  📝 投稿内容                                           ║
║  Claude Code、マジでヤバい。                            ║
║  ファイル操作もコマンド実行も全部AIが...                  ║
╠════════════════════════════════════════════════════════╣
║  [a]承認  [r]却下  [e]編集  [s]スキップ  [q]終了        ║
╚════════════════════════════════════════════════════════╝
```

---

## ディレクトリ構成

```
agent-sns/
├── src/
│   ├── agents/              # 6エージェント（各自独立実行）
│   │   ├── researcher.ts
│   │   ├── analyst.ts
│   │   ├── writer.ts
│   │   ├── poster.ts
│   │   ├── fetcher.ts
│   │   └── supervisor.ts
│   ├── core/
│   │   ├── llm.ts           # claude -p ラッパー
│   │   ├── store.ts          # データ永続化・パス解決・ログ
│   │   └── memory.ts         # 自己改善メモリシステム
│   ├── cli/
│   │   ├── review.ts         # 投稿レビューUI
│   │   ├── status.ts         # ダッシュボード
│   │   ├── setup-cron.ts     # crontab 生成
│   │   └── kill.ts           # 緊急停止
│   └── types/
│       └── index.ts
├── knowledge/                # ジャンル定義（差し替えでジャンル変更可能）
│   ├── persona/ai_tech.json
│   ├── patterns/post_patterns.json
│   └── themes/ai_tech_tree.json
├── config/system.json        # スケジュール・安全装置
├── data/                     # 実行時データ（自動生成、gitignore対象）
│   ├── history/posts.json
│   ├── queue/queue.json
│   ├── metrics/metrics.json
│   ├── memory/               # エージェントの学習メモリ
│   └── logs/
├── package.json
├── tsconfig.json
└── .gitignore
```

---

## 安全装置

| 項目 | 設定値 | 説明 |
|------|--------|------|
| 品質スコア閾値 | 7.0 / 10.0 | 独立レビュアーによる採点 |
| 類似度閾値 | 0.85 | 日本語 n-gram + Intl.Segmenter |
| 1日最大投稿数 | 15件 | JST ベースで日次リセット |
| 最小投稿間隔 | 60分 | スケジュールスロットで制御 |
| 連続エラー自動停止 | 3回 | エージェント単位 |
| KILL SWITCH | 有効 | `bun run kill` で即時停止 |
| パターン連続上限 | 2回 | 同一パターンの連続を防止 |
| テーマ連続上限 | 3回 | 同一テーマの連続を防止 |
| 人間レビュー | 必須 | draft → queued は人間の承認が必要 |
| ファイルロック | 有効 | 同時書き込み防止 |

---

## ジャンル変更

`knowledge/` 配下のファイルを差し替えるだけで別ジャンルに対応可能。

1. `knowledge/persona/` に新しいペルソナ JSON を作成
2. `knowledge/themes/` に新しいテーマツリーを作成
3. `config/system.json` の `system.genre` を更新
4. `config/system.json` の `persona`, `patterns`, `themes` パスを更新（必要に応じて）

---

## 設計原則

1. **1エージェント = 1タスク** — 責務を混ぜない
2. **ナレッジとロジックの分離** — `knowledge/` 差し替えでジャンル変更
3. **状態は JSON で永続化** — エージェントが前回の文脈を保持
4. **安全装置は最優先** — 品質/類似度/上限/間隔/KILL SWITCH を絶対にバイパスしない
5. **人間が最終防壁** — 投稿前に必ずレビュー（運用が安定したら自動化可能）
6. **自律的改善** — 各エージェントが実行結果を振り返り、次回に活かす
