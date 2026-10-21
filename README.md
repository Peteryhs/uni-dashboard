# Uni Dashboard

A personal dashboard for University of Waterloo student life. The web and native Android apps bring together your timetable, deadlines, course materials, posted dining menus, weather, and campus service notices. The web dashboard also shows live study-space occupancy.

The first screen answers what needs your attention next. Recommendations use saved source data and clear timing rules; optional AI helps with dining choices and text imports. Missing times and assessment coverage stay unknown rather than being invented.

**v1 preparation:** both clients and the Node/Cloudflare backends are implemented. Package versions are still `0.1.0`; this README does not announce a released `1.0`. See [v1 readiness](docs/V1-READINESS.md) for the latest audit and checks still needed before a release.

## Features

- Ranked daily recommendations with completion, dismissal, snooze, and source evidence shared across devices.
- A unified calendar for classes, exams, LEARN deadlines, reviewed syllabus dates, and office hours. A moving Now line and muted past entries make today's schedule easier to scan.
- Compact warning icons beside recommendation timing, with explanations on hover, focus, or touch.
- Posted menus grouped by outlet and station, dietary indicators, saved preferences, and optional personalized dining rankings.
- Live study-space occupancy from Waitz, with the open floor that has the most room, per-library open states, and floor counts.
- Course links, reviewed syllabus imports, office-hours configuration, and section/group filters.
- Source status that distinguishes configured connections, successful updates, failed attempts, and old data.
- Native Android with dynamic Material color, expressive spring motion, a ranked Focus hierarchy, quiet background updates, pull-to-refresh, cached data, and finite activity/reminder notifications that clean up as their evidence expires.

## Data sources

| Source | Provides | Setup |
|---|---|---|
| UW Portal ICS | Classes and exams | Private subscription URL |
| Google Calendar ICS | Optional schedule feed | Private subscription URL |
| Waterloo LEARN ICS | Deadlines and dated course work | Private subscription URL |
| Waterloo Food Services | Posted dishes, outlets, stations, dietary tags | Public feed |
| Waitz | Live library and study-space occupancy | Public feed |
| UW service status | Campus and IT incidents | Public feed |
| Open-Meteo | Cached weather for Waterloo | Public API |
| Office hours and syllabi | Your saved, reviewed course information | Configure in Settings |

Schedule and deadline feeds are empty or marked unconfigured until you add real URLs. Normal startup does not substitute test fixtures. A posted menu does not prove an outlet is currently open; dietary labels describe the source's information.

## Run locally

Use **Node.js 24 or newer** and npm; the current checks use Node `24.5.0`. The local store uses Node's built-in SQLite support. Install backend and web dependencies separately:

```sh
npm ci
npm --prefix apps/web ci
npm run dash
```

Open **http://127.0.0.1:8787/**. This builds the web app and serves it alongside `/v1` from one origin. Settings → Connections has the setup guide and feed configuration. Alternatively, copy [.env.example](.env.example) to `.env` and fill in only the settings you need.

Automatic local source polling is **off by default** to avoid fetching private feeds from both a laptop and a deployed Worker. If this local relay is your only poller, set `RELAY_POLL_ENABLED=1` before starting it. A manual fetch is also available:

```sh
npm run sources                      # Report source readiness; do not print private URLs
npm run poll                         # Fetch configured sources once
npm run health                       # Show latest source outcomes
```

For web development, run these in separate terminals:

```sh
npm run serve                        # Relay on port 8787
npm run web:dev                      # Web on port 5173, with the API proxied to the relay
```

The relay binds to loopback by default. A non-loopback bind requires `RELAY_TOKEN`; enter that token at runtime in web Settings. Tokens must never be embedded in the web build. See [deployment](docs/DEPLOYMENT.md) for hosting and authentication details.

## Host on Cloudflare

One Worker serves the web assets and API, uses D1 for saved data, and polls due sources on a minute cron. Ordinary dashboard, calendar, and recommendation reads do not poll sources or run AI.

Before deploying your own copy:

