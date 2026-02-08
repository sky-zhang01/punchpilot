# PunchPilot

[freee 人事労務](https://www.freee.co.jp/hr/)向けのスマート勤怠自動化ツール。Docker コンテナとしてセルフホストし、Web ダッシュボードで管理できます。

[**English**](README.md) | [**中文**](README.zh-CN.md)

## 主な機能

- **自動打刻** — 設定したスケジュールで出退勤を自動記録、土日祝日は自動スキップ（日本/中国の祝日対応）
- **一括勤怠修正** — 未打刻の日をワンクリックで一括補正
- **4段階スマートフォールバック**：直接API > 承認申請 > 打刻 > Webフォーム（Playwright）
- **月次キャッシュ** — 失敗した方式を自動スキップ、毎月初に再検出
- **承認ワークフロー** — 勤務時間修正申請の提出・追跡・取り下げ
- **Web ダッシュボード** — カレンダー表示、実行ログ、リアルタイムステータス

## クイックスタート

```bash
# リポジトリをクローン
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot

# 設定
cp .env.example .env
# .env を編集 — 最低限 GUI_PASSWORD を設定

# 起動
docker compose up -d

# ダッシュボードを開く
open http://localhost:8681
```

初回ログイン時は `.env` に設定したパスワードを使用します。その後：
1. **OAuth 認証情報** — freee 開発者サイトでアプリを作成し、Client ID / Secret を入力
2. **認可** — PunchPilot に freee 人事労務アカウントへのアクセスを許可
3. **スケジュール** — 勤務時間と自動打刻時間を設定

## アーキテクチャ

```
┌──────────────┐     ┌──────────────────────────────────┐
│  ブラウザ     │────▶│         PunchPilot (Docker)       │
│ ダッシュボード │     │                                    │
└──────────────┘     │  Express API ─── React (Ant Design)│
                     │       │                            │
                     │  ┌────┴────┐    ┌───────────────┐ │
                     │  │ SQLite  │    │  Playwright    │ │
                     │  │(データ) │    │(Webフォールバック)│ │
                     │  └─────────┘    └───────────────┘ │
                     │       │                            │
                     │  ┌────┴────┐    ┌───────────────┐ │
                     │  │スケジューラ│    │ freee HR API   │ │
                     │  │ (cron)  │    │  (OAuth2)      │ │
                     │  └─────────┘    └───────────────┘ │
                     └──────────────────────────────────┘
```

**技術スタック**：Node.js、Express、React、Ant Design、Playwright、SQLite、Docker

## 一括勤怠修正の戦略

未打刻の勤怠を修正する際、PunchPilot は以下の4つの戦略を順番に試行します：

| 戦略 | 方式 | 速度 | 前提条件 |
|------|------|------|----------|
| 1. 直接書き込み | `PUT /work_records` | 即時 | 書き込み権限 |
| 2. 承認申請 | `POST /approval_requests` | 即時 | 承認経路 |
| 3. 打刻記録 | `POST /time_clocks` | 順次 | 基本アクセス |
| 4. Web フォーム | Playwright ブラウザ | 約20秒/件 | freee Web ログイン情報 |

毎月初に PunchPilot が自社環境に最適な戦略を自動検出してキャッシュします。失敗した戦略は当月中自動的にスキップされます。

## セキュリティ

- **暗号化**：すべての認証情報（freee パスワード、OAuth トークン）を AES-256-GCM で暗号化
- **鍵の分離**：暗号化キーは Docker 名前付きボリュームに格納し、データのバインドマウントと物理的に分離
- **非 root 実行**：コンテナは非特権ユーザー `ppuser` で実行
- **外部通信なし**：すべてのデータはユーザーと freee サーバー間のみで通信

## 設定

### 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `GUI_PASSWORD` | （必須） | Web ダッシュボードのログインパスワード |
| `TZ` | `Asia/Tokyo` | コンテナのタイムゾーン |
| `PORT` | `8681` | サーバーポート |

### Docker ボリューム

| パス | タイプ | 用途 |
|------|--------|------|
| `./data` | バインドマウント | SQLite データベース、ログ |
| `./screenshots` | バインドマウント | デバッグ用スクリーンショット |
| `keystore` | 名前付きボリューム | 暗号化キー（分離保管） |

## 開発

```bash
# 依存関係をインストール
npm install && cd client && npm install && cd ..

# 開発サーバーを起動（自動リロード）
npm run dev

# テストを実行
npm test

# クライアントをビルド
cd client && npx vite build
```

## Kubernetes

Kubernetes マニフェストは `k8s/` ディレクトリにあります。namespace、PVC、secret、deployment の設定は YAML ファイルを参照してください。

## 謝辞

本プロジェクトは [@newbdez33](https://github.com/newbdez33) 氏の [freee-checkin](https://github.com/newbdez33/freee-checkin) に着想を得て構築されました。オリジナルプロジェクトは Playwright ベースの freee 勤怠自動化の基盤を提供しました。PunchPilot はこれを拡張し、Web 管理画面、OAuth API 連携、マルチ戦略一括修正、エンタープライズセキュリティ機能を追加しています。

## ライセンス

[MIT](LICENSE)
