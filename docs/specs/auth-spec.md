# OpenKoto 认证规范 v1

> 状态：v1（P0 定稿）
> 服务端实现：`server/worker/src/auth`
> 设计背景：`docs/plans/2026-09-28-web-and-cloud-platform-design.md` §4

---

## 1. 两层结构

| 层 | 负责 | 实现 |
|---|---|---|
| **身份层** | 证明"你是谁"：邮箱验证码、Google、Apple、GitHub；网页 Cookie 会话 | Better Auth（`/api/auth/*`），数据存 D1 |
| **令牌层** | 给原生端、桌面、CLI、Agent 发放可刷新的访问令牌 | 自有令牌服务（`/api/v1/auth/*`），数据存 D1 |

网页只使用身份层的 Cookie 会话。其他客户端一律通过令牌层拿到 `access token`（JWT）+ `refresh token`，以及可选的 API Key。

## 2. 令牌

### 2.1 Access Token（JWT）

- 算法 **EdDSA（Ed25519）**；公钥发布在 `GET /.well-known/jwks.json`；私钥存放在 Worker Secret `JWT_PRIVATE_KEY`（PKCS8 PEM）。
- 有效期 **15 分钟**。

| claim | 含义 |
|---|---|
| `iss` | `APP_ORIGIN`，例如 `https://openkoto.com` |
| `aud` | `openkoto-api` |
| `sub` | user id |
| `did` | device id |
| `scp` | scope 数组（§4） |
| `plan` | `free` / `plus` / `pro`（签发时的快照，只用于 UI 展示和快速判断；扣费类操作必须查 D1） |
| `iat` / `exp` | 签发 / 过期时间 |

### 2.2 Refresh Token

- 形如 `okr_` + 43 位 base64url 随机串；服务端只存 SHA-256 哈希。
- 有效期 **90 天滑动**：每次刷新都签发一个新的 refresh token，旧的立即失效。
- **复用检测**：已经轮换掉的 refresh token 再次出现时，吊销同一 `family_id` 下的全部 token，并吊销对应设备。

### 2.3 API Key

- 形如 `ok_live_` + 32 位 base62 随机串；服务端只存 SHA-256 哈希和前 12 位前缀（用于展示）。
- 使用方式：`Authorization: Bearer ok_live_…`。服务端根据前缀区分 API Key 和 JWT。
- 可以设置过期时间，可以随时吊销；需要会员权益才能创建（Plus 及以上）。

## 3. 流程

### 3.1 原生端 / 桌面授权码 + PKCE

```
客户端                                    服务端
  │ 生成 code_verifier / code_challenge(S256) / state
  │ 打开系统浏览器 ───────────────────────▶ GET /auth/native/authorize
  │                                          ?client_id=ios|desktop
  │                                          &redirect_uri=openkoto://auth/callback
  │                                          &code_challenge=…&code_challenge_method=S256&state=…
  │                                        未登录 → 跳转 /login?next=… → 登录后回到本 URL
  │                                        已登录 → 跳转确认页 /authorize-app（用户点「允许」）
  │                                        → POST /api/v1/auth/native/approve（Cookie 会话 + 同源校验）
  │                                        → 生成一次性 code（有效期 5 分钟）；点「取消」返回 error=access_denied
  │ ◀──────────── 302 redirect_uri?code=…&state=…
  │ 校验 state
  │ POST /api/v1/auth/token ─────────────▶ grant_type=authorization_code
  │   { code, code_verifier, redirect_uri, device:{platform,name,appVersion} }
  │ ◀──────────── { accessToken, refreshToken, expiresIn, user }
```

`redirect_uri` 白名单：

- `openkoto://auth/callback`
- `http://127.0.0.1:<任意端口>/callback`（仅 `client_id=desktop`）

### 3.2 iOS 原生 Apple 登录

`POST /api/v1/auth/apple`：`{ identityToken, nonce, fullName?, device }` → 与 §3.1 相同的令牌响应。服务端用 Apple JWKS 校验 identityToken（`aud` = iOS bundle id），并在身份层查找或创建对应用户。

### 3.3 CLI 设备码（RFC 8628）

