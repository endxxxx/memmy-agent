import Foundation

public let openComputerUseVersion = "1.2.5-acceptance.2"

public func resolvedOpenComputerUseVersion(bundle: Bundle = .main) -> String {
    if let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
       !version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return version
    }

    return openComputerUseVersion
}
