# Development

Use Node.js 24+ and npm. The local relay uses Node's built-in SQLite support; production uses the Cloudflare Worker and D1 bindings in `wrangler.toml`.

## Local web and API

```sh
npm ci
npm --prefix apps/web ci
npm run dash
```

Open http://127.0.0.1:8787/. Settings → Connections has the feed setup guide. Alternatively, copy [`.env.example`](../.env.example) to `.env` and fill in the settings you need.

Automatic local polling is off by default. Set `RELAY_POLL_ENABLED=1` only if this relay is your sole poller. For live web development, run these in separate terminals:

```sh
npm run serve       # API on 8787
npm run web:dev     # Vite on 5173, with API proxying
```

Useful commands:

```sh
npm run sources     # Source readiness, without private URLs
npm run poll        # Fetch configured sources once
npm run health      # Latest source outcomes
npm run mcp         # Local stdio MCP bridge
npm run worker:dev  # Build and preview the Worker locally; Access disabled
```

The Node relay binds to loopback by default. A non-loopback bind requires `RELAY_TOKEN`; enter it at runtime in web Settings. Never embed tokens in the web build. Production feed URLs belong in authenticated settings or Worker secrets; Worker development secrets belong in ignored `.dev.vars`. See [deployment](DEPLOYMENT.md) and [MCP](MCP.md) for authentication and agent clients.

## Android builds

Use JDK 21 and Android SDK 37. Open `apps/android` in Android Studio, or run:

```sh
cd apps/android
./gradlew --max-workers=1 :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The repository currently includes only the Unix wrapper script. On Windows, use Android Studio or run the wrapper JAR from PowerShell with JDK 21 on your path:

```powershell
Set-Location apps/android
java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain --max-workers=1 :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The debug APK is written to `apps/android/app/build/outputs/apk/debug/app-debug.apk`. The single-worker option avoids a known parallel lint crash in the pinned tooling. Enter your deployed HTTPS dashboard address and select Sign in; follow [Android OAuth](ANDROID-OAUTH.md) for Cloudflare Access setup. Notification permission is optional and managed in Settings → Notifications. See [notifications](ANDROID-NOTIFICATIONS.md) for device checks.

Release builds currently use the debug signing key. Configure a real signing key before distributing the app. Installing a new APK is required to receive native changes.

## Checks

```sh
npm test
npm run web:build
npm run worker:check
```

These cover backend/shared-contract regressions, web type checking and production bundling, and a Worker deployment dry run. Tests use synthetic/captured fixtures and local databases. Android unit tests and lint run with the build commands above. Device behavior and live Cloudflare resource usage are separate checks; see [release readiness](V1-READINESS.md).

## README images

The desktop and phone banners are editable SVGs using the [existing brand mark](brand/README.md). Screenshots render the real production web build against synthetic data held in memory. The capture tool never opens `relay.db`, polls sources, calls AI, or deploys anything.

```sh
npm run web:build
npm --prefix apps/web exec -- playwright install chromium
node tools/capture-readme.mjs
```

To use an installed Chromium browser instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable path. Images are written to `docs/images`, with phone variants for the overview and calendar. The README uses `<picture>` to select a readable image at narrow widths. Inspect the README at desktop and phone widths in light and dark themes, including its expanded screenshot gallery. Keep sample data synthetic and label it in the README.
