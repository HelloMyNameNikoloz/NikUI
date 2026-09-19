# Getting NikUI onto a phone

Two routes, and the honest version of each. Nothing here is guesswork about
what a store will say — it is what the tooling actually requires, and what each
requirement costs.

    npm run version            # stamp app/package.json's version into both platforms
    npm run release:android    # a signed release APK
    npm run app                # build, sync, list native sources — do this first, always

## The short answer

|  | Android | iPhone |
| --- | --- | --- |
| Install it yourself | a signed APK, free, keeps working | Xcode, free, **expires after 7 days** |
| Keep it working | — | Apple Developer Program, **$99/year**, 1 year per build |
| Told while the app is closed | free — a foreground service | needs the $99 account (APNs) |

Android needs nothing from anybody. An iPhone needs an Apple Developer account
for anything beyond a week, and needs it again for notifications while the app
is closed. That is Apple's rule, not this project's.

## Android

### Once: make a key

The key signs every build. **Lose it and you cannot update the app** — Android
refuses an update signed by a different key, and the only way back is to
uninstall, which takes the pairing and the device key with it. Put it somewhere
you keep things you cannot replace.

```sh
keytool -genkeypair -v \
  -keystore ~/keys/nikui.jks -alias nikui \
  -keyalg RSA -keysize 4096 -validity 10000
```

Then, in `app/android/keystore.properties` — which is git-ignored, and stays
that way:

```properties
storeFile=/Users/you/keys/nikui.jks
storePassword=…
keyAlias=nikui
keyPassword=…
```

### Every time

```sh
npm run release:android
# app/android/app/build/outputs/apk/release/app-release.apk
```

Copy it to the phone and open it. Android will ask once whether this source may
install apps.

Without `keystore.properties` the build still runs and produces
`app-release-unsigned.apk`, which nothing will install. That is deliberate: a
build that quietly signed itself with a debug key would be a build you could not
update later.

### What the release build does that the debug one does not

- **Shrinks and obfuscates** (R8). `proguard-rules.pro` keeps the methods
  Capacitor looks up by name — without them every plugin is missing, *in release
  builds only*, which is the worst possible time to find out. `app/tools/build.test.js`
  checks the rules are still there.
- **Refuses cleartext** except to `localhost`, `127.0.0.1` and `10.0.2.2` (the
  emulator's name for the computer running it). Nothing on the internet is in
  that list.
- **Is not backed up.** The device key lives in the Keystore and cannot leave the
  phone, so a backup restored onto another device would carry a pairing that
  device cannot use. Pair again instead.

## iPhone

### One thing that is not obvious

**An unsigned iOS build has no keychain access at all**, and the failure is
nowhere near the cause: WebKit cannot store a `CryptoKey` in IndexedDB without
it, so the app reports *"could not make a key: the object can not be cloned"*
and the only clue is one line in the device log —
`Could not find WebCrypto master key in Keychain, error -34018`
(`errSecMissingEntitlement`).

So build with signing on, even for the simulator:

```sh
xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 15 Pro'   CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES build
```

`CODE_SIGNING_ALLOWED=NO` builds, installs and launches, and then fails at the
first thing that matters.

### Free, for seven days

Open `app/ios/App/App.xcodeproj`, sign in with any Apple ID under
*Signing & Capabilities*, pick your phone, press Run. It works, completely,
until the free provisioning profile expires a week later — then it stops opening
until you build it again.

Notifications while the app is **open** work. While it is **closed** they do
not: that needs APNs, which needs a paid account.

### Paid, for a year at a time

With an Apple Developer Program membership ($99/year):

1. Add the **Push Notifications** capability in *Signing & Capabilities*.
2. In the developer portal, create an **APNs auth key** and download the `.p8`.
   You get it once; Apple will not show it again.
3. Note the **Key ID** (on the key) and your **Team ID** (top right of the portal).
4. In VS Code settings:

   | Setting | Value |
   | --- | --- |
   | `nikui.apns.teamId` | your team ID |
   | `nikui.apns.keyId` | the key ID |
   | `nikui.apns.keyFile` | where you put the `.p8` |
   | `nikui.apns.production` | **off** for a build run straight from Xcode |

   The key itself is never copied into settings — only where to find it.
5. In the app: *Settings → Notifications → While NikUI is closed → Set up*.

`production` is the one that catches people. A build installed from Xcode gets a
**sandbox** token; a build from TestFlight or the App Store gets a production
one. Sending to the wrong network is refused as `BadDeviceToken`, which says
nothing about which way round it is.

### The App Store

Not required and probably not wanted — this app talks to one laptop, which is
yours. If you submit it anyway:

- `PrivacyInfo.xcprivacy` is already there and already correct: tracks nobody,
  collects nothing, declares the one required-reason API in use (UserDefaults,
  reason `CA92.1`).
- The privacy questionnaire's honest answers are **no data collected** and **no
  tracking**, which matches the manifest.
- Review will ask what the app is for. It is a client for software running on
  the reviewer's own machine, which they cannot set up — expect to explain that,
  and to supply a demo video rather than credentials.

## Versions

`app/package.json` is the version. `npm run sync` stamps it into
`android/app/build.gradle` and both Xcode configurations, and the build number is
derived — `major × 10000 + minor × 100 + patch` — so it always goes up and can
always be read backwards to a version. Nothing is counted by hand.

Bump it before a release you intend to install over an older one; Android
refuses an APK whose `versionCode` is not higher than what is installed.

## What is checked, and what is not

`cd app && npm test` checks the parts of all of this that are files: the
versions agree, minification is on, the keep rules are present, cleartext is
off, the privacy manifest is in the bundle rather than beside it, both platforms
claim the pairing scheme, and Xcode is told to compile every native source.

What no test here can check is a phone. None of the native code has run on one.
