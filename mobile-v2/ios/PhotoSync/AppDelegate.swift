import Foundation
import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

#if DEBUG
  private var didStartReactNativeAfterBecomeActive = false
  private var didBecomeActiveObserver: NSObjectProtocol?
  private var cachedLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
  private var localNetBrowser: NetServiceBrowser?
  private var localNetBrowserDelegate: LocalNetworkBrowserDelegate?
  private var didBecomeActiveCount = 0
#endif

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)

#if DEBUG
    // In DEBUG/dev builds, iOS may show the Local Network permission prompt on first launch.
    // If RN starts before the prompt completes, Metro bundle URL resolution can fail and show
    // a red screen: "No script URL provided". Delay starting RN until the app becomes active.
#else
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
#endif

#if DEBUG
    cachedLaunchOptions = launchOptions

    localNetBrowserDelegate = LocalNetworkBrowserDelegate()
    localNetBrowser = NetServiceBrowser()
    localNetBrowser?.delegate = localNetBrowserDelegate
    // Starting a browse triggers the iOS Local Network prompt the first time.
    localNetBrowser?.searchForServices(ofType: "_http._tcp.", inDomain: "local.")

    // Start RN once after the app becomes active (after any system permission prompts).
    didBecomeActiveObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      self.didBecomeActiveCount += 1
      // 1st activation happens immediately on launch; iOS may show the permission prompt after.
      // Start RN only on the 2nd activation (after the prompt is dismissed).
      if self.didBecomeActiveCount < 2 { return }
      if self.didStartReactNativeAfterBecomeActive { return }
      self.didStartReactNativeAfterBecomeActive = true

      self.localNetBrowser?.stop()
      self.localNetBrowser = nil
      self.localNetBrowserDelegate = nil

      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
        guard let window = self.window else { return }
        guard let factory = self.reactNativeFactory else { return }
        factory.startReactNative(
          withModuleName: "main",
          in: window,
          launchOptions: self.cachedLaunchOptions)
      }
    }
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

#if DEBUG
  deinit {
    if let obs = didBecomeActiveObserver {
      NotificationCenter.default.removeObserver(obs)
    }
  }
#endif

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

#if DEBUG
private final class LocalNetworkBrowserDelegate: NSObject, NetServiceBrowserDelegate {
}
#endif
