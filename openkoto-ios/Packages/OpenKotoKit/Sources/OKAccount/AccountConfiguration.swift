import Foundation

/// OpenKoto 云的连接参数。
///
/// 基址读 Info.plist 的 `OpenKotoAPIBaseURL`（自托管 / 联调时改这里），
/// 缺省 `https://openkoto.app`。
public struct AccountConfiguration: Sendable, Equatable {
    public static let infoPlistKey = "OpenKotoAPIBaseURL"
    public static let defaultBaseURL = URL(string: "https://openkoto.app")!
    /// 与服务端 `redirect_uri` 白名单一致（`server/worker/src/auth/routes.ts`）。
    public static let redirectURI = "openkoto://auth/callback"
    public static let callbackScheme = "openkoto"
    /// 协议版本（`X-OpenKoto-Protocol`）。
    public static let protocolVersion = 1

    public var baseURL: URL
    /// `ios/<version>`，进 `X-OpenKoto-Client`。
    public var platform: String
    public var appVersion: String
    public var deviceName: String
    /// 授权端的 `client_id`（服务端白名单：ios / desktop / android）。
    public var clientID: String

    public init(
        baseURL: URL = AccountConfiguration.defaultBaseURL,
        platform: String = "ios",
        appVersion: String = "0.0.0",
        deviceName: String = "iPhone",
        clientID: String = "ios"
    ) {
        self.baseURL = baseURL
        self.platform = platform
        self.appVersion = appVersion
        self.deviceName = deviceName
        self.clientID = clientID
    }

    /// 从 App bundle 读取。
    public static func fromBundle(_ bundle: Bundle = .main, deviceName: String) -> AccountConfiguration {
        var baseURL = defaultBaseURL
        if let raw = bundle.object(forInfoDictionaryKey: infoPlistKey) as? String,
            let url = URL(string: raw.trimmingCharacters(in: .whitespaces)), url.scheme != nil,
            !raw.contains("$(")
        {
            baseURL = url
        }
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        return AccountConfiguration(
            baseURL: baseURL, platform: "ios", appVersion: version, deviceName: deviceName,
            clientID: "ios")
    }

    public var clientHeader: String { "\(platform)/\(appVersion)" }

    /// 设备信息（`POST /api/v1/auth/token` 与 `/auth/apple` 的 `device` 字段）。
    public var device: DeviceDescriptor {
        DeviceDescriptor(platform: platform, name: deviceName, appVersion: appVersion)
    }

    /// 网页账户页（删除账号只能在网页会话里做，见 `account/routes.ts`）。
    public var accountDeletionURL: URL {
        var components = URLComponents(url: baseURL.appendingPathComponent("account"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "delete", value: "1")]
        return components.url!
    }

    public var accountURL: URL { baseURL.appendingPathComponent("account") }
}
