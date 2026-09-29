// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenKotoKit",
    defaultLocalization: "en",
    // macOS 必须跟着 iOS 一起升：OKDesignSystem 是跨平台 target，
    // 里面的 onGeometryChange / pointerStyle 是 iOS 18 + macOS 15 才有的。
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "OKModels", targets: ["OKModels"]),
        .library(name: "OKSRS", targets: ["OKSRS"]),
        .library(name: "OKPersistence", targets: ["OKPersistence"]),
        .library(name: "OKAIClient", targets: ["OKAIClient"]),
        .library(name: "OKSegmentation", targets: ["OKSegmentation"]),
        .library(name: "OKBooks", targets: ["OKBooks"]),
        .library(name: "OKMedia", targets: ["OKMedia"]),
        .library(name: "OKDesignSystem", targets: ["OKDesignSystem"]),
        .library(name: "OKLocalization", targets: ["OKLocalization"]),
        .library(name: "OKAccount", targets: ["OKAccount"]),
        .library(name: "OKCommerce", targets: ["OKCommerce"]),
        .library(name: "OKFeatures", targets: ["OKFeatures"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift.git", from: "7.0.0"),
    ],
    targets: [
        // 纯值类型领域模型，零依赖（主 App 与 Share Extension 共享）
        .target(name: "OKModels"),
        // 句子切分：M2 时 1:1 移植桌面 commands.rs 算法
        .target(name: "OKSegmentation", dependencies: ["OKModels"]),
        // 书籍解析：编码嗅探 / ZIP / EPUB / TXT 分章。
        // 只依赖 Foundation + Compression，不碰 UIKit/WebKit——解析器在 macOS 上 swift test 全覆盖。
        .target(name: "OKBooks", dependencies: ["OKModels", "OKSegmentation"]),
        // 字幕解析与时间轴对齐。同样只依赖 Foundation——
        // AVFoundation/Speech 隔离在 OKFeatures，好让对齐算法在 macOS 上全量单测。
        .target(name: "OKMedia", dependencies: ["OKModels", "OKSegmentation"]),
        // FSRS-6 调度引擎：1:1 移植桌面 src-tauri/src/fsrs.rs
        // (规范 docs/specs/vocabulary-srs-spec.md,黄金用例与 Rust 共享)
        .target(name: "OKSRS", dependencies: ["OKModels"]),
        // 多 Provider LLM 客户端（M3 实现三个 Transport）
        .target(name: "OKAIClient", dependencies: ["OKModels"]),
        // GRDB 数据库（M2 实现 schema 与迁移）
        .target(
            name: "OKPersistence",
            dependencies: [
                "OKModels",
                // 跨设备同步的冲突解决要重放复习事件（ReviewReplay）。
                // OKSRS 只依赖 OKModels，不构成环。
                "OKSRS",
                .product(name: "GRDB", package: "GRDB.swift"),
            ]
        ),
        // OpenKoto 云账号：登录（PKCE 网页授权 / Sign in with Apple）、Keychain 令牌、
        // API 客户端（协议头 / 刷新 / 退避）、HTTP 同步传输（docs/specs/auth-spec.md、
        // sync-protocol-spec.md）。同步引擎本身在 OKPersistence（HTTPSyncEngine）。
        .target(name: "OKAccount", dependencies: ["OKPersistence", "OKModels"]),
        // StoreKit 2 购买：会员订阅 + AI 积分，交易交服务端核验入账（appAccountToken = 用户 id）。
        .target(name: "OKCommerce", dependencies: ["OKAccount"]),
        // 主题、颜色 token、通用组件（Generated/ 由 scripts/generate_palettes.py 产出）
        .target(
            name: "OKDesignSystem",
            resources: [.process("Resources")]
        ),
        // en/zh/ja 字符串资源（String Catalog）
        .target(
            name: "OKLocalization",
            resources: [.process("Resources")]
        ),
        // 各 Feature 屏幕（Library / Reader / Vocabulary / Settings / Import）
        .target(
            name: "OKFeatures",
            dependencies: [
                "OKModels", "OKDesignSystem", "OKSegmentation", "OKBooks", "OKMedia",
                "OKAIClient", "OKPersistence", "OKLocalization", "OKSRS", "OKAccount",
                "OKCommerce",
            ],
            // 原版模式注入 WKWebView 的 JS 桥
            resources: [.process("Resources")]
        ),
        .testTarget(name: "OKModelsTests", dependencies: ["OKModels"]),
        .testTarget(
            name: "OKSRSTests",
            dependencies: ["OKSRS", "OKModels"],
            // 与 Rust 共享的 FSRS golden fixture(权威文件在 docs/specs/fixtures/,
            // Rust 侧测试断言两份逐字节一致)
            resources: [.process("Fixtures")]
        ),
        .testTarget(
            name: "OKSegmentationTests",
            dependencies: ["OKSegmentation"],
            // 与 Rust 共享的切分 golden fixtures（设计文档 §5）
            resources: [.process("Fixtures")]
        ),
        // 测试夹具（ZIP / EPUB 合成器）：两个测试目标共用，不进 App 二进制。
        .target(name: "OKTestSupport", path: "Tests/Support"),
        .testTarget(
            name: "OKBooksTests",
            dependencies: ["OKBooks", "OKSegmentation", "OKTestSupport"]),
        .testTarget(name: "OKMediaTests", dependencies: ["OKMedia", "OKModels"]),
        // CoreText 振假名排版的度量契约（CoreText 在 macOS 上同样可用，无需模拟器）
        .testTarget(name: "OKDesignSystemTests", dependencies: ["OKDesignSystem"]),
        .testTarget(name: "OKAIClientTests", dependencies: ["OKAIClient", "OKModels"]),
        .testTarget(name: "OKPersistenceTests", dependencies: ["OKPersistence", "OKModels"]),
        .testTarget(name: "OKFeaturesTests", dependencies: ["OKFeatures", "OKTestSupport"]),
        .testTarget(
            name: "OKAccountTests",
            dependencies: ["OKAccount", "OKCommerce", "OKPersistence", "OKModels"]),
    ]
)
