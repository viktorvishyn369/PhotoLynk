const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

function findAppDelegateSwift(iosProjectRoot) {
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
      } else if (e.isFile() && e.name === 'AppDelegate.swift') {
        candidates.push(p);
      }
    }
  }
  walk(iosProjectRoot);
  // Prefer AppDelegate under an app target folder (ios/<AppName>/AppDelegate.swift)
  const preferred = candidates.find((p) => /\/ios\/[^\/]+\/AppDelegate\.swift$/.test(p));
  return preferred || candidates[0] || null;
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
  // Idempotency marker
  if (contents.includes('PhotoSyncLocalNetworkPromptPatch')) return contents;

  let out = contents;
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

  // Inject permission prompt trigger + didBecomeActive handler after cachedLaunchOptions assignment (or after bindReactNativeFactory)
  if (!out.includes('searchForServices(ofType: "_http._tcp."')) {
    const anchor = 'cachedLaunchOptions = launchOptions';
    if (out.includes(anchor)) {
      out = out.replace(
        anchor,
        `${anchor}\n\n    localNetBrowserDelegate = LocalNetworkBrowserDelegate()\n    localNetBrowser = NetServiceBrowser()\n    localNetBrowser?.delegate = localNetBrowserDelegate\n    // Starting a browse triggers the iOS Local Network prompt the first time.\n    localNetBrowser?.searchForServices(ofType: \"_http._tcp.\", inDomain: \"local.\")\n\n    // Start RN once after the app becomes active (after the prompt is dismissed).\n    didBecomeActiveObserver = NotificationCenter.default.addObserver(\n      forName: UIApplication.didBecomeActiveNotification,\n      object: nil,\n      queue: .main\n    ) { [weak self] _ in\n      guard let self = self else { return }\n      self.didBecomeActiveCount += 1\n      if self.didBecomeActiveCount < 2 { return }\n      if self.didStartReactNativeAfterBecomeActive { return }\n      self.didStartReactNativeAfterBecomeActive = true\n\n      self.localNetBrowser?.stop()\n      self.localNetBrowser = nil\n      self.localNetBrowserDelegate = nil\n\n      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {\n        guard let window = self.window else { return }\n        guard let factory = self.reactNativeFactory else { return }\n        factory.startReactNative(\n          withModuleName: \"main\",\n          in: window,\n          launchOptions: self.cachedLaunchOptions)\n      }\n    }`
      );
    }
  }

  // Add LocalNetworkBrowserDelegate at end if missing
  if (!out.includes('class LocalNetworkBrowserDelegate') && !out.includes('LocalNetworkBrowserDelegate:')) {
    out += `\n#if DEBUG\nprivate final class LocalNetworkBrowserDelegate: NSObject, NetServiceBrowserDelegate {\n}\n#endif\n`;
  }

  return out;
}

module.exports = function withIosLocalNetworkPrompt(config) {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const iosRoot = config.modRequest.platformProjectRoot;
      const appDelegatePath = findAppDelegateSwift(iosRoot);
      if (!appDelegatePath) {
        console.warn('⚠️ withIosLocalNetworkPrompt: AppDelegate.swift not found');
        return config;
      }

      const original = fs.readFileSync(appDelegatePath, 'utf8');
      const patched = patchAppDelegateSwift(original);
      if (patched !== original) {
        fs.writeFileSync(appDelegatePath, patched);
        console.log('✅ Patched AppDelegate.swift for Local Network prompt / delayed RN start');
      } else {
        console.log('ℹ️ AppDelegate.swift already patched');
      }
      return config;
    },
  ]);
};
