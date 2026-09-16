# The Android build — the bridge, the key, the printer, the proof

Everything about running Papa Vendor on a real phone. Written in W12, the
wave that put the app on a device with real data at rest.

The contract this implements is
[`packages/core/src/db/device-key.ts`](../packages/core/src/db/device-key.ts),
which has stated since W9 — as a **type**, not a note — that a device
database is SQLCipher-encrypted or it does not open. Read that file first.
It explains why the *ordering* was the risk: the short path is "get sync
working, come back for encryption", and the moment anybody takes it there is
a shipped build with the whole fleet, every purchase price and the customer
list in plaintext on a Redmi in a tech's pocket, plus a retrofit that has to
export and re-import the outbox — data that exists nowhere else — offline,
on phones that may not check in for days.

---

## 1. Why the SQL bridge is synchronous

**`SqlDriver` is synchronous, and that is the load-bearing decision of the
whole offline engine.** `exec`, `all`, `get` and `transaction` return values,
not promises, because the scan handler may not `await` anything
(CONTRIBUTING.md, principle 1: "There is no `await` in the scan handler.
Ever."). Every read model, every projection and every test in the repo is
written against that shape. Making the core async is a rewrite of everything
and would let a network-shaped `await` back into the scan path *by
construction*.

**Capacitor plugin calls are asynchronous.** They cross the bridge as JSON
messages and resolve on a later task. There is no way to await one inside a
synchronous function. So a Capacitor plugin cannot implement `SqlDriver`.

**`@JavascriptInterface` is the exception.** A method on an object handed to
`WebView.addJavascriptInterface` is called **synchronously** from JavaScript
and returns a `String`. That is exactly the shape `SqlDriver` needs. Hence:

```
window.PapaSql.open(keyB64)          -> "" | error message
window.PapaSql.exec(sql, paramsJson) -> "" | error message      (ONE statement)
window.PapaSql.all(sql, paramsJson)  -> JSON row array | {"error":"…"}
window.PapaSql.begin()               -> "" | error message
window.PapaSql.commit()              -> "" | error message
window.PapaSql.rollback()            -> "" | error message
window.PapaSql.key()                 -> {"key":"<base64>"} | {"error":"…"}
window.PapaSql.wipe()                -> "" | error message
window.PapaSql.header()              -> lowercase hex of the file's first 16 bytes, or ""
```

Two return conventions, and both are deliberate:

- `open/exec/begin/commit/rollback/wipe` answer `""` for success. An empty
  string can never be a real error message, so there is nothing ambiguous to
  resolve.
- `all/key` answer JSON, and an **object where an array belongs** is the
  failure signal. A driver that forgot to check would get a type error rather
  than quietly seeing zero rows — and "this asset has no history" is exactly
  the kind of silent wrong answer this codebase treats as the worst class of
  bug.

`header()` is the one method that is not strictly necessary, and it earns its
place: it is what lets the phone show its own proof (§5).

### The Java is marshalling and nothing else

[`PapaSqlBridge.java`](../apps/app/android/app/src/main/java/pk/papavendor/app/PapaSqlBridge.java)
converts JSON to bind arguments and a `Cursor` to JSON. It does no statement
splitting, no transaction nesting, no retry policy and knows nothing about
the schema. All of that is in
[`apps/app/src/db/capacitor-driver.ts`](../apps/app/src/db/capacitor-driver.ts),
because **that** can be tested under Node against a fake bridge
(`apps/app/test/device-driver.test.mjs`, 47 tests). Java on this machine can
only be verified by reading, and reading is not a test.

Four decisions inside the driver worth knowing:

- **Scripts are split in TypeScript.** Android's `execSQL` runs one
  statement; `migrateLocal` hands the driver whole scripts. The splitter
  handles `--` comments (the local schema is full of them), `/* */` blocks
  and `'…'` literals with `''` escapes. The fake bridge in the test suite
  **refuses** a multi-statement script exactly as Android does, so if the
  splitting ever stops happening the suite fails instead of a phone failing
  on first boot.
- **Nested `transaction()` joins the outer one** — a depth counter, the same
  shape as `NodeSqliteDriver` and `SqlJsDriver`. Savepoints were considered
  and rejected: they would let an inner failure roll back only the inner
  work, which sounds better, but it would make the shipped driver behave
  differently from the two drivers every test in the repo runs against. A
  behavioural difference between the tested and the shipped database layer is
  precisely how offline bugs become inventory that does not match reality.
  If savepoints are wanted later they belong in all three drivers, in one
  commit, with the outbox tests re-run.
- **Transactions use `beginTransaction()`, not a raw `BEGIN`.**
  `SQLiteDatabase` keeps a connection pool and per-thread session state; a
  raw `BEGIN` through `execSQL` leaves the session unaware it is in a
  transaction, and whether the following statements land on the same
  connection then depends on pool internals. `beginTransaction()` holds the
  connection for the thread — which is what the outbox needs, because the
  optimistic row and its queue row must commit together or not at all.
  The bridge also **checks** that a transaction does not span threads rather
  than assuming WebView's single Java-bridge thread.
- **The corruption handler KEEPS the file.** SQLCipher's default
  `DatabaseErrorHandler` *deletes* a database it finds corrupt. On this app
  that would destroy the outbox, the un-uploaded photos and the voice notes —
  the only copy of that evidence anywhere. Better a phone that refuses to
  open and keeps its file for recovery than one that opens clean and empty.

### There is no fallback on a phone

The bridge is injected in `MainActivity.onCreate` **after**
`super.onCreate`, because the WebView does not exist until the bridge is
built. `addJavascriptInterface` on an object injected after a page has begun
loading would not appear in that page's JavaScript.

So `apps/app/src/db/boot.ts` **refuses to start** when
`Capacitor.isNativePlatform()` is true and `window.PapaSql` is absent, rather
than falling back to the in-memory browser database. That fallback would give
a phone that scans all day and forgets everything the moment Android kills
it — a whole day of evidence lost quietly, which docs/principles.md #3
forbids outright. A **partially** present bridge (a new web bundle on an old
app shell) is treated the same way.

---

## 2. Where the key lives

32 bytes from `SecureRandom`, generated **once** on first use, stored in
**EncryptedSharedPreferences** whose master key lives in the **Android
Keystore** — non-exportable, hardware-backed where the phone has the
hardware — with `setUserAuthenticationRequired(false)`.

That last flag is not laziness. `device-key.ts` is explicit: **the PIN gates
the SESSION, the Keystore holds the KEY.** A four-to-six digit PIN as the
database passphrase would be brute-forceable offline in seconds once the file
is copied off the phone, which would make the encryption theatre. And a
warehouse phone has to be able to open its database and keep syncing with
nobody looking at it.

An **empty key is refused twice**, in TypeScript and again in Java. This is
the most dangerous single value in the wave: SQLCipher opens an empty-keyed
database in **plaintext** and reports success, so everything downstream works
perfectly while the data sits unprotected. Java additionally refuses a key
that is not the one the Keystore holds.

### The key does cross into JavaScript, and that is worth saying plainly

`DeviceKeyProvider.getKey()` returns the passphrase, because `SqlDriver` is
synchronous and the passphrase is what SQLCipher's `PRAGMA key` takes. For
the life of the app process the key is therefore reachable from the WebView's
heap.

What that costs: an attacker who can already run code inside this app's
WebView can read the key. What it does **not** cost: anything to an attacker
with the phone, or the file, or a backup — which is the threat
`device-key.ts` names. The alternative (returning an opaque handle and
keeping the real key in Java) would mean the contract's empty-key guard
guarded nothing, and that guard is protecting against the failure mode that
is actually likely: a future contributor taking the short path.

### The passphrase goes through SQLCipher's KDF

The key is handed over as a base64 **passphrase**, so SQLCipher derives the
file key with PBKDF2-HMAC-SHA512 at its default iteration count. That costs
a few hundred milliseconds **once**, at open, on a cheap phone. The
raw-key form (`x'…'`) would skip the KDF, but `sqlite3_key` — which the
Android binding calls — treats its bytes as a passphrase rather than
interpreting that syntax, so using it would have meant guessing at library
internals. If boot time on the pilot phones turns out to matter, the lever is
`PRAGMA kdf_iter` through a `SQLiteDatabaseHook`, in its own commit, measured.

### The wipe

`CapacitorKeyProvider.wipe()` deletes the key **first** and then the file —
`device-key.ts`'s reasoning is that deleting a file on Android guarantees
nothing, while a ciphertext whose key is gone is genuinely unrecoverable.

It **refuses** unless `force` is passed while anything exists only on this
phone: rows in the outbox, un-uploaded condition photos, un-uploaded voice
notes. If the database is not open, so the count cannot be taken, it also
refuses — "cannot count" is not "nothing to lose". Nothing in the app calls
`wipe()` automatically and nothing should: the comment in `device-key.ts` is
load-bearing, and a wipe must never be an automatic response to something
transient like "the session looks stale".

### The session token is now at rest

On the device the session token is a row in `sync_meta` **inside the
encrypted database**, so it survives a restart. The browser build still keeps
it in memory and loses it on reload. Settings → This phone says which of the
two it is looking at, and the old browser-only wording was replaced rather
than left to be wrong on a phone. One line in
[`docs/the-pipe.md`](the-pipe.md) says the same.

---

## 3. The printer

[`PapaPrintPlugin.java`](../apps/app/android/app/src/main/java/pk/papavendor/app/PapaPrintPlugin.java)
is an **ordinary asynchronous Capacitor plugin** — the opposite call from the
database, for the opposite reason: printing is nowhere near the scan path.
The bytes are already built (`packages/core/src/escpos.ts`, golden-tested),
the desk is standing at a till, and an `await` is exactly right because a
Bluetooth connect genuinely takes seconds.

```
PapaPrint.list()                     -> { devices: [{ name, mac }] }   paired devices
PapaPrint.print({ mac, bytes })      -> { ok, bytes }                  base64 in
```

Bluetooth **classic SPP**, UUID `00001101-0000-1000-8000-00805F9B34FB`.
Three details that are about the hardware, not the code:

- **Ten-second watchdog.** `BluetoothSocket.connect()` has its own ~12s
  timeout and no way to set one. Closing the socket from another thread makes
  the blocked call throw, which is the only way to hold it to ten — and ten
  matters because the person is standing at the till deciding whether to
  write the parchi out by hand.
- **512-byte chunks with a 20ms pause.** A Rs 3,000 receipt printer has a few
  kilobytes of buffer and no flow control worth the name; a parchi with a QR
  is several kilobytes, and handing it over in one write is how these
  printers produce half a receipt and stop.
- **One queue.** A single-thread executor, because two parchis at once would
  interleave bytes on the paper.

Failures come back as short machine words (`no_printer`,
`no_printer_chosen`, `bluetooth_off`, `permission_denied`, `no_bluetooth`) and
`apps/app/src/print/print-said.ts` is the one home that turns them into
sentences. A word it does not recognise is shown **verbatim** rather than
flattened to "printing failed": the unrecognised reasons are the ones a cheap
printer invents, and a strange sentence beats no information.

### Permissions, and when they are asked for

| Permission | Android | Asked |
|---|---|---|
| `BLUETOOTH_CONNECT` | 12+ (API 31) | at first use of the Printer row or a print |
| `BLUETOOTH_SCAN` (`neverForLocation`) | 12+ (API 31) | same ask |
| `BLUETOOTH`, `BLUETOOTH_ADMIN` | ≤ 11 (`maxSdkVersion="30"`) | install time, nothing to ask |

**Never at launch.** A phone that demands Bluetooth on first open, before
anybody has printed anything, is a phone people deny and then cannot un-deny
without finding Settings.

The API-31 version gate in `needsAsking()` is load-bearing rather than tidy:
`BLUETOOTH_CONNECT` does not exist below Android 12, and asking for it there
returns DENIED for a permission that is not real — which would make printing
impossible on precisely the cheap phones this product is for.

`neverForLocation` on `BLUETOOTH_SCAN` is a promise the app keeps: it talks
to a paired till printer and derives nothing about where anybody is, so the
location permission the flag would otherwise drag in is declined by
declaration.

### Settings → Printer

Pick from the **paired** devices (paired once in Android's own Bluetooth
settings, by someone who can read the PIN off the sticker — a discovery scan
inside this app would be a second, worse pairing flow), remember the choice
in `app_settings` beside the payment line, and **print a test line**.

The test line is built by `buildParchiEscPos` — the one home for the ESC/POS
stream — so a passing test exercises the same code path a real parchi takes:
the init sequence, the letterhead, the 32-column wrap, the cut. It carries
**no QR** on purpose: a printer that ignores `GS ( k` would fail the test
while printing text perfectly, which is the wrong answer to "does my printer
work". ASSUMPTION `#thermal-58mm` has been waiting for exactly this button.

In a browser the row says there is no printer, rather than showing an empty
picker that reads like a broken one.

---

## 4. Building the APK

```bash
# from the repo root
npm run build:app
cd apps/app && npx cap sync android && cd ../..

cd apps/app/android
JAVA_HOME=~/jdk21 ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug
#   ~/jdk17 also works; AGP 8.13 needs 17+
# -> app/build/outputs/apk/debug/app-debug.apk
```

Install it:

```bash
adb install -r apps/app/android/app/build/outputs/apk/debug/app-debug.apk
```

### Versions, and one that is pinned for a reason

| Dependency | Version | Note |
|---|---|---|
| `net.zetetic:sqlcipher-android` | **4.17.0** | see below |
| `androidx.security:security-crypto` | 1.1.0 | EncryptedSharedPreferences |
| `androidx.sqlite:sqlite` | 2.6.2 | see below |
| compileSdk / targetSdk / minSdk | 36 / 36 / 24 | unchanged |
| Android Gradle plugin | 8.13.0 | unchanged |

**SQLCipher is held at 4.17.0, not the 4.19.0 head.** From 4.18.0 the AAR
declares `minCompileSdk=37`, and AGP 8.13 tops out at compileSdk 36. Bumping
the Android Gradle plugin and installing an android-37 platform is a
toolchain change deserving its own commit, not something to smuggle into the
wave that encrypts the database. 4.17.0 carries the same API and the same
four ABIs (`arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`), so one APK runs on a
Redmi and on an emulator.

**`androidx.sqlite:sqlite` is declared explicitly** even though
`sqlcipher-android` already depends on it, because it declares it at
`runtime` scope while its `SQLiteDatabase` *implements* androidx's
`SupportSQLiteDatabase` — so calling anything the interface declares
(`close()`, for one) needs the interface at compile time. Pinned to the
version SQLCipher itself resolves, so the two cannot drift.

The native library is loaded with `System.loadLibrary("sqlcipher")`; this
artifact has no `loadLibs(context)` helper.

---

## 5. Proving the database is encrypted

Three layers, and it matters which one proves what.

### (a) The Node suite — `apps/app/test/device-driver.test.mjs` (47 tests)

Runs in `npm test`. Proves everything the TypeScript decides: the JSON
marshalling in both directions, that a null column comes back **present and
null** (Java's `JSONObject` drops a key whose value is a Java null, which
would make the column read as `undefined`), that a numeric parameter binds as
a number rather than as text, nested transactions (including that a throw
after `Outbox.enqueue` rolls **both** back — no orphan queue row), error
propagation, script splitting, and the refusals: a `plaintext` factory, an
`ephemeral` factory, an empty key, a mismatched key, a partial bridge.

It **cannot** prove that SQLCipher encrypts. Nothing under Node can. The
fake factory *claims* `encrypted` so `openDeviceDatabase` can be exercised at
all, and that claim is a fiction local to that file, stated at the top of it.

One test in there is the one that keeps the rest honest: the fake bridge's
database is a real **file**, and because the fake is not encrypted its first
sixteen bytes **are** the plaintext magic. The test asserts that the detector
spots it. So the check below is one that can fail, rather than one that would
have said "encrypted" about a plaintext file all along.

### (b) The device — `db/device-proof.sh`

```bash
./db/device-proof.sh                   # the only attached device
./db/device-proof.sh -s emulator-5554  # a named one
KEEP=1 ./db/device-proof.sh            # leave the pulled copy behind
```

It reports the phone's model, Android version and ABI; opens the app (a
fresh install has no file until the first boot mints the key, creates the
database and runs the schema ladder); pulls the file with

