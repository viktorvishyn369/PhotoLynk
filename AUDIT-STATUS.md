# StealthLynk Hardening — Audit Status Export
Date: 2026-10-13. All commits are local unless marked PUSHED. No production deployment or production-data changes made.

## CONSTRAINTS PRESERVED
- PaceSeeker ~$3.99/mo unlocks PhotoLynk 400 GB; PhotoLynk 400 GB unlocks PaceSeeker + equal/lower apps; 1 TB unlocks all lower-priced; 100/200 GB and premium/ads stay app-local.
- Existing paid access, storage, premium benefits, remaining paid time intact — all changes additive, race-safe, backward-compatible.
- No cost increase. No new dependencies.

---

## DONE — PaceSeeker (repo: PaceSeeker/, branch master)

| Commit | Status | Content |
|---|---|---|
| 311136a | PUSHED | `hasPendingSendReceipt` gates on `signed` receipts too — a kill between MWA sign and broadcast left a live receipt the repurchase gate missed |
| 770f655 | unpushed | pendingTx ledger: corrupt file quarantined instead of permanently throwing |
| 50ed02c | unpushed | Payment safety end-to-end (details below) |
| ea7411d | unpushed | Execution safety end-to-end (details below) |

### Payment fixes (50ed02c)
- `subscriptionReceipts.js` status check now `{ searchTransactionHistory: true }` — confirmed payments older than the node's recent cache were read as NOT_LANDED → reopened repurchase + skipped ecosystem verify (double-charge + lost entitlement).
- `paySubscription` synchronous `payInFlight` guard — check-then-act across the multi-second quote/MWA window allowed two independent payments.
- `isPromoCodeUsedOnChain` filters `sig.err` and fetches+verifies the PS1 memo against the actual payer — failed txs and arbitrary `promo:CODE` text can no longer burn a code.
- `recoverVerifiedPayment` compares against existing owner/device expiry — older chain recovery can't clobber a newer purchase.
- `saveSubscriptionPayment` serialized via save lock; renewal base = max(owner, device) expiry; signature dedup kept.
- `generatePaymentMemo`/`verifyPaymentMemo` JS fallback (same PS_SUB_V3_PEPPER as Kotlin); payment construction aborts if memo is not a valid PS1 proof.
- Receipt sweep uses `withReadFallbackConfirmed` — dead primary RPC can't wedge recovery.
- Entitlement envelope apply failure = retryable, not final.
- Quote modal pinned by monotonic sequence (stale-quote race); SOL fallback price staleness bound; server-quote tolerance 15%→tighter.
- New purchase invalidates the 15-min negative scan cache.
- Verified safe-by-design, unchanged: server conflicts are only terminal when `retryable:false`; `phase:'sent'` on post-record error correctly resolves via blockhash expiry; Kotlin native inactive records return `source:'none'`+`expired:true` so JS fallback was already reachable.

### Execution fixes (ea7411d)
- Atomic mode submits identical signed bytes via Jito+RPC — previously txNoTip/txWithTip had different signatures so both could land. Now on-chain dedupe prevents double fill; RPC fallback carries the tip.
- `delegateSessionOnChain`: `withRpcFailover` only wraps the blockhash fetch; MWA sign + broadcast run exactly once (no second prompt, no second tx on ambiguous send).
- `walletLock` stale release 120s→180s (must outlive 150s confirmation window).
- `maybeAutoRemitFee` awaited at tick start; `pendingRemit` signature persisted BEFORE `sendRawTransaction` via exported `txSignatureBase58`; ambiguous send leaves pending record for `_resolvePendingRemit`.
- `recoverStuckToken` takes `maxSellableAtomic` (= `tokensFromThisTrade` plumbed through result + `_stuckTokenTracker`): same-mint user deposits after a failure can never be swept into the recovery sell. `null` = legacy/WSOL uncapped.
- `sweepNonUsdcDust` skips `session.isImported` — never burn balances on real self-custody wallets.
- `searchTransactionHistory: true` added where sigs can outlive recent cache: dcaBot pending-remit resolver (old stuck remit could read null → cleared → double remit), dcaBot + tradingBot remit confirm polls, jitoExecutor swap1-landed check and confirm loop.
- pendingTx: partially malformed arrays salvage valid rows (dropped rows → `.dropped.*` forensic file); `MAX_ENTRIES` enforced evicting resolved rows first, unresolved never evicted.
- Test harnesses: `expo-application` stub added (Node 24 refuses type-stripping inside node_modules); pending-ledger corruption test rewritten to quarantine/salvage contract + new coverage for partial rows and resolved-row eviction.

### PaceSeeker test results
- `test-execution-reliability.js`: 53/53 (3 new ledger tests)
- `test-subscription-scan.js`: 39/39
- `test-pipeline-wiring.js`: 28/28
- `test-candle-merge.js`: 18/18, `test-market-context.js`: 8/8, `test-sim-planner.js`: 163/163, `test-pullback-scan.js`: 28/28, `test-indicator-recovery.js`: 23/23, `test-phase0-fixes.js`: 163/163
- `node --check` clean on all 12 edited .js files

---

## DONE — Server (repo: server/, branch main)

