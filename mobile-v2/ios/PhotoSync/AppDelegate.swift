import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

#if DEBUG
  private var didAutoReloadAfterBecomeActive = false
  private var didBecomeActiveObserver: NSObjectProtocol?
  private var cachedLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
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
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

#if DEBUG
    cachedLaunchOptions = launchOptions

    // Workaround: On first launch, iOS may show the Local Network permission prompt before
    // the dev bundle URL is available, leading to a red screen: "No script URL provided".
    // When the app becomes active after the prompt, trigger a single RN reload so Metro
    // reconnects automatically (no need to tap "Reload JS").
    didBecomeActiveObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self = self else { return }
      if self.didAutoReloadAfterBecomeActive { return }
      self.didAutoReloadAfterBecomeActive = true

      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        guard let window = self.window else { return }
        // Fully recreate the RN factory/delegate so bundle URL resolution happens again.
        let delegate = ReactNativeDelegate()
        let factory = ExpoReactNativeFactory(delegate: delegate)
        delegate.dependencyProvider = RCTAppDependencyProvider()

        self.reactNativeDelegate = delegate
        self.reactNativeFactory = factory
        self.bindReactNativeFactory(factory)

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
