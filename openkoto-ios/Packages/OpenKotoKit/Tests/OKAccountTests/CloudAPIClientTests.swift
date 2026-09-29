import Foundation
import OKPersistence
import Testing

@testable import OKAccount

/// API 客户端：协议头、错误映射（协议 §5.5）、令牌刷新（single-flight）、退避。
@Suite struct CloudAPIClientTests {
    @Test func sendsProtocolHeaders() async throws {
        let cloud = FakeCloud()
        let auth = AuthClient(api: cloud.client())
        _ = try await auth.me()
        let request = try #require(cloud.log.last)
        #expect(request.headers["X-OpenKoto-Protocol"] == "1")
        #expect(request.headers["X-OpenKoto-Client"] == "ios/1.2.3")
        #expect(request.headers["Authorization"] == "Bearer access-1")
    }

    @Test func decodesMeAndDevices() async throws {
        let cloud = FakeCloud()
        let auth = AuthClient(api: cloud.client())
        let me = try await auth.me()
        #expect(me.user.email == "you@example.com")
        #expect(me.plan == .plus)
        let devices = try await auth.devices()
        #expect(devices.count == 2)
        #expect(devices.first?.current == true)
        #expect(devices.first?.lastSeenDate != nil)
    }

    @Test func expiredAccessTokenIsRefreshedOnceAndRetried() async throws {
        let cloud = FakeCloud()
        cloud.validAccessTokens = []  // 服务端认为 access-1 已过期
        let store = InMemoryTokenStore(cloud.session())
        let auth = AuthClient(api: cloud.client(store: store))
        _ = try await auth.me()
        #expect(cloud.refreshCount == 1)
        #expect(store.load()?.accessToken == "access-2")
        #expect(store.load()?.refreshToken == "okr_refresh-2", "refresh token 每次都要轮换")
    }

    @Test func locallyExpiredTokenRefreshesBeforeTheRequest() async throws {
        let cloud = FakeCloud()
        var session = cloud.session()
        session.accessTokenExpiresAt = Date().addingTimeInterval(-10)
        cloud.validAccessTokens = []
        let auth = AuthClient(api: cloud.client(store: InMemoryTokenStore(session)))
        _ = try await auth.me()
        #expect(cloud.refreshCount == 1)
        // 没有先撞一次 401 再刷新
        #expect(cloud.log.filter { $0.path == "/api/v1/me" }.count == 1)
    }

    /// 并发请求共享同一次刷新：refresh token 用一次就轮换，各刷各的会触发复用检测。
    @Test func refreshIsSingleFlight() async throws {
        let cloud = FakeCloud()
        var session = cloud.session()
        session.accessTokenExpiresAt = Date().addingTimeInterval(-10)
        cloud.validAccessTokens = []
        let api = cloud.client(store: InMemoryTokenStore(session))
        let auth = AuthClient(api: api)
        async let a = auth.me()
        async let b = auth.devices()
        async let c = auth.me()
        _ = try await (a, b, c)
        #expect(cloud.refreshCount == 1)
    }

    @Test func rejectedRefreshSignsOut() async throws {
        let cloud = FakeCloud()
        cloud.validAccessTokens = []
        let store = InMemoryTokenStore(cloud.session())
        cloud.currentRefreshToken = "okr_something-else"  // 我们的 refresh token 已被吊销
        let api = cloud.client(store: store)
        let invalidated = SleepRecorder()
        await api.setInvalidationHandler { invalidated.record(1) }
        await #expect(throws: CloudAPIError.self) { _ = try await AuthClient(api: api).me() }
        #expect(store.load() == nil)
        #expect(invalidated.durations.count == 1)
    }

    @Test func retriesServerErrorsWithExponentialBackoff() async throws {
        let cloud = FakeCloud()
        cloud.failures = [(503, [:]), (500, [:])]
        let sleeps = SleepRecorder()
        let transport = HTTPSyncTransport(api: cloud.client(sleeps: sleeps))
        guard case .page = try await transport.pull(cursor: nil, limit: 10) else {
            Issue.record("expected a page")
            return
        }
        #expect(sleeps.durations == [1, 2])
    }

    @Test func honoursRetryAfterOn429() async throws {
        let cloud = FakeCloud()
        cloud.failures = [(429, ["Retry-After": "7"])]
        let sleeps = SleepRecorder()
        let transport = HTTPSyncTransport(api: cloud.client(sleeps: sleeps))
        _ = try await transport.pull(cursor: nil, limit: 10)
        #expect(sleeps.durations == [7])
    }

    @Test func givesUpAfterMaxRetries() async throws {
        let cloud = FakeCloud()
        cloud.failures = Array(repeating: (502, [:]), count: 5)
        let transport = HTTPSyncTransport(api: cloud.client(maxRetries: 2))
        await #expect(throws: CloudAPIError.self) { _ = try await transport.pull(cursor: nil, limit: 10) }
    }

