# PunchPilot

[freee 人事労務](https://www.freee.co.jp/hr/)向けのスマート勤怠自動化ツール。Docker コンテナとしてセルフホストし、Web ダッシュボードで管理できます。

[**English**](README.md) | [**中文**](README.zh-CN.md)

## 主な機能

- **自動打刻** — 設定したスケジュールで出退勤を自動記録、土日祝日は自動スキップ（日本/中国の祝日対応）
- **手動トリガー** — ダッシュボードから出勤・退勤・休憩開始・休憩終了をワンクリック実行
- **複数休憩対応** — 1日に何度でも休憩サイクルを記録可能；ダッシュボードとカレンダーで各休憩の開始・終了時刻を動的に表示
- **リアルタイム打刻状況** — freee の実際の打刻時刻をダッシュボードに表示、進捗バーでリアルタイム追跡
- **一括勤怠修正** — 未打刻の日をワンクリックで一括補正
- **休暇申請** — 有休・特別休暇・残業・欠勤の申請、追跡、取消
- **一括操作** — 休暇一括申請、一括取下げ、一括承認/差戻し
- **安全な3経路フォールバック**：直接API > 承認申請 > 検証済みWebフォーム（Playwright）
- **月次キャッシュ** — 失敗した方式を自動スキップ、毎月初に再検出
- **OAuth 認可ガード** — 認可の期限切れや失効時は自動打刻を停止し、再認可が必要な状態を明示
- **承認済み休暇ガード** — 各予定打刻の直前に、利用可能なら Public API、Browser-only モードでは認証済みの勤怠画面を使って freee を再確認
- **承認ワークフロー** — 勤務時間修正申請の提出・追跡・取下げ；管理者による一括承認/差戻し
- **祝日カレンダー** — 日本の国民の祝日と中国の祝日（振替出勤日対応）
- **Web ダッシュボード** — カレンダー表示、実行ログ、リアルタイムステータス
- **多言語対応** — 英語・日本語・中国語

## クイックスタート

```bash
# リポジトリをクローン
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot

# ローカル設定ファイルを作成
cp .env.example .env

# 起動
docker compose up -d

# ダッシュボードを開く
open http://localhost:8681
```

初回起動時に、PunchPilot は `admin` ユーザー用の高エントロピーなワンタイムパスワードを生成します。ログへコピーせず、次のコマンドで読み取ってログインし、ユーザー名とパスワードを変更します：

```bash
docker compose exec punchpilot cat /app/keystore/initial-admin-password
```

初回変更後、bootstrap ファイルは自動削除されます。その後：
1. **打刻経路** — API 権限がある場合は OAuth API モード、ない場合は freee Web 認証情報を使う Browser モードを選択
2. **休暇ガード** — 利用可能な場合は OAuth 読み取り権限を推奨；Browser-only モードでは認証済みの freee 勤怠画面から休暇を確認
3. **スケジュール** — 勤務時間と自動打刻時間を設定

OAuth 認可がない場合、Browser モードは打刻前に同じ認証済み Web セッションで当日の勤怠を確認します。対象日の記録やデータ構造を確実に確認できない場合、予定打刻は送信せず停止します。

Browser 認証情報の保存後、または既存の Browser モード環境を v0.5.0 に更新した後は、設定画面で **検証** を一度実行してください。対象の freee 従業員本人を確認できるまで予定処理は停止します。

## アーキテクチャ

```
┌──────────────┐     ┌─────────────────────────────────────┐
│  ブラウザ     │────▶│         PunchPilot (Docker)         │
│ ダッシュボード │     │                                     │
└──────────────┘     │  Express API ─── React (Ant Design) │
                     │       │                             │
                     │  ┌────┴────┐    ┌─────────────────┐ │
                     │  │ SQLite  │    │  Playwright     │ │
                     │  │(データ)  │    │  (Webモード)     │ │
                     │  └─────────┘    └─────────────────┘ │
                     │       │                             │
                     │  ┌────┴─────┐    ┌────────────────┐ │
                     │  │スケジューラ│    │ freee HR API   │ │
                     │  │ (cron)   │    │  (OAuth2)      │ │
                     │  └──────────┘    └────────────────┘ │
                     └─────────────────────────────────────┘
```

**技術スタック**：Node.js、Express 5、React 19、Ant Design 6、Vite 8、Playwright、SQLite、Docker

## 一括勤怠修正の戦略

未打刻の勤怠を修正する際、PunchPilot は以下の安全な3経路を順番に試行します：

| 戦略 | 方式 | 速度 | 前提条件 |
|------|------|------|----------|
| 1. 直接書き込み | `PUT /work_records` | 即時 | 書き込み権限 |
| 2. 承認申請 | `POST /approval_requests` | 即時 | 承認経路 |
| 3. Web フォーム | Playwright ブラウザ | Web 応答に依存 | freee Web ログイン情報 |

毎月初に PunchPilot が自社環境に最適な戦略を自動検出してキャッシュします。途中失敗をロールバックできないため、過去日の修正に逐次打刻 API は使用しません。

## セキュリティ

- **暗号化**：すべての認証情報（freee パスワード、OAuth トークン）を AES-256-GCM で暗号化；鍵は scrypt で導出
- **鍵の分離**：暗号化キーは Docker 名前付きボリュームに格納し、データのバインドマウントと物理的に分離
- **認証強化**：高エントロピーなワンタイム初期パスワード、bcrypt ハッシュ、初回変更強制、CSPRNG セッション、ログインレート制限（10回/15分）
- **セッション保存**：SQLite にはセッショントークンの一方向ハッシュのみを保存
- **セキュリティヘッダー**：CSP（form-action、base-uri 含む）、HSTS、X-Frame-Options DENY、X-Content-Type-Options nosniff、Permissions-Policy、COEP、CORP
- **OAuth fail-closed 動作**：認可の期限切れや失効時はスケジュール実行を停止し、ダッシュボードとログに再認可状態を表示
- **休暇ガードの fail-closed 動作**：API または Browser モードで当日の勤怠記録を確認できない場合、誤打刻を避けるため予定処理を停止
- **静的キャッシュ**：ハッシュ化資産（1年イミュータブル）、favicon（1日）、index.html（キャッシュなし）
- **非 root 実行**：0 または不正な `PUID`/`PGID` を拒否し、アプリ起動前に権限を降格（デフォルト 1000、TrueNAS は 568）
- **テレメトリなし**：認証情報と勤怠データの送信先は freee のみ；祝日機能は公開カレンダーデータのみ取得
- **ブラウザ成果物**：スクリーンショットはデフォルト無効；明示的に有効化した場合も認証必須で自動削除
- **ブラウザ分離**：標準 Compose 構成では Chromium を非 root で実行し、namespace/seccomp sandbox を有効化
- **依存関係の来歴確認**：リリース前に npm 署名、lockfile の SHA-512、7日間の公開待機期間を検証；緊急のセキュリティ例外は対象を固定し、公開根拠と期限を必須化
- **エラーの無害化**：トークン、パスワード、認証フォーム画像、freee ページ本文をクライアントエラーに含めない

## 対応プラットフォーム

PunchPilot はマルチアーキテクチャ Docker イメージとして配布しています。

| アーキテクチャ | プラットフォーム | 対応ハードウェア例 |
|---|---|---|
| `linux/amd64` | x86_64 | Intel/AMD サーバー、PC、ほとんどのクラウド VM |
| `linux/arm64` | aarch64 | Apple M シリーズ（M1/M2/M3/M4）、AWS Graviton、Raspberry Pi 4+ |

> **Windows / macOS**：[Docker Desktop](https://www.docker.com/products/docker-desktop/) で同じ Linux イメージを実行できます（内部で軽量 Linux VM を使用）。

```bash
# バージョン固定イメージを取得
docker pull ghcr.io/sky-zhang01/punchpilot:0.5.1

# Compose も同じマルチアーキテクチャ版を取得
docker compose pull
docker compose up -d

# 本番を厳密に固定する場合はリリースノート記載の digest を使用
PUNCHPILOT_IMAGE=ghcr.io/sky-zhang01/punchpilot@sha256:<digest> docker compose up -d
```

## 設定

### 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `TZ` | `Asia/Tokyo` | コンテナのタイムゾーン |
| `PORT` | `8681` | サーバーポート |
| `PUID` / `PGID` | `1000` | 実行ユーザー/グループ；標準の TrueNAS Apps では両方を `568` に設定 |
| `PUNCHPILOT_IMAGE` | `ghcr.io/sky-zhang01/punchpilot:0.5.1` | Compose が使用する公開イメージタグまたはリリース manifest digest |
| `TRUST_PROXY` | 無効 | 信頼するリバースプロキシの IP/CIDR、または `loopback`、`linklocal`、`uniquelocal`；未設定時は転送ヘッダーを無視 |
| `PUNCHPILOT_PUBLIC_ORIGIN` | loopback のみ | loopback 外で使う正規 HTTPS origin；リクエストヘッダーを信頼せず、書き込み検証、Secure cookie、HSTS、OAuth callback を固定 |
| `OAUTH_REDIRECT_URI` | 自動導出 | 任意の freee callback URI；正規 origin と一致し、パスは `/api/config/oauth-callback` であること |
| `SHUTDOWN_GRACE_MS` | `510000` | 終了時に実行中のスケジューラ、ブラウザ、一括処理、アカウント処理、HTTP リクエストの完了を待つ時間 |
| `APP_SECRET` | `keystore` 内で生成 | 32バイト以上の任意暗号化シークレット；保存後は既存の keystore シークレットと完全一致しない限り起動を停止 |
| `PUNCHPILOT_INITIAL_ADMIN_PASSWORD` | 未設定 | 16バイト以上の任意初期パスワード；コンテナ環境は参照可能なため、既定のファイル方式を推奨 |
| `PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE` | `/app/keystore/initial-admin-password` | 初期シークレットファイル；存在しない場合は `0600` で生成し、初回変更後に削除 |
| `BROWSER_SCREENSHOTS` | `off` | `off`、`errors`、`all`；管理された調査時のみ有効化 |
| `CHROMIUM_SANDBOX` | `false` | Chromium 内部 sandbox を有効化；同梱 Compose は検証済み seccomp profile と共に `true` を設定 |
| `BROWSER_IDLE_TIMEOUT_MS` | `300000` | Chromium をアイドル後に終了するまでの時間 |
| `BROWSER_SESSION_TTL_MS` | `28800000` | ディスクに保存しないメモリ内 Web セッションの再利用時間 |
| `AUTOMATION_QUEUE_TIMEOUT_MS` | `540000` | 直列化されたアカウントまたはブラウザ処理の最大待機時間；1件の処理タイムアウトより長く設定 |
| `AUTOMATION_OPERATION_TIMEOUT_MS` | `480000` | 直列化されたブラウザ処理1件のハードタイムアウト；`1..480000` の範囲外では起動を停止 |

同梱 Compose 構成は、固定した Playwright seccomp profile、最小限の起動 capability、`no-new-privileges` を使って Chromium sandbox を有効化します。イメージ単体の環境では、コンテナランタイムに同じ profile を適用できる場合だけ `CHROMIUM_SANDBOX=true` を設定してください。本番環境で `seccomp=unconfined` や `SYS_ADMIN` に置き換えないでください。

ホスト名またはリバースプロキシ経由でダッシュボードへ接続する場合は `PUNCHPILOT_PUBLIC_ORIGIN` を設定してください。平文 HTTP は `localhost`、`127.0.0.1`、`[::1]` のみ許可し、外部 origin は HTTPS 必須です。`OAUTH_REDIRECT_URI` を設定する場合、origin は一致している必要があります。

### Docker ボリューム

| パス | タイプ | 用途 |
|------|--------|------|
| `./data` | バインドマウント | SQLite データベース、ログ |
| `./screenshots` | バインドマウント | 明示的に有効化し、認証が必要なデバッグ画像 |
| `keystore` | 名前付きボリューム | 暗号化キーとワンタイム管理者初期ファイル（分離保管） |

## 開発

ローカル開発には Node.js 24 系の 24.15 以降と npm 12.2.0 が必要です。同梱の `.nvmrc`、package engine チェック、CI、コンテナビルドは同じツールチェーンを適用します。

```bash
# CI とイメージビルダに同梱されるレビュー済み npm をインストール
npm install --global npm@12.2.0 --ignore-scripts --no-audit --no-fund

# 依存関係をインストール
npm ci --ignore-scripts
npm --prefix client ci --ignore-scripts
npm run audit:release-age

# 開発サーバーを起動（自動リロード）
npm run dev

# テストを実行
npm test

# カバレッジと E2E smoke を実行
npm run test:coverage
npm --prefix client run test:coverage
npm --prefix client run build
npm run test:e2e

# クライアントをビルド
cd client && npx vite build

# 公開版を取得せずローカルイメージをビルド
cd ..
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## 謝辞

本プロジェクトは [@newbdez33](https://github.com/newbdez33) 氏の [freee-checkin](https://github.com/newbdez33/freee-checkin) に着想を得て構築されました。オリジナルプロジェクトは Playwright ベースの freee 勤怠自動化の基盤を提供しました。PunchPilot はこれを拡張し、Web 管理画面、OAuth API 連携、マルチ戦略一括修正、エンタープライズセキュリティ機能を追加しています。

## ライセンス

[MIT](LICENSE)
