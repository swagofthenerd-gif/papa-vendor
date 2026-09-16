package pk.papavendor.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteException;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import net.zetetic.database.DatabaseErrorHandler;
import net.zetetic.database.sqlcipher.SQLiteDatabase;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.security.SecureRandom;

/**
 * The SYNCHRONOUS SQLCipher bridge.
 *
 * ---------------------------------------------------------------------------
 * WHY @JavascriptInterface AND NOT A CAPACITOR PLUGIN
 *
 * The offline engine's `SqlDriver` (packages/core/src/db/driver.ts) is
 * synchronous, because the scan handler may not await anything — that is
 * principle 1 in CONTRIBUTING.md and it is what every read model and every
 * test in the repo is written against. A Capacitor plugin call is
 * asynchronous and cannot be awaited inside a synchronous function, so a
 * plugin cannot implement SqlDriver without rewriting the engine.
 *
 * A method annotated `@JavascriptInterface` on an object handed to
 * `WebView.addJavascriptInterface` is different: JavaScript calls it
 * SYNCHRONOUSLY and gets a String back. That is precisely the shape the
 * driver needs, which is why this class exists instead of a plugin.
 *
 * EVERYTHING THAT CAN BE TYPESCRIPT IS TYPESCRIPT. This class marshals and
 * nothing else: no statement splitting, no transaction nesting, no retry
 * policy, no schema knowledge. All of that lives in
 * apps/app/src/db/capacitor-driver.ts, where it runs under Node in the test
 * suite against a fake bridge of this exact shape. Java on this repo's
 * machine is verified by reading, and reading is not a test.
 *
 * TWO RETURN CONVENTIONS, both mirrored in the TypeScript:
 *   - open/exec/begin/commit/rollback/wipe: "" means it worked, anything
 *     else is the error message. An empty string is never a real error, so
 *     there is nothing ambiguous to resolve.
 *   - all/key: JSON. A row array / {"key":"…"} on success, {"error":"…"} on
 *     failure. An object where an array belongs makes a driver that forgot
 *     to check fail loudly instead of quietly seeing no rows.
 *
 * THE KEY. 32 bytes from SecureRandom, generated ONCE on first use, held in
 * EncryptedSharedPreferences whose master key lives in the Android Keystore
 * — non-exportable, hardware-backed where the phone has the hardware — with
 * setUserAuthenticationRequired(false). packages/core/src/db/device-key.ts
 * settles that design and says why: the PIN gates the SESSION, the Keystore
 * holds the KEY, and a four-digit PIN as the database passphrase would be
 * brute-forceable offline in seconds once the file is copied off the phone.
 *
 * WHAT THIS CLASS WILL NOT DO. It will not open the database with an empty
 * key (SQLCipher would open it in PLAINTEXT and say nothing), and it will
 * not open it with a key that is not the one the Keystore holds. The
 * TypeScript refuses both as well. Two layers, because the consequence of
 * getting it wrong is the whole fleet, every purchase price and the customer
 * list in the clear on a phone in a tech's pocket.
 * ---------------------------------------------------------------------------
 */
public class PapaSqlBridge {

    /** The object's name on `window`. Must match capacitor-driver.ts. */
    public static final String JS_NAME = "PapaSql";

    private static final String TAG = "PapaSql";

    /**
     * The file. `getDatabasePath` puts it in the app's private
     * databases/ directory, which is what db/device-proof.sh reads with
     * `run-as … cat databases/papa.db`.
     */
    private static final String DB_NAME = "papa.db";

    private static final String PREFS_FILE = "papa_device_key";
    private static final String PREF_KEY = "sqlcipher_key_b64";
    private static final String MASTER_KEY_ALIAS = "papa_device_db_master";

    /** 256 bits. SQLCipher's own default cipher strength. */
    private static final int KEY_BYTES = 32;

    /** How many leading bytes `header()` reports. */
    private static final int HEADER_BYTES = 16;

    private static boolean nativeLoaded = false;

    private final Context context;
    private SQLiteDatabase db;

    /**
     * The thread that opened a transaction, or null.
     *
     * Android's SQLiteDatabase holds transaction state per THREAD, so a
     * begin on one thread and a commit on another would not be the same
     * transaction — and on the outbox that means a scan written without its
     * queue row, which is the single worst failure available to this app.
     * WebView dispatches every @JavascriptInterface call on one dedicated
     * Java-bridge thread, so this never trips; it is checked rather than
     * assumed because a guarantee nothing verifies is prose.
     */
    private Thread txThread;

    PapaSqlBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    // ---- the key ----------------------------------------------------------

