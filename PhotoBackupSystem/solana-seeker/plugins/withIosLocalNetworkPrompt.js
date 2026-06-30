const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

function findAppDelegate(iosProjectRoot, filename) {
  const candidates = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Skip huge dirs
        if (e.name === 'Pods' || e.name === 'build') continue;
        walk(p);
      } else if (e.isFile() && e.name === filename) {
        candidates.push(p);
      }
    }
  }
  walk(iosProjectRoot);
  const escaped = filename.replace('.', '\\.');
  const preferred = candidates.find((p) => new RegExp(`/ios/[^/]+/${escaped}$`).test(p));
  return preferred || candidates[0] || null;
}

function findAppDelegateSwift(iosProjectRoot) {
  return findAppDelegate(iosProjectRoot, 'AppDelegate.swift');
}

function findAppDelegateObjC(iosProjectRoot) {
  return findAppDelegate(iosProjectRoot, 'AppDelegate.mm');
}

function ensureLineAfterImport(contents, importLine) {
  if (contents.includes(importLine)) return contents;
  // Insert after first import
  const m = contents.match(/^(import[^\n]*\n)/m);
  if (!m) return `${importLine}\n${contents}`;
  const idx = m.index + m[0].length;
  return contents.slice(0, idx) + `${importLine}\n` + contents.slice(idx);
}