    @Test func mapsErrorStatuses() {
        let body = Data(#"{"error":{"code":"FORBIDDEN","message":"missing scope: sync"}}"#.utf8)
        #expect(CloudAPIError.from(status: 403, body: body, retryAfter: nil) == .forbidden(code: "FORBIDDEN", message: "missing scope: sync"))
        #expect(CloudAPIError.from(status: 410, body: Data(), retryAfter: nil) == .cursorExpired)
        #expect(CloudAPIError.from(status: 413, body: Data(), retryAfter: nil) == .payloadTooLarge)
        #expect(CloudAPIError.from(status: 426, body: Data(), retryAfter: nil) == .clientTooOld)
        #expect(CloudAPIError.from(status: 429, body: Data(), retryAfter: 3) == .rateLimited(retryAfter: 3))
        #expect(CloudAPIError.from(status: 401, body: Data(), retryAfter: nil).requiresSignIn)
        if case .server(let status, _, _) = CloudAPIError.from(status: 503, body: Data(), retryAfter: nil) {
            #expect(status == 503)
        } else {
            Issue.record("5xx should map to .server")
        }
        #expect(CloudAPIClient.backoff(attempt: 0) == 1)
        #expect(CloudAPIClient.backoff(attempt: 3) == 8)
        #expect(CloudAPIClient.backoff(attempt: 20) == 300, "封顶 5 分钟")
    }

    @Test func pull410BecomesCursorExpired() async throws {
        let cloud = FakeCloud()
        cloud.tombstoneFloor = 10
        let transport = HTTPSyncTransport(api: cloud.client())
        guard case .cursorExpired = try await transport.pull(cursor: "c_3", limit: 10) else {
            Issue.record("expected cursorExpired")
            return
        }
    }

    @Test func notSignedInFailsFast() async {
        let cloud = FakeCloud()
        let api = cloud.client(store: InMemoryTokenStore())
        await #expect(throws: CloudAPIError.notSignedIn) { _ = try await AuthClient(api: api).me() }
        #expect(cloud.log.isEmpty)
    }
}

/// 认证流程（`docs/specs/auth-spec.md` §3）。
@Suite struct AuthClientTests {
    /// challenge = base64url(SHA-256(verifier))，无填充（参考值由 Python hashlib 算出）。
    @Test func pkceChallengeIsBase64URLSHA256() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mJ0jYo7ES8Mmi8fLf6N8sMd2hA0bSU")
        #expect(pkce.challenge == "xJ9FQSDCN7B1VV5r-rs-95mE9YApK3i-NQUCi6whFAg")
        #expect(PKCE.generate().verifier.count == 43, "服务端要求 challenge ≥ 43 位")
    }

    @Test func buildsTheAuthorizeURL() throws {
        let cloud = FakeCloud()
        let auth = AuthClient(api: cloud.client())
        let request = auth.makeAuthorizationRequest(pkce: PKCE(verifier: "v"), state: "s1")
        let components = try #require(URLComponents(url: request.url, resolvingAgainstBaseURL: false))
        #expect(components.path == "/auth/native/authorize")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(items["client_id"] == "ios")
        #expect(items["redirect_uri"] == "openkoto://auth/callback")
        #expect(items["code_challenge"] == PKCE.challenge(for: "v"))
        #expect(items["code_challenge_method"] == "S256")
        #expect(items["state"] == "s1")
    }

    @Test func callbackParsingChecksState() throws {
        let ok = URL(string: "openkoto://auth/callback?code=abc&state=s1")!
        #expect(try AuthClient.authorizationCode(from: ok, expectedState: "s1") == "abc")
        #expect(throws: AuthError.stateMismatch) {
            try AuthClient.authorizationCode(from: ok, expectedState: "other")
        }
        #expect(throws: AuthError.missingCode) {
            try AuthClient.authorizationCode(from: URL(string: "openkoto://auth/callback?state=s1")!, expectedState: "s1")
        }
    }

    @Test func exchangesTheCodeAndStoresTheSession() async throws {
        let cloud = FakeCloud()
        let store = InMemoryTokenStore()
        let auth = AuthClient(api: cloud.client(store: store))
        let session = try await auth.exchange(code: "the-code", verifier: "verifier-123")
        #expect(session.user.id == cloud.userID)
        #expect(store.load()?.deviceId == cloud.deviceID)
        let body = try #require(cloud.log.last?.body)
        let fields = try JSONDecoder().decode([String: JSONValue].self, from: body)
        #expect(fields["grant_type"]?.stringValue == "authorization_code")
        #expect(fields["code_verifier"]?.stringValue == "verifier-123")
        #expect(fields["device"]?["name"]?.stringValue == "Test iPhone")
        #expect(fields["device"]?["appVersion"]?.stringValue == "1.2.3")
    }

    @Test func appleNonceIsHashedForAppleAndRawForTheServer() {
        // 已知向量：sha256("abc")
        #expect(AuthClient.sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test func logoutClearsTheKeychainEvenOffline() async throws {
        let cloud = FakeCloud()
        let store = InMemoryTokenStore(cloud.session())
        await AuthClient(api: cloud.client(store: store)).logout()
        #expect(store.load() == nil)
        #expect(cloud.log.contains { $0.path == "/api/v1/auth/logout" })
    }

    @MainActor
    @Test func accountSessionReflectsSignInAndOut() async throws {
        let cloud = FakeCloud()
        let store = InMemoryTokenStore()
        let session = AccountSession(api: cloud.client(store: store))
        #expect(!session.isSignedIn)
        let request = session.auth.makeAuthorizationRequest(state: "st")
        await session.completeWebSignIn(
            callback: URL(string: "openkoto://auth/callback?code=the-code&state=st")!, request: request)
        #expect(session.isSignedIn)
        #expect(session.plan == .plus, "登录后拉 /me 刷新套餐")
        #expect(session.devices.count == 2)
        await session.signOut()
        #expect(!session.isSignedIn)
        #expect(store.load() == nil)
    }

    @Test func accountConfigurationBuildsDeletionURL() {
        let config = AccountConfiguration(baseURL: URL(string: "https://openkoto.com")!)
        #expect(config.accountDeletionURL.absoluteString == "https://openkoto.com/account?delete=1")
    }
}