1. `POST /api/v1/auth/device/code`，请求 `{ clientId: "cli", device }`，返回：

   ```json
   { "deviceCode": "…", "userCode": "WDJB-MJHT",
     "verificationUri": "https://openkoto.com/device",
     "verificationUriComplete": "https://openkoto.com/device?code=WDJB-MJHT",
     "interval": 5, "expiresIn": 600 }
   ```

2. 用户在网页 `/device` 登录后，输入 `userCode` 并确认，网页调用 `POST /api/v1/auth/device/approve { userCode }`（使用 Cookie 会话）。
3. CLI 每隔 `interval` 秒轮询 `POST /api/v1/auth/token`，参数为 `grant_type=urn:ietf:params:oauth:grant-type:device_code` 和 `deviceCode`：
   - 用户尚未确认 → 400 `authorization_pending`；
   - 轮询过快 → 400 `slow_down`（客户端把间隔加 5 秒）；
   - 超时 → 400 `expired_token`；
   - 用户拒绝 → 400 `access_denied`；
   - 用户已确认 → 返回令牌。
4. `userCode` 为 8 位字符（去掉容易混淆的字符），中间用短横线分隔，错误输入 5 次后作废。

### 3.4 刷新与登出

- 刷新：`POST /api/v1/auth/token`，参数 `grant_type=refresh_token` 和 `refreshToken`。
- 登出：`POST /api/v1/auth/logout`，参数 `{ refreshToken }`，吊销当前设备。
- 设备管理：
  - `GET /api/v1/devices` 列出设备；
  - `DELETE /api/v1/devices/:id` 吊销指定设备（Cookie 会话或令牌均可）。

### 3.5 网页

- 使用 Better Auth 的标准接口：
  - 邮箱验证码：`POST /api/auth/email-otp/send-verification-otp`、`POST /api/auth/sign-in/email-otp`；
  - 第三方登录：`POST /api/auth/sign-in/social`，provider 为 `google` / `apple` / `github`。
- Cookie 属性：`HttpOnly; Secure; SameSite=Lax`。
- 所有非 GET 请求校验 `Origin` 必须等于 `APP_ORIGIN`（防 CSRF）。

## 4. Scope

| scope | 能力 |
|---|---|
| `sync` | `/api/v1/sync/*` 读写 |
| `vocab:read` / `vocab:write` | 生词、词包、复习（CLI / MCP 使用的高层接口） |
| `library:read` / `library:write` | 文章、书籍、歌词、书签、进度 |
| `ai:use` | 托管 AI（消耗积分） |
| `account` | 设备、API Key、账单（只发放给第一方客户端） |

- 第一方客户端（iOS / 桌面 / CLI 登录）默认获得全部 scope。
- API Key 由用户在创建时勾选 scope；默认只勾选 `vocab:read` 和 `library:read`。

## 5. 限流与安全

| 对象 | 限制 |
|---|---|
| 邮箱验证码 | 6 位数字，10 分钟有效；同一邮箱每小时最多 5 次；错误 5 次后作废 |
| 授权码 | 一次性，5 分钟有效，绑定 `redirect_uri` 和 `code_challenge` |
| `/api/v1/auth/token` | 每 IP 每分钟 30 次 |

- JWT 私钥、各 OAuth 客户端密钥、支付密钥等全部存放在 Worker Secrets，任何时候都不写进仓库、不打进客户端。
- 删除账号：`POST /api/v1/account/delete` 需要最近 5 分钟内重新认证过；进入 7 天冷静期后由 Queue 任务彻底清理（D1、UserVault、R2）。

## 6. 客户端存储

| 端 | 存储位置 |
|---|---|
| iOS / Mac Catalyst | Keychain，service 为 `app.openkoto.account` |
| 桌面 | 系统钥匙串（`keyring` crate），service 为 `openkoto-desktop` |
| CLI | 优先系统钥匙串；不可用时写入 `~/.config/koto/credentials.json`（权限 0600）；环境变量 `KOTO_API_KEY` 优先级最高 |
| 网页 | 只使用 Cookie，不在 localStorage 中保存任何令牌 |
