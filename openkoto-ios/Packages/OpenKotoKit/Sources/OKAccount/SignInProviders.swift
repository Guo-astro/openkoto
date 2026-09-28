#if os(iOS)
import AuthenticationServices
import Foundation
import UIKit

/// 系统浏览器授权（`ASWebAuthenticationSession`）：邮箱验证码 / Google 等网页登录。
@MainActor
public final class WebAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    public override init() {}

    /// 打开授权页，等 `openkoto://auth/callback?...` 回来。
    public func authenticate(url: URL, callbackScheme: String = AccountConfiguration.callbackScheme)
        async throws -> URL
    {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) {
                callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError,
                    error.code == .canceledLogin
                {
                    continuation.resume(throwing: AuthError.cancelled)
                } else {
                    continuation.resume(
                        throwing: AuthError.authorizationFailed(error?.localizedDescription ?? "unknown"))
                }
            }
            session.presentationContextProvider = self
            // 共享 Safari cookie：网页端已登录时授权页直接放行，不用再输一遍验证码。
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                continuation.resume(throwing: AuthError.authorizationFailed("could not start web authentication"))
            }
        }
    }

    public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession)
        -> ASPresentationAnchor
    {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let windows = scenes.flatMap(\.windows)
            return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
        }
    }
}

extension AccountSession {
    /// 网页登录全流程：生成 PKCE → 打开授权页 → 校验 state → 换令牌。
    public func signInWithWeb(using authenticator: WebAuthenticator = WebAuthenticator()) async {
        let request = auth.makeAuthorizationRequest()
        do {
            let callback = try await authenticator.authenticate(url: request.url)
            await completeWebSignIn(callback: callback, request: request)
        } catch AuthError.cancelled {
            return
        } catch {
            reportError(error.localizedDescription)
        }
    }
}

/// Sign in with Apple 一次请求的 nonce（原始值留给服务端，哈希值给 Apple）。
///
/// 配合 SwiftUI 的 `SignInWithAppleButton`（底层就是 `ASAuthorizationController`）：
/// `onRequest` 里调 `configure(_:)`，`onCompletion` 里调 `complete(_:session:)`。
@MainActor
public final class AppleSignInFlow {
    private var rawNonce = AuthClient.makeNonce()

    public init() {}

    public func configure(_ request: ASAuthorizationAppleIDRequest) {
        rawNonce = AuthClient.makeNonce()
        request.requestedScopes = [.fullName, .email]
        request.nonce = AuthClient.sha256Hex(rawNonce)
    }

    public func complete(_ result: Result<ASAuthorization, Error>, session: AccountSession) async {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                let tokenData = credential.identityToken,
                let token = String(data: tokenData, encoding: .utf8)
            else {
                session.reportError(AuthError.missingIdentityToken.localizedDescription)
                return
            }
            // Apple 只在**第一次**授权时给姓名，之后永远是 nil —— 趁现在带上。
            let name = credential.fullName.map {
                AuthClient.AppleFullName(givenName: $0.givenName, familyName: $0.familyName)
            }
            await session.signInWithApple(identityToken: token, rawNonce: rawNonce, fullName: name)
        case .failure(let error):
            if (error as? ASAuthorizationError)?.code == .canceled { return }
            session.reportError(error.localizedDescription)
        }
    }
}
#endif