```bash
adb exec-out run-as pk.papavendor.app cat databases/papa.db
```

and then asks the same question three ways: does `head -c16` contain
`SQLite format 3`, is the header that magic byte for byte, and can a stock
`sqlite3` open it and list its tables. Any yes is a **FAIL** with an
explanation of what it means. It needs a **debug** build (`run-as` only works
on a debuggable package) and USB debugging authorised.

An unencrypted SQLite file starts with the sixteen ASCII bytes
`SQLite format 3\0` = `53514c69746520666f726d6174203300`. SQLCipher replaces
that with a random per-database **salt**, so the file starts with something
different on every install and with that magic on none.

### (c) The phone itself — Settings → This phone

The same first bytes, rendered on screen under "This phone's book", beside a
plain sentence about what the book is at rest. No cable, no adb. If the bytes
ever *did* read as plaintext the line becomes a warning rather than
reassuring hex — a guard is only worth having if it can fail out loud.

### What the emulator could not do here

**It could not boot.** `~/Android/Sdk/emulator` crashes with `SIGSEGV` on this
host (Fedora 44, Mesa 26.1.6, kernel 7.1.4), consistently, 20–120 seconds
into guest boot, in `qemu-system-x86_64-headless`, with a core dump whose
only frame is a bare address. `adb` sees the device come up and then lose it.
Five configurations were tried on the existing `papatest` AVD (android-29,
google_apis, x86_64):

