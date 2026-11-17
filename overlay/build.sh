#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
APP_NAME="ComputerUsePip"
BUILD_DIR="../dist"
APP="$BUILD_DIR/$APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ComputerUsePip</string>
  <key>CFBundleDisplayName</key><string>Computer Use PiP</string>
  <key>CFBundleIdentifier</key><string>com.coke.dsh.computer-use-pip</string>
  <key>CFBundleExecutable</key><string>ComputerUsePip</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
swiftc -O -swift-version 5 main.swift -o "$APP/Contents/MacOS/$APP_NAME" -framework AppKit
codesign --force --sign - "$APP/Contents/MacOS/$APP_NAME" >/dev/null 2>&1 || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "built: $(cd "$APP" && pwd)"