function patchAppDelegateSwift(contents) {
  let out = contents;

  const stripHardcodedFailsafe = (s) => {
    // Remove any previously injected hardcoded fail-safe timers that start RN.
    // We intentionally rely on didBecomeActive to proceed after the system prompt.
    return String(s || '').replace(
      /\n\s*(?:\/\/\s*Fail-safe:[\s\S]*?\n\s*)?DispatchQueue\.main\.asyncAfter\(deadline: \.now\(\) \+ (?:1\.5|20\.0)\) \{[\s\S]*?didStartReactNativeAfterBecomeActive[\s\S]*?\n\s*\}\n/g,
      '\n'
    );
  };

  // If already patched, still run cleanup to remove any old fail-safe blocks.
  if (out.includes('PhotoSyncLocalNetworkPromptPatch')) {
    return stripHardcodedFailsafe(out);
  }
  out = ensureLineAfterImport(out, 'import Foundation');

  // Add DEBUG state vars inside AppDelegate
  out = out.replace(
    /public class AppDelegate: ExpoAppDelegate \{([\s\S]*?)var reactNativeFactory: RCTReactNativeFactory\?\n/m,
    (full, between) => {
      if (full.includes('didStartReactNativeAfterBecomeActive')) return full;
      return `public class AppDelegate: ExpoAppDelegate {${between}var reactNativeFactory: RCTReactNativeFactory?\n\n#if DEBUG\n  // PhotoSyncLocalNetworkPromptPatch\n  private var didStartReactNativeAfterBecomeActive = false\n  private var didBecomeActiveObserver: NSObjectProtocol?\n  private var cachedLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?\n  private var localNetBrowser: NetServiceBrowser?\n  private var localNetBrowserDelegate: LocalNetworkBrowserDelegate?\n  private var didBecomeActiveCount = 0\n#endif\n`;
    }
  );

  // Delay startReactNative in DEBUG by wrapping the call
  out = out.replace(
    /factory\.startReactNative\(\s*\n\s*withModuleName:[\s\S]*?launchOptions: launchOptions\)\s*\n/,
    (call) => {
      // If already guarded, keep as-is
      if (call.includes('#if DEBUG') || out.includes('Delay starting RN until the app becomes active')) return call;
      return `#if DEBUG\n    // PhotoSyncLocalNetworkPromptPatch\n    // Delay starting RN until the app becomes active (after iOS Local Network permission prompt).\n#else\n    ${call.trim()}\n#endif\n`;
    }
  );

  // Inject permission prompt trigger + didBecomeActive handler after cachedLaunchOptions assignment
  if (!out.includes('searchForServices(ofType: "_http._tcp."')) {
    const anchor = 'cachedLaunchOptions = launchOptions';
    if (out.includes(anchor)) {
      out = out.replace(
        anchor,
        `${anchor}\n\n    // PhotoSyncLocalNetworkPromptPatch\n    // Show the native splash while waiting, so first launch isn't a black screen.\n    if let window = window {\n      let splashVC: UIViewController? = nil\n      let storyboard = UIStoryboard(name: \"SplashScreen\", bundle: nil)\n      splashVC = storyboard.instantiateInitialViewController()\n      window.rootViewController = splashVC ?? UIViewController()\n      window.makeKeyAndVisible()\n    }\n\n    localNetBrowserDelegate = LocalNetworkBrowserDelegate()\n    localNetBrowser = NetServiceBrowser()\n    localNetBrowser?.delegate = localNetBrowserDelegate\n    // Starting a browse triggers the iOS Local Network prompt the first time.\n    localNetBrowser?.searchForServices(ofType: \"_http._tcp.\", inDomain: \"local.\")\n\n    // Start RN once after the app becomes active (after any system permission prompts).\n    // Do NOT require a 2nd activation: if permission was already granted, we still need to start.\n    didBecomeActiveObserver = NotificationCenter.default.addObserver(\n      forName: UIApplication.didBecomeActiveNotification,\n      object: nil,\n      queue: .main\n    ) { [weak self] _ in\n      guard let self = self else { return }\n      if self.didStartReactNativeAfterBecomeActive { return }\n      self.didStartReactNativeAfterBecomeActive = true\n\n      self.localNetBrowser?.stop()\n      self.localNetBrowser = nil\n      self.localNetBrowserDelegate = nil\n\n      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {\n        guard let window = self.window else { return }\n        guard let factory = self.reactNativeFactory else { return }\n        factory.startReactNative(\n          withModuleName: \"main\",\n          in: window,\n          launchOptions: self.cachedLaunchOptions)\n      }\n    }\n\n    // Fail-safe: if didBecomeActive doesn't fire as expected, start RN anyway after a short timeout.\n    DispatchQueue.main.asyncAfter(deadline: .now() + 20.0) {\n      if self.didStartReactNativeAfterBecomeActive { return }\n      self.didStartReactNativeAfterBecomeActive = true\n      self.localNetBrowser?.stop()\n      self.localNetBrowser = nil\n      self.localNetBrowserDelegate = nil\n      guard let window = self.window else { return }\n      guard let factory = self.reactNativeFactory else { return }\n      factory.startReactNative(\n        withModuleName: \"main\",\n        in: window,\n        launchOptions: self.cachedLaunchOptions)\n    }`
      );
    }
  }

  // If the anchor-based injection failed (Expo changed AppDelegate template), inject a minimal
  // fail-safe block just before returning from didFinishLaunching (DEBUG only). This prevents
  // black screen where RN never starts.
  if (!out.includes('didBecomeActiveObserver = NotificationCenter.default.addObserver')) {
    out = out.replace(
      /return\s+super\.application\(application,\s+didFinishLaunchingWithOptions:\s+launchOptions\)\n/m,
      `#if DEBUG\n    // PhotoSyncLocalNetworkPromptPatch\n    didBecomeActiveObserver = NotificationCenter.default.addObserver(\n      forName: UIApplication.didBecomeActiveNotification,\n      object: nil,\n      queue: .main\n    ) { [weak self] _ in\n      guard let self = self else { return }\n      if self.didStartReactNativeAfterBecomeActive { return }\n      self.didStartReactNativeAfterBecomeActive = true\n      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {\n        guard let window = self.window else { return }\n        guard let factory = self.reactNativeFactory else { return }\n        factory.startReactNative(\n          withModuleName: \"main\",\n          in: window,\n          launchOptions: self.cachedLaunchOptions)\n      }\n    }\n\n    DispatchQueue.main.asyncAfter(deadline: .now() + 20.0) {\n      if self.didStartReactNativeAfterBecomeActive { return }\n      self.didStartReactNativeAfterBecomeActive = true\n      guard let window = self.window else { return }\n      guard let factory = self.reactNativeFactory else { return }\n      factory.startReactNative(\n        withModuleName: \"main\",\n        in: window,\n        launchOptions: self.cachedLaunchOptions)\n    }\n#endif\n\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)\n`
    );
  }

  // Add LocalNetworkBrowserDelegate at end if missing
  if (!out.includes('class LocalNetworkBrowserDelegate') && !out.includes('LocalNetworkBrowserDelegate:')) {
    out += `\n#if DEBUG\nprivate final class LocalNetworkBrowserDelegate: NSObject, NetServiceBrowserDelegate {\n}\n#endif\n`;
  }

  out = stripHardcodedFailsafe(out);

  return out;
}

function patchAppDelegateObjC(contents, headerContents) {
  let out = contents;
  let hdr = headerContents;

  // Already patched?
  if (out.includes('PhotoSyncLocalNetworkPromptPatch')) {
    return { mm: out, h: hdr };
  }

  // --- Patch the header to add instance variables ---
  if (!hdr.includes('_didStartReactNativeAfterBecomeActive')) {
    hdr = hdr.replace(
      /@interface AppDelegate\s*:\s*\w+/,
      (match) => `${match} {
#if DEBUG
  // PhotoSyncLocalNetworkPromptPatch
  BOOL _didStartReactNativeAfterBecomeActive;
  id _didBecomeActiveObserver;
  NSDictionary *_cachedLaunchOptions;
  NSNetServiceBrowser *_localNetBrowser;
#endif
}`
    );
  }

  // --- Patch the .mm to delay RN start in DEBUG ---
  // Find the return [super application:...] line and inject before it
  const returnPattern = /return \[super application:application didFinishLaunchingWithOptions:launchOptions\];/;
  if (returnPattern.test(out) && !out.includes('_didBecomeActiveObserver')) {
    out = out.replace(
      returnPattern,
      `#if DEBUG
  // PhotoSyncLocalNetworkPromptPatch
  _cachedLaunchOptions = launchOptions;
  _didStartReactNativeAfterBecomeActive = NO;

  // Show splash screen while waiting for local network prompt
  UIStoryboard *storyboard = [UIStoryboard storyboardWithName:@"SplashScreen" bundle:nil];
  UIViewController *splashVC = [storyboard instantiateInitialViewController];
  if (splashVC && self.window) {
    self.window.rootViewController = splashVC;
    [self.window makeKeyAndVisible];
  }

  // Trigger the iOS Local Network permission prompt
  _localNetBrowser = [[NSNetServiceBrowser alloc] init];
  [_localNetBrowser searchForServicesOfType:@"_http._tcp." inDomain:@"local."];

  // Start RN after app becomes active (after any system permission prompts)
  __weak typeof(self) weakSelf = self;
  _didBecomeActiveObserver = [[NSNotificationCenter defaultCenter]
    addObserverForName:UIApplicationDidBecomeActiveNotification
    object:nil
    queue:[NSOperationQueue mainQueue]
    usingBlock:^(NSNotification *note) {
      __strong typeof(weakSelf) strongSelf = weakSelf;
      if (!strongSelf || strongSelf->_didStartReactNativeAfterBecomeActive) return;
      strongSelf->_didStartReactNativeAfterBecomeActive = YES;

      [strongSelf->_localNetBrowser stop];
      strongSelf->_localNetBrowser = nil;

      if (strongSelf->_didBecomeActiveObserver) {
        [[NSNotificationCenter defaultCenter] removeObserver:strongSelf->_didBecomeActiveObserver];
        strongSelf->_didBecomeActiveObserver = nil;
      }
    }];

  // Fail-safe: start RN after 20s if didBecomeActive never fires
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(20.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    __strong typeof(weakSelf) strongSelf = weakSelf;
    if (!strongSelf || strongSelf->_didStartReactNativeAfterBecomeActive) return;
    strongSelf->_didStartReactNativeAfterBecomeActive = YES;
    if (strongSelf->_didBecomeActiveObserver) {
      [[NSNotificationCenter defaultCenter] removeObserver:strongSelf->_didBecomeActiveObserver];
      strongSelf->_didBecomeActiveObserver = nil;
    }
  });
#endif

  return [super application:application didFinishLaunchingWithOptions:launchOptions];`
    );
  }

  return { mm: out, h: hdr };
}

module.exports = function withIosLocalNetworkPrompt(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const iosRoot = config.modRequest.platformProjectRoot;

      // Try Swift first
      const swiftPath = findAppDelegateSwift(iosRoot);
      if (swiftPath) {
        const original = fs.readFileSync(swiftPath, 'utf8');
        const patched = patchAppDelegateSwift(original);
        if (patched !== original) {
          fs.writeFileSync(swiftPath, patched);
          console.log('✅ Patched AppDelegate.swift for Local Network prompt / delayed RN start');
        } else {
          console.log('ℹ️ AppDelegate.swift already patched');
        }
        return config;
      }

      // Fall back to ObjC++ (.mm + .h)
      const mmPath = findAppDelegateObjC(iosRoot);
      if (mmPath) {
        const hPath = mmPath.replace(/\.mm$/, '.h');
        const mmOriginal = fs.readFileSync(mmPath, 'utf8');
        const hOriginal = fs.existsSync(hPath) ? fs.readFileSync(hPath, 'utf8') : '';
        const { mm, h } = patchAppDelegateObjC(mmOriginal, hOriginal);
        if (mm !== mmOriginal) {
          fs.writeFileSync(mmPath, mm);
          console.log('✅ Patched AppDelegate.mm for Local Network prompt / delayed RN start');
        } else {
          console.log('ℹ️ AppDelegate.mm already patched');
        }
        if (h !== hOriginal && hOriginal) {
          fs.writeFileSync(hPath, h);
          console.log('✅ Patched AppDelegate.h with ivar declarations');
        }
        return config;
      }

      console.warn('⚠️ withIosLocalNetworkPrompt: Neither AppDelegate.swift nor AppDelegate.mm found');
      return config;
    },
  ]);
};