| Attempt | Result |
|---|---|
| `-gpu swiftshader_indirect`, KVM | SIGSEGV |
| `-gpu off`, KVM | SIGSEGV |
| `-gpu guest`, `-feature -Vulkan,-GLDirectMem,-GLAsyncSwap`, KVM | SIGSEGV |
| `-gpu off`, `VK_LOADER_LAYERS_DISABLE=*`, system libs, KVM | SIGSEGV |
| `-gpu off`, `-accel off` (no KVM at all) | SIGSEGV |

So the APK has been **built** and its contents verified (`libsqlcipher.so`
present for all four ABIs), but it has not been **run**. Nothing in §5(b) or
§5(c) has been executed against a live Android. That is the honest state, and
`db/device-proof.sh` is in the repo waiting for the owner's real phone.

---

## 6. What a real phone still needs

In the order it should happen, at a desk with a cable:

1. `adb install -r …/app-debug.apk`, open the app once, then
   `./db/device-proof.sh`. Paste its "the verdict" block into the vault —
   that is the first time anyone will have seen the bytes.
2. Open **Settings → This phone** and check that "This phone's book" shows
   the same bytes. Two independent readings of one file.
3. Kill the app from Android's recents and reopen it. The demo house should
   still be there — the browser build loses everything on reload and the
   device build must not. This is the first time the database has outlived a
   process anywhere in this project.