    /**
     * Read-or-create the device key.
     *
     * Returns {"key":"<base64 of 32 random bytes>"} or {"error":"…"}. The
     * key does cross into JavaScript, because DeviceKeyProvider.getKey()
     * returns the passphrase SQLCipher's PRAGMA key takes and the driver
     * above it is synchronous. docs/android.md says plainly what that costs.
     */
    @JavascriptInterface
    public String key() {
        try {
            SharedPreferences prefs = prefs();
            String existing = prefs.getString(PREF_KEY, null);
            if (existing != null && existing.length() > 0) {
                return json("key", existing);
            }
            byte[] fresh = new byte[KEY_BYTES];
            new SecureRandom().nextBytes(fresh);
            String encoded = Base64.encodeToString(fresh, Base64.NO_WRAP);
            // commit(), not apply(): apply() is asynchronous, and a key
            // written asynchronously can lose the race with the database
            // file it encrypts. A phone killed in that window would hold a
            // ciphertext whose key was never stored — unreadable forever.
            boolean stored = prefs.edit().putString(PREF_KEY, encoded).commit();
            if (!stored) {
                return json("error", "Could not store the device key; refusing to open the database.");
            }
            return json("key", encoded);
        } catch (Throwable t) {
            return json("error", describe("The device key could not be read or created", t));
        }
    }

    /**
     * Destroy the key, then the file.
     *
     * The key goes first on purpose: device-key.ts's reasoning is that
     * deleting a file on Android guarantees nothing, while a ciphertext
     * whose key is gone is genuinely unrecoverable. If the file deletion
     * then fails, the data is already beyond reach.
     *
     * THE GUARD IS NOT HERE. Whether a wipe is allowed at all — the outbox,
     * the un-uploaded photos and voice notes that exist nowhere else — is
     * decided in CapacitorKeyProvider.wipe(), because that is where it can
     * be tested.
     */
    @JavascriptInterface
    public String wipe() {
        String failure = "";
        try {
            if (!prefs().edit().remove(PREF_KEY).commit()) {
                failure = "The device key could not be removed. ";
            }
        } catch (Throwable t) {
            failure = describe("The device key could not be removed", t) + ". ";
        }
        try {
            if (db != null) {
                db.close();
                db = null;
                txThread = null;
            }
            File file = context.getDatabasePath(DB_NAME);
            for (String suffix : new String[] { "", "-wal", "-shm", "-journal" }) {
                File part = new File(file.getPath() + suffix);
                if (part.exists() && !part.delete()) {
                    failure = failure + "Could not delete " + part.getName() + ". ";
                }
            }
        } catch (Throwable t) {
            failure = failure + describe("The database file could not be deleted", t);
        }
        return failure.trim();
    }

    // ---- the database -----------------------------------------------------