1. Create your own D1 database and replace the database ID in [wrangler.toml](wrangler.toml). The committed configuration identifies this project's existing deployment.
2. Configure Cloudflare Access for your dashboard and set your own `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Allow only people you trust with the entire instance, including its connection settings.
3. Set private feed URLs through authenticated Settings → Connections or as Worker secrets. Keep local development values in ignored `.dev.vars`, not committed configuration.
4. Enable Access Managed OAuth if you want Android browser sign-in. Follow [the Android sign-in guide](docs/ANDROID-OAUTH.md).

With dependencies installed:

```sh
npm run web:build
npm run worker:check                 # Bundle and inspect; does not deploy
npm run worker:dev                   # Local Worker, with Access disabled for development
npm run deploy                       # Build and deploy to your configured account
```

The database schema initializes on first use. Cloudflare authentication and account configuration are required for a real deployment. The production API fails closed if its Access configuration is missing. The Worker AI binding supplies optional inference; a local Node relay can instead use backend-only Cloudflare account/API credentials. Gemini and OpenAI keys are not used by this implementation.

See [deployment](docs/DEPLOYMENT.md) for complete instructions and [Cloudflare usage](docs/CLOUDFLARE-USAGE.md) for the measured local scenario, read budgets, AI reservations, and production monitoring needs. The app reserves at most an estimated **7,000 AI neurons per UTC day**. Account-wide usage and Worker CPU still need live monitoring; extra clients, large feeds, or other deployments consume the same account allowances.

## Android

The native app is in [apps/android](apps/android). It supports **Android 10 / API 29 and newer**. The current build uses **JDK 21** and **Android SDK 37**, with Gradle and library versions pinned in the project.

Open `apps/android` in Android Studio, or use its Gradle wrapper:

```sh
cd apps/android
./gradlew --max-workers=1 :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

On Windows, the repository currently includes only the Unix wrapper. Use Android Studio or invoke its wrapper JAR from PowerShell with JDK 21 on your path:

```powershell
Set-Location apps/android
java -classpath gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain --max-workers=1 :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The single-worker check completed unrestricted lint after parallel analysis crashed in the pinned tooling; no lint rule suppression is needed for that verified run. The debug APK is written to `apps/android/app/build/outputs/apk/debug/app-debug.apk`. Enter your deployed HTTPS dashboard address and select **Sign in**; the system browser handles Cloudflare Access. Reminder permission is optional and enabled from Settings → Notifications. Android 16+ can promote the imminent/active activity tracker when system eligibility and permissions permit; earlier versions use an ordinary notification.

The native UI uses flexible Material headers, fade-through navigation, spring-driven disclosures, and connected task and settings groups. Focus keeps its primary Done action visible; Calendar has date tiles, a separate time column and adaptive segmented filters. Dining opens the recommended outlet's posted dishes first and lets other menus expand in place. Warning explanations stay behind icons beside timing, and ranking progress appears within Dining. These presentation changes do not add refreshes or AI jobs. Install a newly built APK to receive Android changes; deploying the web app does not update an installed native app.

Current release builds use the debug signing key. Configure a real signing key before distributing v1. See [Android notifications](docs/ANDROID-NOTIFICATIONS.md) for lifecycle behavior and device checks.

## Verification

```sh
npm test                             # Backend, shared contract, web helpers, local D1 regressions
npm run web:build                    # Type-check and production web build
npm run worker:check                 # Worker dry run; build web assets first
```

Tests use synthetic/captured fixtures and local databases. The local D1 row-budget regression includes a week of minute-by-minute source receipts, so an expensive receipt scan cannot hide behind a low query count. Native unit tests cover sessions, refresh reuse, calendar progress, and notification planning. Device behavior and live Cloudflare resource usage are separate release checks, documented in [v1 readiness](docs/V1-READINESS.md).

## Privacy and current limits

One deployment is **one student's shared data space**, not separate profiles for every Access login. Any allowed Access identity can read and modify that instance. Host a separate Worker/database for another student.

Private feed URLs and API tokens stay on the backend. Cached schedule data and preferences stay on the client for offline use; use a trusted browser profile and clear its site data when handing a device to someone else. Android credentials use Keystore-backed encryption. Keep `.env`, `.dev.vars`, database files, and private calendar links out of Git.

The web app can display saved data when requests fail after its shell has loaded. It does not yet have a service worker for a cold offline launch. Syllabus imports require readable/extracted text; scanned PDFs need OCR first. Source refreshes remain subject to upstream posting schedules and rate limits. Notifications depend on Android permissions, channels, and alarm timing.

## Project layout and guides

| Path | Purpose |
|---|---|
| `apps/relay` | Node server, Worker entry point, stores, polling, ranking, AI jobs |
| `apps/web` | React/Vite web client |
| `apps/android` | Kotlin/Compose native client |
| `packages/contract` | Shared schemas, freshness and presentation rules |
| `sources` | ICS, menus, status, and office-hours adapters |
| `test`, `fixtures`, `tools` | Regression tests, source fixtures, development tools |

- [Design contract](DESIGN.md)
- [Unified calendar API](docs/UNIFIED-CALENDAR.md)
- [Daily recommendations and reviewed syllabi](docs/DAILY-GUIDANCE.md)
- [Schedule changes](docs/SCHEDULE-CHANGES.md)
- [Study spaces](docs/STUDY-SPACES.md)
- [Service status](docs/SERVICE-STATUS.md)
- [Deployment and Android sign-in](docs/DEPLOYMENT.md)
- [Cloudflare usage audit](docs/CLOUDFLARE-USAGE.md)
- [v1 readiness and latest review](docs/V1-READINESS.md)

Package metadata specifies ISC. A standalone licence file remains part of release preparation.