4. Pair the till printer in Android's Bluetooth settings, then
   **Settings → Printer** → pick it → **Print a test line**. Read the paper:
   is it 32 columns, is the letterhead readable, does the cut land clear?
   That answers ASSUMPTION `#thermal-58mm`'s paper half. Then print a real
   parchi from a handover and read the QR back with another phone — that
   answers the `GS ( k` half.
5. Enrol against a live server and leave the phone overnight. The session
   token is now at rest, so the morning should not need a re-enrol.
6. The 30-minute scan test from the remaining-pipeline list: a real fleet,
   real tags, gloves, and someone watching the clock on the scan feedback.

Not done and not attempted in W12: a **release** build (signing keys, and
`run-as` will not work on one, so §5(b) is debug-only as written) and ProGuard
rules for the SQLCipher and Tink classes.

The backup policy IS done, in this wave: the manifest carries
`android:allowBackup="false"`, `fullBackupContent="false"` and a
`data_extraction_rules.xml`. Capacitor's default is `true`, and for an
encrypted database that default is a trap — the ciphertext would be backed up
while the Keystore key could not be, so a restore onto a new phone would
produce a file nothing can open, and the customer list would have travelled
for nothing. It is not data *loss* (the outbox is the only irreplaceable part
and it stays on the old phone), but it is a confusing failure bought at the
price of shipping the book off the device, so it is off.

**The wipe has no button, deliberately.** `deviceKeys()` exposes the key
provider so `wipe()` — destroy the key, making the book permanently
unreadable — has a way to be reached, and its guard (refuse while the outbox
holds anything unsent) is tested. No screen calls it. That is a decision, not
an oversight: the only honest reasons to wipe a phone are "it is leaving the
house" and "it is lost", and both are the owner's call at a desk, not a
tech's on a scanner. When that screen is built it belongs in Settings behind
a hold and a typed confirmation, next to sign-out, and it must attempt a
flush first.
