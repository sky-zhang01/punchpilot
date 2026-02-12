# PunchPilot

[freee 人事労務](https://www.freee.co.jp/hr/)向けのスマート勤怠自動化ツール。Docker コンテナとしてセルフホストし、Web ダッシュボードで管理できます。

[**English**](README.md) | [**中文**](README.zh-CN.md)

## 主な機能

- **自動打刻** — 設定したスケジュールで出退勤を自動記録、土日祝日は自動スキップ（日本/中国の祝日対応）
- **一括勤怠修正** — 未打刻の日をワンクリックで一括補正
- **休暇申請** — 有休・特別休暇・残業・欠勤の申請、追跡、取消
- **一括操作** — 休暇一括申請、一括取下げ、一括承認/差戻し
- **4段階スマートフォールバック**：直接API > 承認申請 > 打刻 > Webフォーム（Playwright）
- **月次キャッシュ** — 失敗した方式を自動スキップ、毎月初に再検出
- **承認ワークフロー** — 勤務時間修正申請の提出・追跡・取下げ；管理者による一括承認/差戻し
- **祝日カレンダー** — 日本の国民の祝日と中国の祝日（振替出勤日対応）
- **Web ダッシュボード** — カレンダー表示、実行ログ、リアルタイムステータス
- **多言語対応** — 英語・日本語・中国語

## クイックスタート

```bash
# リポジトリをクローン
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot

# 設定（任意）
cp .env.example .env

# 起動
docker compose up -d

# ダッシュボードを開く
open http://localhost:8681
```

初回ログイン時はデフォルト認証情報（`admin` / `admin`）を使用します。パスワード変更を求められます。その後：
1. **OAuth 認証情報** — freee 開発者サイトでアプリを作成し、Client ID / Secret を入力
2. **認可** — PunchPilot に freee 人事労務アカウントへのアクセスを許可
3. **スケジュール** — 勤務時間と自動打刻時間を設定

## アーキテクチャ

```
┌──────────────┐     ┌─────────────────────────────────────┐
│  ブラウザ     │────▶│         PunchPilot (Docker)         │
│ ダッシュボード │     │                                     │
└──────────────┘     │  Express API ─── React (Ant Design) │
                     │       │                             │
                     │  ┌────┴────┐    ┌─────────────────┐ │
                     │  │ SQLite  │    │  Playwright     │ │
                     │  │(データ)  │    │(Webフォールバック)│ │
                     │  └─────────┘    └─────────────────┘ │
                     │       │                             │
                     │  ┌────┴─────┐    ┌────────────────┐ │
                     │  │スケジューラ│    │ freee HR API   │ │
                     │  │ (cron)   │    │  (OAuth2)      │ │
                     │  └──────────┘    └────────────────┘ │
                     └─────────────────────────────────────┘
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

- **暗号化**：すべての認証情報（freee パスワード、OAuth トークン）を AES-256-GCM で暗号化；鍵は scrypt で導出
- **鍵の分離**：暗号化キーは Docker 名前付きボリュームに格納し、データのバインドマウントと物理的に分離
- **認証強化**：bcrypt パスワードハッシュ、初回ログイン時パスワード変更強制、CSPRNG セッショントークン、ログインレート制限（10回/15分）
- **セキュリティヘッダー**：CSP、HSTS、X-Frame-Options DENY、X-Content-Type-Options nosniff
- **非 root 実行**：コンテナは非特権ユーザー UID 568 で実行（TrueNAS `apps` ユーザー互換）
- **外部通信なし**：すべてのデータはユーザーと freee サーバー間のみで通信
- **ログの無害化**：サーバーログやクライアントエラーレスポンスにトークン、パスワード、個人情報を含まない

## 対応プラットフォーム

PunchPilot はマルチアーキテクチャ Docker イメージとして配布しています。

| アーキテクチャ | プラットフォーム | 対応ハードウェア例 |
|---|---|---|
| `linux/amd64` | x86_64 | Intel/AMD サーバー、PC、ほとんどのクラウド VM |
| `linux/arm64` | aarch64 | Apple M シリーズ（M1/M2/M3/M4）、AWS Graviton、Raspberry Pi 4+ |

> **Windows / macOS**：[Docker Desktop](https://www.docker.com/products/docker-desktop/) で同じ Linux イメージを実行できます（内部で軽量 Linux VM を使用）。

```bash
# イメージを取得
docker pull ghcr.io/sky-zhang01/punchpilot:latest

# または docker-compose で起動（推奨）
docker compose up -d
```

## 設定

### 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
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

## 謝辞

本プロジェクトは [@newbdez33](https://github.com/newbdez33) 氏の [freee-checkin](https://github.com/newbdez33/freee-checkin) に着想を得て構築されました。オリジナルプロジェクトは Playwright ベースの freee 勤怠自動化の基盤を提供しました。PunchPilot はこれを拡張し、Web 管理画面、OAuth API 連携、マルチ戦略一括修正、エンタープライズセキュリティ機能を追加しています。

## ライセンス

[MIT](LICENSE)