| Commit | Status | Content |
|---|---|---|
| f966cd3 | PUSHED | Security: multipart dedup self-deletion fix, `/api/device/link` ownership check, `/local-image` loopback+image allowlist, `/api/debug/*` admin auth, `/nft-transfer-sign` XSS, nonce-binding on `/nft-transfer-complete`/`/nft-mint-success|failed`/`/api/nft/mint-after-payment`/`/wallet-connected`, EXIF owner-field strip, `blockDeletedSubscription` on classic uploads, `/solana-rpc` per-IP rate limit |
| eaa885d | PUSHED | Multer writes `.part-<rand>` temp → atomic rename after sha256 verify (no partial-chunk reads); `.part-` orphan sweep hourly |
| 8cabe6b | unpushed | Deleted-account device_uuid tombstones released; `touchDeviceLastSeen` requires live user_id |
| 491afb0 | unpushed | device_uuid auto-release for canonical credential owners (uuidv5 re-derivation); wired into register/login/wallet-login/migrate-credentials |
| c31cf17 | unpushed | Treasury self-payments extract with `selfPayment` flag (signer-bound — only treasury keyholder can produce; can't be forged); covers SOL/SKR/legacy/SLQ2 |
| ebcbbe8 | unpushed | Classic-upload disk-fill closed (quota+per-file cap+reservation), device_uuid traversal closed at mint sites + joins, streaming hashes, thumbnail input cap, nftImageTokens + platform-hashes bounds |

### Fresh server pass (ebcbbe8) — megaplan phase 1, sequential full-file re-read

- **Classic uploads were unbounded and uncounted**: `/api/upload` (multer, no `limits`) and `/api/upload/raw` (raw stream, no cap) let any registered account write unlimited bytes to `UPLOAD_DIR` — `getUserUsedBytes` never counted that tree, so even subscribed users bypassed quota. Now: `UPLOAD_DIR/<key>` counted across all user keys; `reserveClassicUploadBytes` enforces plan quota (or the 5 GB default used by trial/NFT paths when no plan exists) under the same per-user reservation lock StealthCloud uses; 10 GB per-file cap on both routes (multer `LIMIT_FILE_SIZE` → 413; mid-stream abort + cleanup on the raw path); declared `Content-Length` reserved up front, actual bytes verified post-write for chunked bodies.
- **device_uuid path traversal**: `device_uuid` was accepted raw at `/api/register`, `/api/login`, `/api/wallet-login`, signed into the JWT and joined into `UPLOAD_DIR` paths; a poisoned `devices` row also reached `fs.rm(recursive)` in account purge and `existsSync` in orphan cleanup. `authenticateToken` claim checks already rejected poisoned tokens, but the login INSERT still persisted dirty rows. Now: format gate (`sanitizeUserKey(v) === v`) at all three mint sites, sanitized joins for DB-sourced uuids in orphan-cleanup/purge, and sanitized joins in upload/migrate-hashes.
- **OOM / event-loop**: whole-file `readFileSync` hashing → `streamSha256` in `/api/upload` dedup and the 250 MB multipart chunk-integrity verify; `/api/cloud/raw` dedup prefilters by size before hashing; thumbnail routes cap input at 300 MB before buffering for sharp/heic-convert (oversized → placeholder).
- **Unbounded in-memory/DB writers**: `nftImageTokens` (unauthenticated) capped at 100 live entries × 4 MB dataUri with sweep-on-write; `/api/files/platform-hashes` batch capped at 5000.
- **DB-sourced filename joins** in dedup/migrate paths basename'd (file-existence oracle closed).
- Test fix: `sanitizeUserKey` injected into the wallet-login VM sandbox in `paymentRecovery.test.js`.

Verified safe this pass, unchanged: treasury scan ledger-first + `entitlement_applied_at` resume; strict treasury/memo extraction with quote-evidence handling; CAS plan state machine; `adminAuth` (Basic+bcrypt+IP allowlist); `getClientIp` loopback-only proxy trust; `pendingVerifications` user-keyed with 15-min TTL; `requireUploadSubscription`; chunk `.part-` atomic finalize + in-flight protection; `chunkFileMatchesId` streamed 1 MB reads; IPFS JWT rotation + pin rate-limit bound; NFT public extension whitelist; wallet-binding-gated certificate keys; EXIF envelope strip; bounded NFT JSON cache + atomic writes; uptime merge caps.

Server tests: paymentRecovery **131/131**; `node --check` clean.

Residual notes (documented, not fixed): `/api/cloud/raw` buffers the whole body per the existing 500 MB `express.raw` contract; email/country verification codes are generated but never emailed (SMTP not configured — device-bound reset is the live path); `lockStealthCloudUploadForUser` middleware is defined but unmounted (the reservation helper takes the lock internally, so coverage is complete).

Verified safe, unchanged: `quotaBytes<=0` fail-open (legacy no-plan accounts; masked by `requireUploadSubscription`); registration `plan_gb` (by-design trial selection via walletAuth); premium routes already behind `NFT_SERVICE_CLOSED_ROUTES`; admin routes already Basic-auth+IP allowlist.

Server tests: paymentRecovery **131/131** incl. 3 new self-payment tests; `node --check` clean.

---

## DONE — PhotoLynk client (solana-seeker, branch master)

| Commit | Status | Content |
|---|---|---|
| bee9937 | PUSHED | Manifest pagination, reconcile safety, mid-batch auth recovery |
| e645209 | PUSHED | (earlier client batch) |
| c95b9bc | PUSHED | Restore lanes, repair sweep, lane-lease ownership |
| 66b964b | PUSHED | Unique lane owners through auto-upload batch + repair slice |
| aac7867 | unpushed | `app=pl` on ecosystem quote/quote-status/wallet-bind — silent 403→local-price fallback and broken wallet binding fixed |
| d07da80 | unpushed | EXIF backfill retries manifest page fetch 3× w/ backoff (4xx still immediate) |

Earlier client hardening (pushed): ls:/sc: restore lanes recover from mid-restore dead JWT; skip-path tmp deletes don't double-count failures; repair sweep: bare-path re-add, decode-throw wrap, retry-queue doesn't complete sweep, fetch failures don't burn attempts, real manifestId on skip, unresolved `conflict` ≠ uploaded (all 3 lanes + callers); Phase A floor `front===null&&done` fix; lease unique owner per lane + verify-after-write + lost-heartbeat abort; null-endCursor infinite loop fixed in both paging loops; iOS transient-empty first page one-retry; truncation guard fail-closed when `getInfoAsync` fails; `cleanupStaleTempChunks` per closed-app batch; headless lease-yield misread; staged-temp leak cleanup.

Client tests: purchase **83/83**, auto-upload yield **23/23**.

---

## DONE — nft-service (branch master)

| fd014b8 | PUSHED | Premium flat-fee charge aligned to advertised $0.01 (was charging $0.02); `PREMIUM_MAX_NO_FEE_MINTS` 10,000 cap enforced (past cap falls through to normal discount math); non-premium `photoLynkFeeFree` keeps $0.02 |

Verified working end-to-end: 100 free mints via atomic `UPDATE ... WHERE mint_count < 100` reservation; `releaseFreeMint` on pre-land failure; `recordReservedFreeMint` audit; premium only granted by verified server-side paths (`/upgrade-premium` closed by default); estimate/mint routes share `getPremiumStatus` counters.

---

## DONE — Companion / Lane app (RN, uncommitted local changes)

Full audit pass (~24K LOC): session orchestrator, LLM (local llama.rn + 7 cloud providers), STT/TTS/VAD pipeline, memory, tools, packs, stores, onboarding, i18n, remote config, secrets.

Fixes applied (uncommitted):

| File | Fix |
|---|---|
| `memoryEngine.ts` | Fact extraction rewrote **any** person-category match ("my wife is Olena") into `My name is Olena`; `addFact` deletes all prior `my name is` facts → erased the user's real name. Now only genuine self-name statements emit name facts (added multilingual self-name patterns); other person facts stored verbatim. |
| `cloudLlm.ts` | Anthropic conversion emitted each tool result as a separate consecutive `user` message (invalid). Now merges consecutive same-role messages into content blocks, `tool_use`/`tool_result` grouped correctly. Also gates `tools`/`tool_choice`/`stream_options` (OpenAI-compat) and empty `system`/`tools` (Anthropic) — fixes 400s on providers rejecting unknown fields. |
| `assistantSession.ts` | Memory recall was awaited serially before model prep; now overlapped with `ensureReady`/warmup (bounded). |
| `moduleStore.ts` | `setLlmProvider` picked stale static default model even when a live `/models` list was cached; now prefers cached live list, falls back to `pickDefaultModel`. |
| `catalog.ts` | Default STT pack labeled "Whisper Base" but `DEFAULT_STT_PACK` is `whisper-small` — label corrected. |
| `OnboardingScreen.tsx` | Premium/cloud path had **no API-key entry** — provider selected but key could never be set → cloud onboarding silently unusable. Added key field + live verify (`listModels`) + secure keychain save. New `intel.apiKeyHint` string in all 19 locales. |

Verified: `tsc --noEmit` clean; Jest **129/129** (13 suites).

Audit findings confirmed OK (no change needed): pack manager dedups `ensurePack` + verifies GGUF/extract; fresh `probeOnline()` per turn; TTS settle on finish/cancel/error + early-finish; turn-id staleness + barge-in drain; signed Ed25519 remote config fail-closed; keychain API keys (no MMKV); multilingual keyword memory fallback when no OpenAI key.

### Cloud STT/TTS implemented (second pass, uncommitted)

| File | Change |
|---|---|
| `stt/cloudStt.ts` (new) | OpenAI Whisper (multipart WAV upload) + Deepgram nova-3 (raw WAV body). 30 s timeout + caller abort via linked controller; `language` XOR `detect_language` on Deepgram; WAV payload clipped at 24 MB (~13 min) before allocation; `isJunk` re-applied to cloud results; detected language preserved (verbose_json / detected_language). |
| `stt/sttEngine.ts` | `RoutingSttEngine` wraps the sherpa engine: cloud only when provider+key+online; ANY cloud failure falls back to on-device for that call, except a caller abort (dead turn never burns a local decode); 2-min failure backoff; `preferLocal` flag routes wake/barge gates to an already-installed pack (ambient audio never bills cloud or leaves the device); `ensureLoaded` skips the local pack while cloud is usable. |
| `tts/cloudTts.ts` (new) | ElevenLabs `eleven_flash_v2_5`, `pcm_24000` s16le output; `voice_settings.speed` from `speechRate` (clamped 0.7–1.2); custom `elevenlabsVoiceId` secret honored; response validated (even byte count, ≤12 MB); a dedicated sherpa player instance id gives a standalone native AudioTrack — no model memory. |
| `tts/ttsEngine.ts` | `elevenlabs` VoiceCandidate injected first in `orderedCandidates` while `cloudTtsUsable()`; provider choice outranks stale per-language overrides; `playCloudSentence` reuses stopBarrier/playbackEpoch/writeChain/gain machinery; requests split at ~500 chars; in-flight fetches tracked in `cloudFetches` and aborted by `stop()`; 4xx (non-408/429) blacklist the candidate for the session, transient failures back off 60 s; `speak(..., forceVoiceId)` pins previews to the tapped voice. |
| `session/assistantSession.ts` | Three unsupported-language echo guards now skip the drop when `cloudTtsUsable()` (real speech in voice-less languages no longer discarded); `resolveReplyLang` no-voice fallback bypassed while cloud can speak; `checkStandbyPrefix`/`resolveStandby`/`resolveBargePrefix` pass `preferLocal` so gate decodes stay on-device. |
| `moduleStore.ts` | `setSttProvider`/`setTtsProvider` actions; `merge` sanitizes persisted provider values (corrupt → `local`). |
| `VoiceLanguageScreen.tsx` | "Speech engine" section: STT chips (on-device / OpenAI Whisper / Deepgram), TTS chips (on-device / ElevenLabs), keychain-backed key + voice-id fields, hydration-resync of drafts, fallback note; i18n keys added in all 19 locales. |
| `__tests__/cloudSpeech.test.ts` (new) | 13 tests: param exclusivity, payload clip, cloud routing, failure fallback, abort-no-fallback, preferLocal gating, offline routing, ElevenLabs 4xx/malformed-PCM/request shape, `cloudTtsUsable`. |

Verified: `tsc --noEmit` clean; Jest **142/142** (14 suites).

### Deep re-audit pass (third pass, uncommitted)

Prompt/persona, memory, internet/tools, language switching, latency, LLM engines, onboarding re-verified end-to-end. Fixes applied:

| File | Fix |
|---|---|
| `memoryEngine.ts` | **Name corruption class, round 2**: self-name patterns captured greedily — "my name is Viktor and I like coffee" stored the whole tail; `/i(?:'m| am) ([A-Z]…)/` turned "I'm Tired/American" into a name fact that *replaces* the real name; "call me tomorrow/when you get home" likewise. Added `cleanName` — cased text keeps only the leading capitalized-token run ("Viktor and I" → "Viktor"), caseless scripts cut at CJK grammar particles; junk captures store nothing. Bare "I'm X" now requires the whole utterance + capitalized name. Cloud extractor: skips when offline, 8 s abort timeout, 2000-char input cap (was unbounded fetch per message). |
| `memoryStore.ts` | `getRelevantFacts` fired one `set()`+MMKV persist per returned fact per turn → batched to a single write. `addFact` now dedups exact repeats (refreshes importance/access instead of stacking), evicts lowest-value fact at `MAX_FACTS=500` (array was unbounded — MMKV bloat + O(n) scoring growth). |
| `tools/search.ts` | `fetchWithTimeout` raced but never aborted the losing fetch (lingering sockets); now a linked controller drives timeout+cancel. `scrapeTop` read unbounded `response.text()` — a search hit could be a huge page or binary → Content-Length>1 MB and non-text Content-Type rejected pre-read. All fetches take the turn's AbortSignal. |
| `tools/weather.ts` | `fetchJson`/`geocode`/`getWeather` accept the caller's AbortSignal; geocode loops check `signal.aborted` between variants (up to ~24 sequential probes otherwise kept running after barge-in). |
| `tools/registry.ts` | `executeTool` takes `signal`, threaded to weather/search — mid-search barge-in now cancels in-flight fetches instead of burning up to ~30 s of doomed requests. |
| `llm/sse.ts` | `onData` throw left the promise unsettled forever (hung turn); now catches → reject. Added 30 s **idle** watchdog (XHR `timeout` counts total time and would kill slow-but-live streams; idle only fires on silence). Abort listener now removed on settle. |
| `llm/cloudLlm.ts` | `tool_choice` hardcoded `'auto'` ignoring `req.toolChoice` — now passed through (OpenAI `required`/`none`; Anthropic mapped to `any`/`none`). One pre-token retry on stream failure: a transient socket/idle error previously dead-ended the whole turn; retry gated on zero emitted deltas so nothing visible replays. |
| `session/assistantSession.ts` | `pendingBargeUtterances` was unbounded — a stalled resolver + ambient noise piled up multi-MB `Float32Array`s → capped at 2 like the standby queue. `executeTool` now receives the turn signal. |
| `OnboardingScreen.tsx` | Key draft didn't resync when keychain hydration landed after mount (iOS keeps keys across reinstalls) → `keyDirty` flag + saved-key subscription. Ready step now downloads the local LLM for BOTH modes — a premium user had no offline brain; offline/unkeyed turns hit a download prompt that cannot complete offline. |
| `IntelligenceScreen.tsx` | Same draft-hydration gap → `keyDirty` + saved-key subscription; catalog refresh split into its own effect so typing can't fire `listModels` per keystroke. |
| `packs/packManager.ts` | tar.bz2 path lacked the GGUF path's `mirrorUrl` failover — unified: both download paths try `url` then `mirrorUrl`, sha256 still verifies the payload regardless of host. |
| `memory/embeddings.ts` | Removed dead `generateEmbeddings` (no callers). |

Verified OK this pass, unchanged: VAD segmentation (bounded buffers, echo-floor EMA), wake/sleep phrase matching (NFKD-canonicalized, name-alias expansion, compact CJK matching), `fitLocalMessages` context trimming, llama serialization + background-preemption, `isJunk` filtering, message window `slice(-30)` + non-persisted turn context, `resolveReplyLang` canonicalization + no-voice fallback, mid-turn `reply_language` switch, secrets keychain storage, `probeOnline()` per turn, bounded `laneStore` (200 msgs), bounded `standbyPendingUtterances`, TTS `writeChain`/epochs/stopBarrier consistency.

Verified: `tsc --noEmit` clean; Jest **142/142** (14 suites).

### Fourth pass — remaining files + censorship-resilience sweep (uncommitted)

Every source file now read at least once. Fixes applied:

| File | Fix |
|---|---|
| `solana/mwa.ts` | `getConnection()` was pinned to `rpcEndpoints()[0]` — the entire mint/confirm path had **no RPC failover** despite backup + non-Cloudflare endpoints being configured (a throttled primary kills it in censored regions). Added `getWorkingConnection()`: probes endpoints in order (8 s bound), caches the winner 60 s, used for blockhash/send/confirm/status lookups. |
| `avatar/publishing.ts` | `ORIGIN` hardcoded `stealthlynk.io` — the signed remote config's `apiBaseUrl` field existed but was never read. `apiFetch` now honors it (trailing-slash normalized) so the API endpoint can rotate server-side. |
| `audio/micStream.ts` | `start()` failure left the half-open native stream + its subscribers live — a retry stacked a second recorder. Failed starts now tear down completely before rethrowing. |
| `tts/systemTts.ts` | `earlyFinished` set could grow unboundedly from events for already-rejected speaks — capped at 64. |
| `stores/avatarStore.ts` | `mints` history unbounded in persisted MMKV — capped at 200 (oldest evicted). |
| `stores/moduleStore.ts` | `systemPrompt` (persona additions) injected verbatim into every system prompt with no bound — a large paste swamps the untrimmed 3K-token local context prefix. Capped at 500 chars in the setter. |
| `screens/DevLabScreen.tsx` | VAD mic monitor had no unmount cleanup — leaving the screen with it running kept the mic capturing invisibly. Now torn down on unmount (dev-only screen, still a real leak). |

Verified OK this pass, unchanged: `remoteConfig.ts` (Ed25519 fail-closed, GitHub Pages bootstrap mirror already present), `connectivity.ts` (self-probes non-Cloudflare hosts when OS reports unreachable — GFW/throttling aware), avatar mint flow (receipt-before-broadcast, per-revision dedupe, signer-owner check, uncertain-status, in-flight sharing), `avatarStore` atomic updates (stale results can't demote lifecycle), i18n fallback chain, `localToolPolicy`, `device/memory`, `laneStore`/`assistantStore` bounds, `secrets.ts` keychain map, `WalletScreen`/`AboutScreen`/`AppNavigator`/`SettingsScreen`.

Verified: `tsc --noEmit` clean; Jest **142/142** (14 suites).

### Fifth pass — old users + online/on-device attack surface (uncommitted)

Fresh full re-read with emphasis on persisted-state corruption, SSRF/injection, and session teardown. Fixes applied:

| File | Fix |
|---|---|
| `stores/moduleStore.ts` | `merge` now sanitizes the full persisted surface for old/corrupt installs: `llmProvider` (unstamped garbage passed through to the engine router), `languageMode` (invalid string → `auto`), `speechRate`/`voicePitch`/`endSilenceMs`/`noSpeechTimeoutMs`/`wakeWordSensitivity`/`vadStartThresholdDb` (out-of-range/NaN → slider-range clamp or default). Explicit persisted `local` modes are preserved — never auto-upgraded to premium. |
| `tools/search.ts` | **SSRF**: `scrapeTop` fetched arbitrary URLs returned by DDG — a poisoned result pointing at `localhost`/`169.254.169.254`/LAN admin made the phone probe its own network and fed the body to the LLM. Added `safePublicHttpUrl`: http(s)-only, no credentials, rejects localhost/loopback/private/link-local/reserved IPv4+IPv6 (precise `fc00::/7`/`fe80::/10` forms — hostnames starting `fc`/`fd`/`fe80` are NOT blocked). DDG result fetches also bounded (Content-Length/type checks + capped read). |
| `session/assistantSession.ts` | **Echo-state race**: `persistReply(superseded)`'s guard parameter was never passed — every call ran as `superseded=false`, so a stale turn unwinding late unconditionally claimed `previousReply` AND cleared `currentReplyText` mid-newer-turn (could even attribute the newer turn's text to the stale turn's echo record). All 5 call sites now pass actual staleness. |
| `session/assistantSession.ts` | Early `speechSegment` decodes carried no abort — `sleep()`/`stop()` left them decoding discarded audio (wasted CPU or cloud billing). New `audioAbort` scope: recreated on mic start, killed on sleep/stop; deliberately survives `interrupt()` since queued barge utterances still consume those decodes when they drain. |
| `services/memory/memoryEngine.ts` | Japanese + Korean `selfName` fast-paths were missing entirely (regex layer is a bonus over LLM reflection, but inconsistent). Added tight patterns only — `Xと申します`, `名前はX`, `Xって呼んで`, `이름은 X`, `X라고 불러` — katakana/kanji/latin capture classes so hiragana particles can't bleed in; hiragana + honorifics added to `CASELESS_STOP_RE` (田中さん → 田中). A wrong name fact replaces the real name, so only unambiguous forms were added. |

Verified OK this pass, unchanged: `SttEngine` queue serialization + per-call abort checks, `RoutingSttEngine` cloud-failure backoff + preferLocal gating, `SherpaSttEngine` temp-WAV cleanup, cloud STT/TTS payloads/timeouts/failure blacklists, persona prompt (continuity, energy matching, tool honesty, no greeting loops), `buildTurnContext` (dynamic data never in KV-cache prefix), `fitLocalMessages` exchange-dropping, `localLlm` background-preemption + release timer, `memoryStore` dedup/eviction/batched recall, `reflectOnConversation` (bounded slice, salvage-partial-JSON, background priority), embedding fallback scorer (NFKC multilingual), `describeSpeech`, `lane://` deep link inert (exported but no consumer — remove or gate before future use), update-check fields dormant schema.

Verified: `tsc --noEmit` clean; Jest **142/142** (14 suites).

### Sixth pass — trust-boundary + old-user sweep (uncommitted)

Fresh re-read of avatar/wallet/services, VAD, catalogs, connectivity, phone tools, remote config, stores. Fixes applied:

| File | Fix |
|---|---|
| `services/remoteConfig.ts` | **Cleartext/malformed-URL downgrade**: `rpcUrl`/`backupRpcUrl`/`apiBaseUrl`/`updateUrl` were taken verbatim from the signed payload — a config *authoring mistake* (missing scheme or `http://`) would send the wallet bearer token and RPC queries in cleartext or break every request. All URL fields now require `https://` (fallback otherwise); `treasuryWallet` validated as base58 pubkey shape for when the dormant field goes live. |
| `tools/search.ts` | **SSRF bypass via octal IPv4**: `0177.0.0.1` passed the 4-numeric-part check (the private-range regex needed a literal `0.`/`127.` prefix) and octal-decodes to `127.0.0.1`. Dotted quads must now be canonical decimal ≤255, checked against the private ranges after normalization. Credentialed URLs (`user:pass@host`, which can smuggle an Authorization header) are rejected outright. |
| `engine/audio/vad.ts` | **Dead barge-in in loud-echo rooms**: uncapped `echo + 12` pushed the start threshold past 0 dBFS — a level the mic can never produce — so barge-in could never trigger. Threshold now capped at −15 dBFS; false candidates cost one local decode and get dropped by the transcript echo check. |
| `stores/moduleStore.ts` | **Hydration surface, round 2**: `merge` now validates everything persisted — `sttPackId`/`llmPackId` against the pack catalog by kind (a bogus truthy `sttPackId` threw on EVERY decode → STT dead forever), `verbosity`/`avatarProvider` enums, all strings (`voiceLanguage`, `wakeWord` ≤60, `systemPrompt` ≤500 — hydration previously bypassed the setter cap), `providerModels`/`voiceOverrides` shape-checked entry-by-entry, personality sliders clamped 0–100, feature flags coerced boolean. |
| `engine/net/connectivity.ts` | `probeOnline()` polled `selfProbeRunning` with no deadline — a wedged TLS handshake ignoring abort would stall every turn pre-LLM. Wait now bounded at 8 s (falls back to the last verdict). |
| `engine/tts/voiceCatalog.ts` | `vits-piper-uk_UA-lada-x_low` shipped in the pack catalog but had no `VOICE_TABLE` entry — a downloaded spare that could never serve as the Ukrainian fallback. Added after `ukrainian_tts-medium`. |

Verified OK this pass, unchanged: `publishing.ts` (bearer token never leaves the API origin, receipt-before-broadcast, `imageStillCurrent` at every stage, signer==owner check, canonical-pubkey asset matching, bounded downloads + revision re-validation), `mwa.ts` (RPC probe/failover + non-Cloudflare fallback, MWA base64 address decode, engine release before wallet handoff), `avatarStore.ts` (no-demotion update guard, capped mints, v1→v2 migration), `remoteConfig.ts` (Ed25519 fail-closed, mirror, retry+timeout), `systemTts.ts` (early-finish settle + bounded set + waiter drain), `voiceCatalog.ts`/`googleVoicePrefs.ts`, `vad.ts` (aside from the cap fix: pre-roll, segment boundaries, echo-floor EMA all sound), `registry.ts` (allowlist exec, canned localized failures, error normalization), `localToolPolicy.ts`, `catalog.ts` (sha256 + mirror failover, legacy LLM migration map), `phone.ts` (allowlisted schemes/packages, dialer-only, bounded label, intent race timeout), `secrets.ts` (empty key deletes, non-empty-only import), `connectivity.ts` (non-Cloudflare self-probes, GFW-aware reachability).

Verified: `tsc --noEmit` clean; Jest **142/142** (14 suites).

### Seventh pass — pack integrity + hydration race sweep (uncommitted)

Fresh re-read of packManager, micStream, wav, scriptLang, voiceCommands, sentenceSplitter, numberWords, embeddings, walletStore, avatarStore, App bootstrap. Fixes applied:

| File | Fix |
|---|---|
| `engine/packs/packManager.ts` | **Truncated-GGUF integrity hole**: `verifyOnDisk` passed any file ≥95% of catalog size *without* sha256 — a partial leftover from a killed download (e.g. 1005 MB of a 1056 MB pack) was marked `ready` and fed to the native GGUF loader unchecked. New `.complete` marker: written after hash+size verification; marker-less GGUFs get one hash on first verify (pre-marker installs verify once, then marked); partials fail hash → redownload. |
| `engine/packs/packManager.ts` | **Delete-during-download ghost pack**: `deletePack` mid-download left the job to finish → file landed after the delete and `refreshPackStates` resurrected it as `ready`. New per-pack generation counter — a download finishing across a delete unlinks the payload and reports `absent` (not `error`). |
| `App.tsx` | **Standby never armed on slow hydration**: the 1.2 s arm timer reads `onboardingCompleted` — on slow first launches (legacy migration) MMKV hydration lands later, the flag reads its `false` default, and wake-word standby never armed until the next AppState change. `armIfEnabled` now also runs from `onFinishHydration`. |
| `stores/moduleStore.ts` | **Trivial wake phrase**: `setWakeWord`/hydration accepted any string — "the"/"ok" would fire wake on constant false positives. Normalized-length floor (≥4 letters/digits) in both setter and `merge`; invalid persisted values fall back to 'Wake up Lane'. |
| `stores/walletStore.ts` | `payments` array unbounded in persisted MMKV — capped at 200 (setters are dormant schema; cap lands before future wiring uses it). |
| `services/memory/embeddings.ts` | `generateEmbedding` had no fetch timeout — a stalled socket in the background fact-embedding path never settled. Now `AbortSignal.timeout(15s)` (critical-path recall still bounded by the existing 1.5 s race). |

Verified OK this pass, unchanged: `micStream.ts` (failed-start teardown, per-handler error isolation), `wav.ts`, `scriptLang.ts` (uk/ru discriminating letters + shared-word fallback), `voiceCommands.ts` (NFKD canonicalization, CJK compact pass, bare-'wake up' guard, name-alias expansion), `sentenceSplitter.ts` (abbrev/decimal/ellipsis handling, undecided-tail deferral), `numberWords.ts` (uk/ru inflection, char-model normalization), `avatarStore.ts` (demotion guard — network failure can't roll back confirmed/indexed receipts), `walletStore.ts` (subscription cleared on disconnect, dormant setters), `assistantStore.ts`, bootstrap warm/arm timer ordering, memory recall timeout layering.

Verified: `tsc --noEmit` clean; Jest **142/142** (14 suites).

### Eighth pass — engine cores end-to-end (uncommitted)

First complete fresh read of `ttsEngine.ts` (all 1347 lines), `sttEngine.ts`, `localLlm.ts`, and the full `assistantSession.ts` re-read (standby gate → barge drain → runTurn tool loop → persistReply → interrupt/doStop). Fixes applied:

| File | Fix |
|---|---|
| `engine/stt/sttEngine.ts` | **Ambient-billing guard bypass window**: `preferLocal` decodes checked `getPackState` — an in-memory map reading `'absent'` until the post-launch `refreshPackStates()` lands. A standby/wake decode in that window with an installed pack fell through to the **paid cloud API** — the exact leak `preferLocal` exists to prevent. The gate now awaits `refreshPackStates()` (cheap re-stat once warm) before trusting the map. |
| `services/memory/embeddings.ts` | `generateEmbedding` had no fetch timeout — a stalled socket in the background fact-embedding path never settled. 15 s AbortController + timeout (RN's AbortSignal.timeout isn't typed in this lib — controller pattern like the rest of the codebase). |

Verified OK this pass, unchanged: `ttsEngine.ts` in full — epoch/generation machinery (stale queue items settle as aborted, can never reach a restarted player), per-item tail-write snapshots (a later generation's backlog never extends speak()'s wait), writeChain serialization + playbackEpoch gating, serialized loads bounded by MAX_LOADED with awaited eviction, cloud/system/local candidate fallback with correct blacklist semantics (4xx→session blacklist, transient→never blacklisted, missing pack→user-actionable error), ElevenLabs PCM through the same AudioTrack machinery with stop()-linked fetch aborts, system-TTS early-finish detection; `sttEngine.ts` queue serialization, per-call pack+hint capture, abort checks at every await, junk filtering, cloud backoff + abort-propagation; `localLlm.ts` completion serialization, background-priority preemption reaching stopCompletion, KV-prefix key discipline, stale-context detect+reload, busy-retry, tool-call stream parsing (held tokens + tag stripping); `assistantSession.ts` end-to-end — lifecycleEpoch guards on every async boundary, wake/sleep/barge precedence, savedParts ownership handoff across interrupt, preferLocal gating on ALL gate decodes (standby prefix, standby utterance, barge prefix) while real turns stay cloud-eligible, persistReply staleness at all call sites, interrupt/doStop teardown order.

Verified: `tsc --noEmit` clean; Jest **142/142** (14 suites).

---

## TO DO

1. **Push 8 unpushed commits**: PaceSeeker 3 (770f655, 50ed02c, ea7411d), server 3 (8cabe6b, 491afb0, c31cf17), client 2 (aac7867, d07da80). All verified green locally.
2. **Audit scopes never covered** (original 6-agent launch died in IDE crash; only payments + execution were completed):
   - DCA bot internals (dcaBot.js ~3k lines, dcaAI.js ~8.7k lines): fill accounting, circuit breakers, learning-bank persistence races
   - Wallet/security surface: walletService sendSignedTransaction edge cases, session key restore, txSafety assertions, SecureStore handling
   - RPC/network layer: heliusRpc failover matrix, withFastFallback/withReadFallback semantics under all error classes, rate limiting
   - Native Android/config: SecurityModule.kt ↔ JS parity beyond the pepper (verified), nativeConfig treasury/fee values vs server, build.gradle release config, remote-config.json consumption
3. **Round-2 re-audit** of ea7411d execution fixes — independent verification that identical-byte atomic submission can't leave Jito-charged-but-RPC-unfilled states, delegation single-broadcast under every withRpcFailover error class, maxSellableAtomic null-vs-0 boundary, imported-wallet dust skip doesn't break generated-session cleanup.
4. **Known-safe-but-untested live paths**: Jito bundle poll keeps `searchTransactionHistory:false` deliberately (fresh sigs, hot loop); server `/api/device/link` release path should get a live smoke test before production; treasury self-payment is test-only affordance — confirm no prod flow depends on it being rejected.
5. **Coordination constraint**: max 2 concurrent agents (IDE crashes on more).
6. ~~Companion — cloud STT/TTS declared but unimplemented~~ **DONE** (see above): OpenAI Whisper + Deepgram STT, ElevenLabs TTS, provider UI, online/offline + failure fallback, race-safe cancellation, ambient-decode `preferLocal` gating.
7. ~~Companion — `modelFetcher.ts` integration check~~ **DONE**: file deleted; onboarding + settings use live `listModels` directly.
8. **Companion — device verification pending**: real-device pass for pack downloads (resume/partial-fail), cloud STT/TTS against live APIs (key validity, Deepgram `detect_language`, ElevenLabs PCM playback through the sherpa AudioTrack path), voice/STT quality, memory continuity, TTS races under barge-in, app backgrounding mid-turn.

## Companion audit — pass 9 (2026-02-21, OOM/memory-pressure focus)

Independent full read with an explicit OOM/bounded-memory lens: every
accumulation point (audio buffers, persisted stores, network bodies, prompt
context, MMKV blobs), plus the store-hydration surface for corrupt blobs.
`tsc --noEmit` clean; Jest **142/142** (14 suites) green.

### Fixed

1. `remoteConfig.ts` — unbounded `res.json()` on a remote-config body let a
   hostile endpoint allocate before signature checks. Now Content-Length
   gate + post-read size cap (256 KB) — also covers chunked bodies.
2. `memoryStore.ts` — **no `merge` validator**: a corrupt persisted blob
   (`facts: "x"`) loaded verbatim → `.map`/`.filter` throws inside
   `runTurn` → every turn dead for that user. Hydration now validates all
   fields (facts/meta/object-type, per-field string caps, `lastConversationAt`
   coerced). `setConversationSummary`/`setOpenThreads` also bounded at write
   time (defense in depth — hydration caps only run once).
3. `laneStore.ts` — same missing-validator class: corrupt `messages` blob →
   `.filter` throw in `runTurn` → every turn dead. Merge validates messages
   (bounded content/parts/images, valid roles) + `pendingIntent` shape.
4. `avatarStore.ts` — corrupt `mints`/`image` crashed AvatarScreen render on
   `.signature`/`.revision` access. Merge validates receipts (non-empty
   signature) and image shape; capped at MAX_MINTS. (Also fixed a TDZ bug in
   this edit — `merge` runs during sync MMKV hydration before module-bottom
   consts, so MAX_MINTS had to move above the store.)
5. `moduleStore.ts` — `providerModels` capped at 100 entries but each string
   was unbounded → corrupt blob could inflate MMKV ~MBs. Per-id cap 128.
6. `memoryEngine.ts` — assembled `memoryContext` could reach ~7 KB →
   ~2.2K tokens + ~1.4K system/tools over the 3K local window →
   `fitLocalMessages` throw → turn fails *exactly for long-term users with
   full memory*. Context now bounded ~1800 chars (summary trimmed first,
   facts/open-threads/recent-context capped), then hard-clamped.

### Verified bounded, no change

- Audio: utterance 28 s cap (~1.8 MB), segments ≤6 s, pendingBargeUtterances
  ≤2, VAD pre-roll ~12 KB; cloud STT clips payload to 24 MB, Deepgram sends
  raw bytes (no base64), OpenAI base64 transient bounded by clip.
- Photos: picker resizes 1024 px / 10 MB with post-copy stat; publishing
  downloads to disk (not memory); pinImage bounded by the same 10 MB cap.
- Prompts: 15-part / 10-slice caps in `asString`, tools capped 8×240 chars,
  system prefix ≤500, `nCtx 3072` context fitting.
- History: laneStore 200 persisted messages, facts 500 w/ eviction,
  summary ≤4000/open-threads ≤5, avatar mints ≤200, wallet payments ≤200,
  `seenIds` ≤64, `earlyFinished` ≤64, `lastRequestIds` ≤10.
- `bufferedSentences` during a stalled barge verdict: bounded by ~50
  sentences from a 700-token reply — small strings, no fix needed.

### Cumulative

Per-pass real-bug findings: 11 → 7 → 5 → 6 → 6 → 2 → 6 (resource-focus pass —
store-hydration gaps found by looking at corrupt-persisted-state for the
first time). Every file re-read 5+ independent times. Device verification
remains the open item (native PCM/keys/iOS/real-network).

## Companion audit — pass 10 (2026-02-21)

Fresh full read: publishing (complete end-to-end), walletStore,
assistantStore, cloudLlm, sse, cloudTts, providerModels, App.tsx,
embeddings, memoryEngine (reflection + bounded context), all previously
unre-read screens (Conversation, Listening, Preparation, Intelligence,
Packs, VoiceLanguage, Onboarding async surface). Cross-checked against the
sibling `applyApiBaseToUrl` pattern — Companion already resolves the API
origin per-request in `apiFetch`, so a mid-session rotation is honored.
`tsc --noEmit` clean; Jest **142/142** (14 suites) green.

### Fixed

1. `sse.ts` — **unbounded stream**: `xhr.responseText`/`lineBuf` had no
   ceiling; a compromised endpoint or hostile proxy could stream endlessly
   (idle timer catches silence, not volume) → streamingReply,
   bufferedSentences and the TTS queue grow until OOM. Hard 4 MB response
   cap now aborts the stream with an error the turn handles gracefully.
2. `cloudTts.ts` — `MAX_PCM_BYTES` was checked *after* `arrayBuffer()`
   allocated. Content-Length gate now rejects oversized bodies before they
   reach the JS heap (post-read check retained for chunked responses).
3. `providerModels.ts` — `res.json()` unbounded on /models listings
   (OpenRouter ~2 MB legit). `modelsJson` bounds to 16 MB via
   Content-Length + text length before parse.
4. `weather.ts` — same class: fetchJson now bounds the body to 1 MB
   before JSON.parse.
5. `walletStore.ts` — **no merge validator**: corrupt `payments` blob →
   `.map` throws in WalletScreen render; corrupt `walletAddress` →
   `formatAddress` crash / poisoned MWA calls. Hydration now validates
   every field (payments shape-checked + capped 200, string fields,
   balances ≥0 finite, tier enum, expiry number; `isConnected` forced
   false without a valid address).
6. `memoryStore.ts` — merge accepted any array-of-numbers as an
   `embedding` — a corrupt blob could hold million-element arrays
   inflating the whole persisted state. Now requires exactly
   EMBEDDING_SIZE finite numbers (cosine needs equal length anyway).
7. `VoiceLanguageScreen.tsx` — voice preview never aborted on unmount;
   the singleton TTS queue kept speaking into the user's next turn.
   Preview controller now aborted on unmount.
8. `moduleStore.ts` (providerModels per-id cap already in pass 9 — the
   on-disk revert of modelsJson call sites was caught and re-applied this
   pass; also hardened all `res.headers.get` to optional-chained access
   for mocked-Response compatibility).

### Verified, no change

- `publishing.ts` complete: per-request `apiBaseUrl` (mid-rotation safe),
  bearer confined to API origin, receipt-before-broadcast, signer==owner,
  imageStillCurrent at every stage, DAS pagination bounded (5×100),
  uncertain status never auto-resends, engine release before wallet
  handoff (LMK protection).
- `App.tsx`: hydration→arm wiring on all four paths, all subs/timers
  cleared.
- `cloudLlm`: pre-token retry guard (`emitted`), toolAcc per-attempt
  reset, abort-honored throughout; Anthropic alternation merge correct.
- `assistantStore`: not persisted — no hydration surface.
- Screens: Conversation (focus effect cancels), Listening (slider bounds
  match merge clamps), Preparation (sub+timer cleanup), Intelligence
  (draft-key flow, rejected keys never stored), Packs, Onboarding async.

### Cumulative

Per-pass findings: 11 → 7 → 5 → 6 → 6 → 2 → 6 → 8 (incl. test-compat
fixes). New class closed this pass: every response body reaching
JSON.parse/arrayBuffer is now size-gated. Device verification remains
the open item.

## Companion audit — pass 11 (2026-02-21, regression + drift focus)

Fresh full read explicitly hunting for *self-inflicted harm*: validators
dropping legit old data, caps clipping real responses, hardening edits
reverted by drift. `tsc --noEmit` clean; Jest **142/142** (14 suites).

### Fixed

1. `search.ts` + `remoteConfig.ts` — **edit drift re-caught**: the
   optional-chained header access from pass 10 had reverted to plain
   `res.headers.get` in both files (mocked Responses in tests lack
   `headers`; a missing header object would throw). Re-applied `?.`
   and verified on disk.
2. `avatarStore.ts` — **old-user data loss in my own pass-9 validator**:
   merge required `image.revision` (a field added after images were
   already being persisted) → legit legacy photos silently dropped at
   hydration. Now synthesizes a revision for legacy records — preserved
   photo, conservative "image changed" semantics retained.
3. `packManager.ts` — delete-during-verify race: `ensurePack`'s early
   `verifyOnDisk → ready` path checked the delete generation only after
   `downloadAndExtract`, so a `deletePack` racing the disk check could be
   overwritten by `ready`. Generation check now guards both paths.
4. `moduleStore.ts` — `setLlmModel` persisted user-typed ids uncapped
   (MMKV bloat / oversized request body). 128-char cap in setter +
   merge (pre-cap persisted blobs included).

### Verified fresh this pass, no change

- Regression checks on every pass-9/10 bound: `fitLocalMessages` only
  drops complete *old* exchanges — the 1800-char memory context rides
  inside the latest user message and can never be trimmed away; the
  local-model floor still throws only when one exchange alone can't fit.
- `laneStore` merge: role/text/id/timestamp normalization keeps legit
  old messages; `memoryStore` merge: `category` coerced not dropped,
  `id` required only because `addFact` always assigns one — no legit
  fact can lack it; embeddings require exactly EMBEDDING_SIZE.
- `sttEngine` full re-read: preferLocal→refreshPackStates→pack-state
  gate; Sherpa queue serialization + per-call hint capture; cloud
  abort never falls back to local; `createEngine` sets loadedPackId
  only after createSTT resolves.
- `packManager` full re-read: `.complete` marker + 95% size floor +
  sha256; migrateLegacyModels leaves marker-less files for one-time
  hash (no forced redownload for old installs); mirror failover +
  extraction `finally` cleanup; findExtractedDir fallbacks.
- `connectivity.ts` full re-read: bounded self-probe wait, unknown
  keeps last verdict, non-Cloudflare probe hosts.
- `i18n`: `t()` falls back en→raw-key (half-translated dicts can't
  crash); `useT` re-renders on voiceLanguage (instant language switch).
- `prompt.ts`: system prompt stays static (KV-cache prefix), dynamic
  context only in buildTurnContext tail; no greeting loops, tool
  honesty, reply-language pinning, energy matching — persona intact.
- `phone.ts`: scheme/package allowlists, `tel:` digits-only sanitize,
  label ≤80, hour/minute range checks, sendIntent race bound.
- `DevLabScreen`: unmount tears down mic + segmenter; `usePackStates`
  proxy merges live events over disk state.
- `AvatarScreen` openURL: fixed https host, assetId fills a path
  segment only — cannot escape origin.
- `moduleStore` migrate: v6→v7 key export to keystore, legacy default
  prompt reset, stale voiceOverrides dropped; `wakeWord` ≥4-letter
  floor present in both setter and merge.

### Cumulative

Per-pass findings: 11 → 7 → 5 → 6 → 6 → 2 → 6 → 8 → 4. All confirmed
hardening intact on disk; the two regressions found were in *my own*
earlier validators (avatar revision) and residual drift, both fixed.
Device verification remains the only open item: live API keys,
ElevenLabs PCM through native AudioTrack, pack resume on real
networks, iOS parity, wallet/RPC under censorship.

## Companion audit — pass 12 (2026-02-21, API-base cross-check + cold files)

Fresh read driven by the sibling `getApiBaseUrl()` migration: verified
Companion has no stale hardcoded API origin (apiFetch resolves
`getRemoteConfig().apiBaseUrl` per request; `stealthlynk.io` remains
only as the baked fallback and connectivity self-probe target). Then
full fresh reads of every file not covered in pass 11:
`catalog.ts`, `systemTts.ts`, `voiceCatalog.ts`, `googleVoicePrefs.ts`,
`localToolPolicy.ts`, `registry.ts` (all 649), `emergency.ts`,
`settings.ts`, `weather.ts` (all 462), `numberWords.ts`,
`scriptLang.ts`, `micStream.ts`, `wav.ts`, `cnft.ts`, `secrets.ts`,
`navigationRef.ts`, `image.ts`, `config.ts`, `AvatarPresence.tsx`
(all 503).
`tsc --noEmit` clean; Jest **142/142** (14 suites).

### Fixed

1. `weather.ts` — geocoder strings (`hit.name`, `hit.country` from
   Open-Meteo/Nominatim) and the model-supplied `location` reached the
   prompt unbounded; a hostile or degenerate display name could bloat
   the tool message → `fitLocalMessages` throw. Capped at source
   (place 120, country 80, location arg 120).
2. Drift check — `res.headers?.get` had again reverted to plain `.get`
   in `search.ts`/`remoteConfig.ts` (this time resolved to the even
   safer `res.headers?.get?.()` form — headers object without a `get`
   method can't throw). Verified on disk.

### Verified fresh this pass, no change

- `catalog.ts`: all GGUF packs sha256-pinned (mirror trust never
  delegated); tar.bz2 packs verified by requiredFiles + bzip2 block
  CRCs over GitHub TLS; `findExtractedDir` candidates can't cross-match
  between packs; `recommendedLlmPackId` RAM split correct.
- `systemTts.ts`: utterance waiters always settle (event or stop()
  drain), `earlyFinished` ≤64, shared refresh promise, persona-pitch
  only applied to the matching voice id.
- `voiceCatalog.ts`: lada-x_low uk fallback wired; persona voice leads
  → offline system → bundled → network-only ordering; Norwegian/Mandarin
  aliases consistent across sameVoiceLang/VOICE_TABLE.
- `registry.ts`: allowlist dispatch, offline + webSearch gates before
  exec, all args validated inside executors, bounded model-facing
  formatting (search ≤1000 chars), canned localized failure replies
  prevent invented answers, raw log capped 600.
- `weather.ts`: abort propagates through all geocode variants + fetches,
  WMO map complete, declension/transliteration variants deduped,
  unknown-place guard rejects fuzzy mismatches on both geocoders.
- `settings.ts`/`phone.ts`/`emergency.ts`: every write range-checked,
  intent targets whitelisted, tel: sanitized, dataset offline.
- `cnft.ts`: mintV1 wire layout matches PhotoLynk, URI ≤200 B https or
  bare-CID ipfs, owner fills all signer slots.
- `micStream.ts`: failed-start teardown intact (no stacked recorders),
  per-handler error isolation. `wav.ts` bounded by the 28 s cap.
- `secrets.ts`: empty key deletes, keystore-only, import filters
  non-empty strings.
- `image.ts`: MIME→extension whitelist, 1024px/10MB + post-copy stat,
  old avatar never removed before new copy succeeds.
- `AvatarPresence.tsx`: every listener unsubscribed, animation clock
  cancelled on blur/background/reduce-motion, imperative 10 Hz level
  subscription (no render churn), failed-URI fallback chain.
- `i18n`/`prompt`/`contextBudget`/`packManager`/`sttEngine`/`connectivity`
  (pass-11 full reads) — no drift detected on re-check.

### Cumulative

Per-pass findings: 11 → 7 → 5 → 6 → 6 → 2 → 6 → 8 → 4 → 2. Every
source file has now had 6+ independent full reads; remaining exposure
is concentrated in device-only verification (live keys, native PCM,
iOS, real-network censorship).

## Pass 13 — 2025-10-14 (stalled-body/timeout-arming pass)

`tsc --noEmit` clean. Jest: 14 suites, 142/142 tests pass.

### Found & fixed

1. **Abort disarmed before the body read — everywhere.** `fetch`
   resolves on headers; every site that `clearTimeout`ed right after
   `await fetch` left `res.text()`/`res.json()` waiting on a stalled or
   trickling body with no deadline. A slowloris-style endpoint (or a
   dead proxy on a captive/censored network) would hang the caller
   forever — remote-config refresh, model list, search, avatar API.
   - `remoteConfig.ts`: fetch+`res.text()` now share one try/finally so
     the 6 s abort covers the whole body; size gate kept (256 KB).
   - `search.ts` `fetchWithTimeout` now returns `{res, done}` — callers
     hold the timeout+abort armed through `boundedText`, which also
     gained the missing post-read length cap for chunked bodies.
   - `publishing.ts` `apiFetch` and `providerModels.ts` `modelsGet`:
     abort stays armed to `timeoutMs` (firing on a finished request is
     a no-op) — bounds total request time including body delivery.
2. **`boundedText` post-read cap missing** (`search.ts`) — Content-Length
   gate alone; a chunked body without the header slipped through
   unbounded. Post-read slice at 1 MB now.
3. **`apiJson`/embeddings/STT/TTS body bounds** — `publishing.apiJson`
   (1 MB), `embeddings` (declared+actual), `cloudStt.smallJson` +
   `httpError` detail reads, `cloudTts.httpError` — no unbounded
   `res.json()`/`res.text()` remains.
4. **`pinImage` whole-file base64 read before size check** —
   persisted `localUri` could point at a multi-GB file; `readFile` +
   Buffer would spike ~2.3x size into the JS heap. `RNFS.stat` gate now
   runs before the read.
5. **`inspectCharFrontend` unbounded sidecar reads** (`ttsEngine.ts`) —
   tar.bz2 packs have no sha256; `.onnx.json`/`tokens.txt` reads are
   now size-gated at 1 MB.

### Test-mock fixes exposed by the new code paths

- `avatarPublishing.test.ts`: `jsonRes` mock lacked `.text()` (added
  `JSON.stringify` body) and the RNFS mock lacked `stat` (the new
  `pinImage` gate threw TypeError → mint never reached send →
  `deferred.promise` rejected with no consumer → unhandledRejection
  killed the Jest worker — surfaced as a crash, not an assertion).

### File-drift incidents this pass

`publishing.ts` reverted mid-edit at least four times (md5 changed
between consecutive reads); `search.ts` briefly held a mixed state
(new call sites, old helper signature). All fixes re-verified on disk
after the final tsc+jest run. If an editor buffer holds these files
open, accept the incoming diffs or close/reopen them.

### Cumulative

Per-pass findings: 11 → 7 → 5 → 6 → 6 → 2 → 6 → 8 → 4 → 2 → 5.
Device-only verification remains the open item (live keys, native
PCM, iOS, real-network censorship).

## Pass 14 — 2025-10-14 (re-verification + residual body-bound sweep)

`tsc --noEmit` clean. Jest: 14 suites, 142/142 tests pass.

### Found & fixed

1. **Merged publishing.ts was broken at compile + runtime.** The
   hand-merged ApiResponse version had `clearTimeout(timer)` in
   `finally` with no `timer` declaration (ReferenceError on every API
   call) and `await res.json()` call sites on `ApiResponse` objects
   that expose no `.json` method (TypeError on every API call).
   - `const timer` restored — clearing in `finally` AFTER the
     prefetched `res.text()` keeps the abort armed through the body
     AND disposes the timer (better than the never-clear variant).
   - `ApiResponse` now carries a bounded `json()` method backed by
     `parseApiBody` (1 MB cap) — so `res.json()` and any future
     `apiJson(res)` call site are both correct and bounded regardless
     of which merge shape survives editor drift.
   - `authenticatedFetch` return type corrected to `ApiResponse`.
2. **`memoryEngine` fact extractor: unbounded body + disarmed
   timeout.** `response.json()` after `clearTimeout` — a stalled or
   huge chat-completions body could hang the background pipeline or
   spike the heap. Body now read under the 8 s abort with a 256 KB
   declared+actual gate (legit extraction ~2 KB).
3. **`httpError` chunked-body hole in `cloudStt` + `cloudTts`.**
   `declared <= 8192` passed `declared === 0` — the unknown-size
   (chunked) case — so a hostile error body was fully materialized
   for a 200-char log slice. Gate tightened to `declared > 0 &&
   <= 8192`; the diagnostic detail is lost for chunked errors but no
   unbounded read can occur.

### Verified this pass

- Full body-parse sweep: every remaining `res.text()/json()/
  arrayBuffer()` site in src/ is bounded — search, weather,
  providerModels, cloudStt, cloudTts, remoteConfig, memoryEngine,
  embeddings, publishing (12 sites, all gated).
- Pass-13 fixes still on disk: remoteConfig armed abort, search
  done() handle, providerModels armed abort, pinImage pre-stat,
  inspectCharFrontend sidecar gate, embeddings timeout+bounds.

### Cumulative

Per-pass findings: 11 → 7 → 5 → 6 → 6 → 2 → 6 → 8 → 4 → 2 → 5 → 3.
Device-only verification remains the open item (live keys, native
PCM, iOS, real-network censorship).

## Pass 15 — 2025-10-14 (unhandled-rejection sweep + session re-read)

`tsc --noEmit` clean. Jest: 14 suites, 142/142 tests pass.

### Found & fixed

1. **Unhandled rejection — `VoiceLanguageScreen.tsx`.**
   `refreshSystemVoices().then(setSysTick)` had no `.catch` — a native
   voice-enumeration failure would surface as an unhandled rejection
   (the same class that crashed a Jest worker in pass 13). Added
   `.catch(() => {})`.
2. **Unhandled rejection — `AvatarPresence.tsx`.**
   `AccessibilityInfo.isReduceMotionEnabled().then(...)` same pattern,
   same fix.

### Verified clean this pass

- **Unhandled-rejection sweep across src/**: every other `.then()` has
  a paired `.catch`, every `void`-fire-and-forget either self-catches
  or ends `.catch(() => undefined)` — localLlm queue chains, mwa
  engine-release, connectivity probe, packManager marker writes,
  ttsEngine load/write barriers, DevLab handlers, publishing pins.
- **`mwa.ts` full read** — Promise.race probe keeps handlers attached
  (no unhandled rejection; loser fetch is bounded), engine release
  caught, balance failure can't invalidate a successful MWA auth,
  `lastError` non-Error guarded, RPC ordering = signed-config
  rpcUrl → backupRpcUrl → non-Cloudflare fallback.
- **`assistantSession.ts` full re-read** (this pass covered
  960–2299): pendingBargeUtterances capped at 2, savedParts
  ownership handoff correct on both prefix and candidate paths,
  drainPendingBarge preserves verdict order via startAt sort,
  persistReply staleness (newerRecorded) airtight, sendText /
  interrupt / doStop teardown complete.
- Store merges: all five persisted stores (avatar, lane, memory,
  wallet, module) still carry `merge:` validators on disk.
- No `setInterval` anywhere; the only `new Promise` sites are
  bounded sleeps.

### Cumulative

Per-pass findings: 11 → 7 → 5 → 6 → 6 → 2 → 6 → 8 → 4 → 2 → 5 → 3 → 2.
Device-only verification remains the open item (live keys, native
PCM, iOS, real-network censorship).

---

## Pass 16 — async/race/stale-closure + uncovered-module sweep — 0 findings

`tsc --noEmit` clean · Jest 142/142 (14 suites).

### Fresh full reads this pass (previously least-covered files)

- `engine/stt/sttEngine.ts` (all 405 lines): single native-op queue,
  pack+hint captured per call, abort checked at entry/queue/pre/post
  decode, WAV write+unlink in finally, `preferLocal` refreshes pack
  states before trusting them (post-launch cold-state guard), cloud
  2-min backoff, junk filter (marker ratio, stutter run, letter-free).
- `engine/packs/packManager.ts` (download/extract/ensure/delete):
  mirror failover both formats, sha256 before any native parser,
  generation guards on verify AND download paths, inflight dedup,
  extraction → findExtractedDir → move → verify.
- `engine/net/connectivity.ts` (all): GFW-aware self-probe (3 diverse
  non-Cloudflare HEADs, Promise.any, 6s per-probe, 30s throttle),
  bounded probeOnline wait, null→conservative-online.
- `services/secrets.ts` (all): keystore-only, empty key deletes,
  per-key isolation on load/import, v6→v7 plaintext lift.
- `engine/device/memory.ts`: /proc/meminfo read, iOS-safe 6GB fallback.
- `i18n/index.ts` (all): dict→en→raw-key fallback, no→nb / cmn→zh
  normalization consistent with voiceCatalog, useT subscription.
- `engine/tools/emergency.ts` + `emergencyData.ts`: offline dataset,
  114 well-formed entries (iso2 + digit-only numbers verified by
  structural grep), iso→exact→substring lookup, model-arg path.
- `stores/moduleStore.ts` merge re-verify: providerModels 100×128 cap,
  voiceOverrides 120/20 caps, llmProvider whitelist + local-mode
  coercion, languageMode ISO regex, all engine numerics clamped to
  the same bounds the setters enforce.
- `engine/session/assistantSession.ts` 560–1299 fresh: armWake epoch
  dance (pendingStop wait → epoch re-check), open() single
  pendingStartup + startupTarget, runStartup stale-start never opens
  mic, startMicPipeline full failure teardown (unsub+stop on both
  reject and stale-epoch), onMicFrame dispatch (level 100ms/3dB
  throttle, barge arm conditions, prefix vs standby gates,
  speechSegment decode-vs-raw-buffer, utterance routing, pendingBarge
  cap 2 + own-parts snapshot), isEchoTranscript (content-token overlap
  + ordered run + near-playback weak match all thresholded),
  cancelBargeCandidate (unduck + buffered-sentence flush + queue
  preserved for drain), resolveReplyLang (no/nn→nb, cmn→zh, jw→jv,
  uk↔ru disambiguation, yue→zh voice fallback), drainStandbyUtterance
  self-re-arming, collectStreamText (raw-neighbour merge + parallel
  decode + ordered join + owned-parts clearing).

### Async/race sweep results

Every `Promise.{any,all,race}` site keeps handlers attached to losers
(no unhandled rejection possible): connectivity selfProbe,
packManager verify fans, sttEngine join, mwa RPC probe, memoryEngine
embedding race (loser self-aborts at its own 15s deadline), session
collectStreamText (each job pre-`.catch(() => null)`).

`preferLocal` routing verified consistent: pure-gate decodes (standby
utterance, barge prefix) stay on-device; completed utterances are
real-turn-eligible and may use cloud STT when configured — matching
the documented billing contract.

### Findings: 0

First zero-findings pass. Per-pass findings:
11 → 7 → 5 → 6 → 6 → 2 → 6 → 8 → 4 → 2 → 5 → 3 → 2 → **0**.

Device-only verification remains the open item (live keys, native
PCM, iOS, real-network censorship).
