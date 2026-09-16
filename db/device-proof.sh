#!/usr/bin/env bash
#
# Proves that the database on a real Android device is CIPHERTEXT.
#
# Not that SQLCipher is configured, not that the code says `encrypted` — that
# the bytes on the phone's filesystem are not a readable SQLite file. That
# distinction is the whole of W12: packages/core/src/db/device-key.ts makes
# encryption a type, apps/app/src/db/capacitor-driver.ts satisfies it, and
# this script is the only thing in the repo that can tell you it is TRUE.
#
# HOW IT KNOWS. An unencrypted SQLite file starts with the sixteen ASCII
# bytes "SQLite format 3\0". SQLCipher replaces that header with a random
# per-database salt, so the file starts with something different on every
# install and with that magic on none. `head -c16` settles it.
#
# WHY NOT A UNIT TEST. Nothing running under Node can prove this: there is no
# SQLCipher in the Node test suite, and a test that fakes one would be
# testing the fake. apps/app/test/device-driver.test.mjs proves everything
# the TypeScript decides — including, deliberately, that this same check
# CATCHES a plaintext file — and then stops at the edge of the phone. This
# script is that edge crossed.
#
#   ./db/device-proof.sh                    # the only attached device
#   ./db/device-proof.sh -s emulator-5554   # a named one (adb -s)
#   KEEP=1 ./db/device-proof.sh             # leave the pulled copy behind
#
# What it needs: a debug build installed (`run-as` only works on a
# debuggable package), USB debugging authorised, and the app OPENED at least
# once so that a database exists.
#
set -euo pipefail

PACKAGE=pk.papavendor.app
DB_PATH=databases/papa.db
PLAINTEXT_MAGIC='SQLite format 3'
OUT="${OUT:-/tmp/papa-device-proof}"

SERIAL=()
if [[ "${1:-}" == "-s" ]]; then
  if [[ -z "${2:-}" ]]; then echo "device-proof: -s needs a device serial" >&2; exit 2; fi
  SERIAL=(-s "$2")
  shift 2
fi

adb_() { adb "${SERIAL[@]}" "$@"; }

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

command -v adb >/dev/null 2>&1 || fail "adb is not on PATH (Android SDK platform-tools)."

# ---------------------------------------------------------------------------
# The device

say "== device =="
if ! adb_ get-state >/dev/null 2>&1; then
  adb devices
  fail "no device. Plug a phone in with USB debugging on, or start an emulator."
fi
say "model:    $(adb_ shell getprop ro.product.model | tr -d '\r')"
say "android:  $(adb_ shell getprop ro.build.version.release | tr -d '\r') (API $(adb_ shell getprop ro.build.version.sdk | tr -d '\r'))"
say "abi:      $(adb_ shell getprop ro.product.cpu.abi | tr -d '\r')"

if ! adb_ shell pm path "$PACKAGE" >/dev/null 2>&1; then
  fail "$PACKAGE is not installed. Build it and install:
  npm run build:app && npx cap sync android
  (cd apps/app/android && JAVA_HOME=~/jdk21 ./gradlew assembleDebug)
  adb install -r apps/app/android/app/build/outputs/apk/debug/app-debug.apk"
fi

# ---------------------------------------------------------------------------
# Open the app so that a database exists, and give the Keystore a moment.
#
# A fresh install has no file until the first open: the key is minted, the
# database is created and the schema ladder runs on the first boot. The sleep
# is not a race being papered over — it is the app being given time to do
# that work before the file is read.

say ""
say "== opening the app =="
adb_ shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
sleep 8

# ---------------------------------------------------------------------------
# The file

say ""
say "== the database file =="
if ! adb_ shell run-as "$PACKAGE" ls "$DB_PATH" >/dev/null 2>&1; then
  say "(run-as could not see $DB_PATH; the app's own log may say why)"
  adb_ logcat -d -s PapaSql:* 2>/dev/null | tail -20 || true
  fail "no $DB_PATH inside $PACKAGE. Either the app has not opened it, or the
build is not debuggable (run-as needs a debug build), or the SQL bridge did
not reach the WebView — the This-phone screen would say so."
fi

say "size:     $(adb_ shell run-as "$PACKAGE" stat -c %s "$DB_PATH" | tr -d '\r') bytes"

mkdir -p "$OUT"
COPY="$OUT/papa.db"
adb_ exec-out run-as "$PACKAGE" cat "$DB_PATH" > "$COPY"
[[ -s "$COPY" ]] || fail "the pulled copy is empty."
say "pulled:   $COPY ($(wc -c < "$COPY" | tr -d ' ') bytes)"

FIRST16_HEX="$(head -c16 "$COPY" | od -An -tx1 | tr -d ' \n')"
FIRST16_TXT="$(head -c16 "$COPY" | tr -c '[:print:]' '.')"

say ""
say "== the verdict =="
say "first 16 bytes (hex):   $FIRST16_HEX"
say "first 16 bytes (ascii): $FIRST16_TXT"
if command -v file >/dev/null 2>&1; then
  say "file(1) says:           $(file -b "$COPY")"
fi

# The assertion. Three ways of asking the same question, because this is the
# line the whole wave exists to make true.
if head -c16 "$COPY" | LC_ALL=C grep -qa "$PLAINTEXT_MAGIC"; then
  say ""
  say "PLAINTEXT. The file begins \"$PLAINTEXT_MAGIC\"."
  say "The fleet, the purchase prices and the customer list are readable by"
  say "anyone who copies this file off the phone. Do not ship this build."
  exit 1
fi
if [[ "$FIRST16_HEX" == "53514c69746520666f726d6174203300" ]]; then
  fail "PLAINTEXT: the header is the SQLite magic byte for byte."
fi
if command -v sqlite3 >/dev/null 2>&1; then
  # A plaintext file would answer this; a SQLCipher file cannot be opened by
  # a stock sqlite3 at all, which is itself the proof.
  if sqlite3 "$COPY" '.tables' >/dev/null 2>&1; then
    fail "PLAINTEXT: stock sqlite3 opened it and listed its tables."
  fi
  say "sqlite3:                refuses to open it (as it must)"
fi

say ""
say "ENCRYPTED. The file does not begin \"$PLAINTEXT_MAGIC\", and stock SQLite"
say "cannot read it. The bytes above are SQLCipher's per-database salt, so"
say "they will differ on every install — that is what makes them not a magic."
say ""
say "What this does NOT prove: that the key is well kept. That is the Android"
say "Keystore's job (PapaSqlBridge.java), and the way to check it is to look"
say "at Settings > This phone on the device, which renders these same bytes."

if [[ -z "${KEEP:-}" ]]; then
  rm -f "$COPY"
  say ""
  say "(the pulled copy was deleted; KEEP=1 to keep it)"
fi