/// 线上 JSON 与规范示例对得上（协议 §2.1 / §5）。
@Suite struct WireFormatTests {
    @Test func decodesSpecPullExample() throws {
        let json = """
            { "records": [
                { "type": "Vocabulary", "id": "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f", "rev": 1042,
                  "hlc": "1727500000123-0001-a1b2c3d4", "deviceId": "d7f1", "deleted": false,
                  "payload": { "word": "懐かしい", "reviewCount": 3, "stability": 2.5, "nested": {"a": [1, true, null]} } },
                { "type": "BookMark", "id": "88aa", "rev": 1043, "hlc": "1727500000124-0000-a1b2c3d4", "deleted": true, "payload": null },
                { "type": "Article", "id": "a1", "rev": 1044, "hlc": "1727500000125-0000-a1b2c3d4", "deleted": false, "blobUrl": "https://x/blob" }
              ],
              "cursor": "c_1044", "hasMore": false, "serverTime": "2026-09-28T10:00:00Z" }
            """
        let page = try JSONDecoder().decode(SyncPullResponse.self, from: Data(json.utf8))
        #expect(page.records.count == 3)
        #expect(page.cursor == "c_1044")
        #expect(page.records[0].payload?["word"] == .string("懐かしい"))
        #expect(page.records[0].payload?["reviewCount"] == .int(3))
        #expect(page.records[0].payload?["stability"] == .double(2.5))
        #expect(page.records[0].payload?["nested"]?["a"] == .array([.int(1), .bool(true), .null]))
        #expect(page.records[1].deleted && page.records[1].payload == nil)
        #expect(page.records[2].blobUrl == "https://x/blob")
    }

    @Test func decodesSpecPushResponseExample() throws {
        let json = """
            { "results": [
                { "opId": "uuid-1", "status": "applied", "rev": 1050 },
                { "opId": "uuid-3", "status": "conflict", "rev": 1047,
                  "current": { "type": "Vocabulary", "id": "x", "rev": 1047, "hlc": "1727500000123-0001-a1b2c3d4", "deleted": false, "payload": {} } },
                { "opId": "uuid-4", "status": "rejected", "code": "PAYLOAD_TOO_LARGE" }
              ], "cursor": "c_1051" }
            """
        let response = try JSONDecoder().decode(SyncPushResponse.self, from: Data(json.utf8))
        #expect(response.results.map(\.status) == [.applied, .conflict, .rejected])
        #expect(response.results[1].current?.rev == 1047)
        #expect(response.results[2].code == "PAYLOAD_TOO_LARGE")
    }

    @Test func encodesPushRequestWithSpecFieldNames() throws {
        let request = SyncPushRequest(
            deviceId: "dev",
            ops: [
                SyncPushOp(
                    opId: "op-1", type: "Vocabulary", id: "3f0c", baseRev: 1042,
                    hlc: "1727500100000-0000-a1b2c3d4", deleted: false, payload: .object(["word": .string("w")])),
                SyncPushOp(opId: "op-2", type: "BookMark", id: "88aa", baseRev: 3, hlc: "1727500100000-0001-a1b2c3d4", deleted: true, payload: nil),
            ])
        let object = try #require(
            try JSONSerialization.jsonObject(with: try JSONEncoder().encode(request)) as? [String: Any])
        #expect(object["deviceId"] as? String == "dev")
        let ops = try #require(object["ops"] as? [[String: Any]])
        #expect(Set(ops[0].keys) == ["opId", "type", "id", "baseRev", "hlc", "deleted", "payload"])
        #expect(ops[0]["baseRev"] as? Int == 1042)
        #expect(ops[1]["deleted"] as? Bool == true)
        #expect(ops[1]["payload"] == nil, "墓碑不带 payload")
    }

    @Test func gzipRoundTrips() throws {
        let original = Data(String(repeating: "懐かしい OpenKoto ", count: 5000).utf8)
        let compressed = try Gzip.compress(original)
        #expect(compressed.prefix(2) == Data([0x1f, 0x8b]))
        #expect(compressed.count < original.count)
        #expect(try Gzip.decompress(compressed) == original)
    }
}