    /**
     * Open (or create) the encrypted database.
     *
     * Refuses an empty key, and refuses a key that is not the one the
     * Keystore holds. Calling it twice with the same key is a no-op, so a
     * reloaded WebView does not reopen the file.
     */
    @JavascriptInterface
    public String open(String keyB64) {
        try {
            if (keyB64 == null || keyB64.length() == 0) {
                // The single most dangerous input in this file. SQLCipher
                // opens an empty-keyed database in PLAINTEXT and reports
                // success, so everything downstream works perfectly while
                // the data sits unprotected.
                return "Refusing to open the device database with an empty key: "
                        + "SQLCipher would open it unencrypted and report success.";
            }
            String held = prefs().getString(PREF_KEY, null);
            if (held == null) {
                return "There is no device key yet; ask for one before opening the database.";
            }
            if (!constantTimeEquals(held, keyB64)) {
                return "That is not this phone's database key.";
            }
            if (db != null && db.isOpen()) {
                return "";
            }
            loadNative();
            File file = context.getDatabasePath(DB_NAME);
            File parent = file.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                return "Could not create the databases directory.";
            }
            db = SQLiteDatabase.openOrCreateDatabase(file, keyB64, null, KEEP_THE_FILE);
            // Parity with NodeSqliteDriver and SqlJsDriver, both of which do
            // this at construction.
            db.execSQL("pragma foreign_keys = on");
            return "";
        } catch (Throwable t) {
            return describe("The device database would not open", t);
        }
    }

    @JavascriptInterface
    public String exec(String sql, String paramsJson) {
        try {
            SQLiteDatabase handle = requireOpen();
            String wrongThread = checkTransactionThread();
            if (wrongThread != null) return wrongThread;
            Object[] args = bindArgs(paramsJson);
            if (args.length == 0) {
                handle.execSQL(sql);
            } else {
                handle.execSQL(sql, args);
            }
            return "";
        } catch (Throwable t) {
            return describe("Statement failed", t);
        }
    }

    @JavascriptInterface
    public String all(String sql, String paramsJson) {
        Cursor cursor = null;
        try {
            SQLiteDatabase handle = requireOpen();
            String wrongThread = checkTransactionThread();
            if (wrongThread != null) return json("error", wrongThread);
            Object[] args = bindArgs(paramsJson);
            cursor = handle.rawQuery(sql, args);
            JSONArray rows = new JSONArray();
            while (cursor.moveToNext()) {
                JSONObject row = new JSONObject();
                for (int i = 0; i < cursor.getColumnCount(); i++) {
                    String name = cursor.getColumnName(i);
                    switch (cursor.getType(i)) {
                        case Cursor.FIELD_TYPE_NULL:
                            // JSONObject.NULL, not Java null: putting a Java
                            // null REMOVES the key, and a missing column
                            // reads as undefined in JavaScript rather than
                            // as the null the row actually holds.
                            row.put(name, JSONObject.NULL);
                            break;
                        case Cursor.FIELD_TYPE_INTEGER:
                            row.put(name, cursor.getLong(i));
                            break;
                        case Cursor.FIELD_TYPE_FLOAT:
                            row.put(name, cursor.getDouble(i));
                            break;
                        case Cursor.FIELD_TYPE_STRING:
                            row.put(name, cursor.getString(i));
                            break;
                        default:
                            // The local schema has no blob columns — photo
                            // and voice bytes live on the filesystem behind
                            // PhotoStore / VoiceNoteStore. A blob here is a
                            // schema change nobody told the driver about,
                            // and guessing at it would corrupt data
                            // silently.
                            return json("error", "Column " + name + " is a blob; the driver carries "
                                    + "string, number and null only.");
                    }
                }
                rows.put(row);
            }
            return rows.toString();
        } catch (Throwable t) {
            return json("error", describe("Query failed", t));
        } finally {
            if (cursor != null) {
                try { cursor.close(); } catch (Throwable ignored) { }
            }
        }
    }

    /**
     * Transactions use the library's own API rather than raw BEGIN / COMMIT.
     *
     * SQLiteDatabase keeps a connection pool and per-thread session state; a
     * raw `BEGIN` pushed through execSQL leaves the session unaware it is in
     * a transaction, and whether the following statements land on the same
     * connection then depends on pool internals. beginTransaction() holds
     * the connection for the thread, which is the behaviour the outbox needs:
     * the optimistic row and its queue row commit together or not at all.
     */
    @JavascriptInterface
    public String begin() {
        try {
            SQLiteDatabase handle = requireOpen();
            if (txThread != null) {
                // The TypeScript driver counts nesting and never calls this
                // twice. If it ever did, Android would open a savepoint and
                // the two layers would disagree about what a rollback undoes.
                return "A transaction is already open on this connection.";
            }
            handle.beginTransaction();
            txThread = Thread.currentThread();
            return "";
        } catch (Throwable t) {
            return describe("Could not begin a transaction", t);
        }
    }

    @JavascriptInterface
    public String commit() {
        try {
            SQLiteDatabase handle = requireOpen();
            if (txThread == null) return "No transaction is open.";
            String wrongThread = checkTransactionThread();
            if (wrongThread != null) return wrongThread;
            handle.setTransactionSuccessful();
            handle.endTransaction();
            txThread = null;
            return "";
        } catch (Throwable t) {
            txThread = null;
            return describe("Could not commit", t);
        }
    }

    /** endTransaction WITHOUT setTransactionSuccessful is the rollback. */
    @JavascriptInterface
    public String rollback() {
        try {
            SQLiteDatabase handle = requireOpen();
            if (txThread == null) return "No transaction is open.";
            String wrongThread = checkTransactionThread();
            if (wrongThread != null) return wrongThread;
            handle.endTransaction();
            txThread = null;
            return "";
        } catch (Throwable t) {
            txThread = null;
            return describe("Could not roll back", t);
        }
    }

    /**
     * The first bytes of the file on disk, lowercase hex, or "".
     *
     * This is the phone proving its own encryption without a cable. A
     * plaintext SQLite file begins with the ASCII "SQLite format 3\0"
     * (53514c69746520666f726d6174203300); a SQLCipher file begins with its
     * random per-database salt, so it matches that magic on no install and
     * differs on every one.
     */
    @JavascriptInterface
    public String header() {
        FileInputStream in = null;
        try {
            File file = context.getDatabasePath(DB_NAME);
            if (!file.exists()) return "";
            in = new FileInputStream(file);
            byte[] buffer = new byte[HEADER_BYTES];
            int read = in.read(buffer);
            if (read <= 0) return "";
            StringBuilder hex = new StringBuilder(read * 2);
            for (int i = 0; i < read; i++) {
                hex.append(Character.forDigit((buffer[i] >> 4) & 0xf, 16));
                hex.append(Character.forDigit(buffer[i] & 0xf, 16));
            }
            return hex.toString();
        } catch (Throwable t) {
            Log.w(TAG, "could not read the database header", t);
            return "";
        } finally {
            if (in != null) {
                try { in.close(); } catch (Throwable ignored) { }
            }
        }
    }

    // ---- plumbing ---------------------------------------------------------

    /**
     * An error handler that does NOT delete the database.
     *
     * The library's default handler deletes a corrupt file. On this app that
     * would destroy the outbox, the un-uploaded photos and the voice notes —
     * the only copy of that evidence anywhere (docs/principles.md #3: data
     * may be delayed, never lost). Better a phone that refuses to open and
     * keeps its file for recovery than one that opens clean and empty.
     */
    private static final DatabaseErrorHandler KEEP_THE_FILE = new DatabaseErrorHandler() {
        @Override
        public void onCorruption(SQLiteDatabase database, SQLiteException cause) {
            Log.e(TAG, "the device database reports corruption; the file is being KEPT for recovery", cause);
            try {
                if (database != null) database.close();
            } catch (Throwable ignored) { }
        }
    };

    private SharedPreferences prefs() throws Exception {
        MasterKey master = new MasterKey.Builder(context, MASTER_KEY_ALIAS)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                // The PIN gates the session, not the database: a warehouse
                // phone must be able to open its database and keep syncing
                // with nobody looking at it. device-key.ts, at length.
                .setUserAuthenticationRequired(false)
                .build();
        return EncryptedSharedPreferences.create(
                context,
                PREFS_FILE,
                master,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    private static synchronized void loadNative() {
        if (nativeLoaded) return;
        System.loadLibrary("sqlcipher");
        nativeLoaded = true;
    }

    private SQLiteDatabase requireOpen() {
        if (db == null || !db.isOpen()) {
            throw new IllegalStateException("The device database is not open.");
        }
        return db;
    }

    private String checkTransactionThread() {
        if (txThread == null || txThread == Thread.currentThread()) return null;
        return "This statement arrived on " + Thread.currentThread().getName()
                + " while a transaction is open on " + txThread.getName()
                + "; a transaction cannot span threads.";
    }

    /**
     * JSON params to bind arguments, in the driver's three types only.
     *
     * Integers cross as long. A boolean or an object is refused rather than
     * coerced: node:sqlite — the driver every test in the repo runs against
     * — refuses them too, and a shipped driver that silently accepts what the
     * tested driver rejects is a difference nobody would find until the data
     * was already wrong.
     */
    private static Object[] bindArgs(String paramsJson) throws Exception {
        if (paramsJson == null || paramsJson.length() == 0) return new Object[0];
        JSONArray array = new JSONArray(paramsJson);
        Object[] args = new Object[array.length()];
        for (int i = 0; i < array.length(); i++) {
            Object value = array.get(i);
            if (value == JSONObject.NULL) {
                args[i] = null;
            } else if (value instanceof Integer) {
                args[i] = Long.valueOf(((Integer) value).longValue());
            } else if (value instanceof Long || value instanceof Double || value instanceof String) {
                args[i] = value;
            } else {
                throw new IllegalArgumentException("Parameter " + (i + 1) + " is a "
                        + value.getClass().getSimpleName()
                        + "; the driver takes string, number or null only.");
            }
        }
        return args;
    }

    /** One JSON pair, escaped by the JSON library rather than by hand. */
    private static String json(String field, String value) {
        try {
            return new JSONObject().put(field, value).toString();
        } catch (Throwable t) {
            // JSONObject.put only throws on a null key, which is impossible
            // here; this branch exists so the method cannot itself fail.
            return "{\"error\":\"Could not encode the answer.\"}";
        }
    }

    /**
     * A message a person could act on.
     *
     * The class name matters when the cause is a Keystore or a native
     * loading failure and the message is empty, which several of them are.
     */
    private static String describe(String what, Throwable t) {
        String message = t.getMessage();
        String detail = (message == null || message.length() == 0)
                ? t.getClass().getSimpleName()
                : message;
        Log.w(TAG, what + ": " + detail, t);
        return what + ": " + detail;
    }

    /**
     * Compare two keys without leaking their length or contents in timing.
     *
     * The attacker model here is thin — the caller is the app's own WebView —
     * but a key comparison written the short way is the kind of line that
     * gets copied somewhere it matters.
     */
    private static boolean constantTimeEquals(String a, String b) {
        byte[] left = a.getBytes();
        byte[] right = b.getBytes();
        int diff = left.length ^ right.length;
        for (int i = 0; i < left.length && i < right.length; i++) {
            diff |= left[i] ^ right[i];
        }
        return diff == 0;
    }
}
