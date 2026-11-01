# Uni Dashboard brand

The selected logo is **Next U**, the first mark in `minimalist-concepts/overview.svg`. Use a single white mark on the app's charcoal background (`#1d1f23`); in native screens, the vector may inherit the Material content colour.

The shared geometry lives in `tools/generate-app-icons.mjs`. Run `npm run icons:generate` from the repository root to regenerate the web SVGs, installation and Apple touch PNGs, and Android launcher, notification and in-app vectors. PNG files are deterministic raster exports of the vector geometry.

The transparent web mark is `apps/web/public/logo.svg`. The browser favicon is `icon.svg`; the installation manifest also includes dedicated maskable artwork with an opaque background. Android's adaptive icon and themed monochrome layer share `ic_launcher_foreground.xml`; in-app branding uses `ic_logo.xml`. Keep the launcher art within its circular safe zone.

Rebuild and deploy the website to publish changes. Android users need to install a new APK to receive updated launcher and in-app artwork.
