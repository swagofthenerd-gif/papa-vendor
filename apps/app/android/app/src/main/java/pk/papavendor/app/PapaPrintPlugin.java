package pk.papavendor.app;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * The thermal parchi's transport: Bluetooth classic SPP.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE IS AN ORDINARY ASYNC PLUGIN AND THE DATABASE IS NOT
 *
 * The database bridge next door had to be `@JavascriptInterface` because
 * SqlDriver is synchronous. Printing is nowhere near the scan path: the
 * bytes are already built (packages/core/src/escpos.ts, golden-tested), the
 * desk is standing at a till, and an await is exactly right — a Bluetooth
 * connect takes seconds and must not block anything. So this is a normal
 * Capacitor plugin, which also gets the permission plumbing for free.
 *
 * THE BYTES ARE NOT BUILT HERE and never will be. `buildParchiEscPos` in
 * @papa/core is the one home for the ESC/POS stream (docs/principles.md #4);
 * this class opens a socket, writes what it is given, and closes it.
 *
 * PERMISSIONS ARE ASKED AT USE, NEVER AT LAUNCH. A phone that demands
 * Bluetooth on first open, before the person has printed anything, is a
 * phone people deny and then cannot un-deny without finding Settings. The
 * ask happens the first time someone taps a printer row.
 *
 * API 31 SPLIT THE PERMISSION. BLUETOOTH_CONNECT and BLUETOOTH_SCAN are
 * runtime permissions from Android 12; below that the install-time
 * BLUETOOTH / BLUETOOTH_ADMIN pair covers the same ground and there is
 * nothing to request at runtime. Asking anyway on an Android 7–11 phone
 * returns DENIED for a permission that does not exist there, which would
 * make printing impossible on precisely the cheap phones this product is
 * for — so the version gate below is load-bearing, not tidiness.
 * ---------------------------------------------------------------------------
 */
@CapacitorPlugin(
    name = "PapaPrint",
    permissions = {
        @Permission(
            strings = { Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN },
            alias = PapaPrintPlugin.BLUETOOTH
        )
    }
)
public class PapaPrintPlugin extends Plugin {

    static final String BLUETOOTH = "bluetooth";

    /** The Serial Port Profile UUID. Every ESC/POS clone answers on it. */
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    /**
     * The whole print, connect included, gets ten seconds.
     *
     * ASSUMPTION: ten seconds is how long a person at a till waits before
     * writing the parchi out by hand. connect()'s own timeout is about
     * twelve and cannot be set, so a number had to be chosen.
     * See docs/assumptions.md#print-timeout
     */
    private static final long TIMEOUT_MS = 10_000L;

    /**
     * How much is written at once, and the pause between chunks.
     *
     * A Rs 3,000 receipt printer has a few kilobytes of buffer and no flow
     * control worth the name. A parchi with a QR code is several kilobytes,
     * and handing it over in one write is how these printers produce half a
     * receipt and then stop. Small writes with a breath between them is the
     * shape that works on this class of hardware.
     *
     * ASSUMPTION: the chunk size and the pause are general to cheap SPP
     * clones, not measured on the pilot house's printer — no printer has fed
     * paper yet (#thermal-58mm is still open).
     * See docs/assumptions.md#printer-chunking
     */
    private static final int CHUNK_BYTES = 512;
    private static final long CHUNK_PAUSE_MS = 20L;

    /** One printer, one queue: two parchis at once would interleave bytes. */
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService watchdogs = Executors.newSingleThreadScheduledExecutor();

    /** The paired devices, as {name, mac} — the Settings picker's list. */
    @PluginMethod
    public void list(PluginCall call) {
        if (needsAsking()) {
            requestPermissionForAlias(BLUETOOTH, call, "afterPermission");
            return;
        }
        deliverList(call);
    }

    /** Write base64 bytes to the printer at `mac`. */
    @PluginMethod
    public void print(PluginCall call) {
        if (call.getString("mac") == null || call.getString("bytes") == null) {
            call.reject("bad_request");
            return;
        }
        if (needsAsking()) {
            requestPermissionForAlias(BLUETOOTH, call, "afterPermission");
            return;
        }
        send(call);
    }

    /**
     * Both methods come back through here after the dialog.
     *
     * The call carries its own arguments, so which method asked is read from
     * the arguments rather than remembered in a field — a field would be a
     * second source of truth for one in-flight call.
     */
    @PermissionCallback
    private void afterPermission(PluginCall call) {
        if (getPermissionState(BLUETOOTH) != PermissionState.GRANTED) {
            call.reject("permission_denied");
            return;
        }
        if (call.getString("mac") != null) {
            send(call);
        } else {
            deliverList(call);
        }
    }

    private void deliverList(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("no_bluetooth");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("bluetooth_off");
            return;
        }
        try {
            JSArray devices = new JSArray();
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded != null) {
                for (BluetoothDevice device : bonded) {
                    JSObject row = new JSObject();
                    String name = device.getName();
                    row.put("name", name == null ? device.getAddress() : name);
                    row.put("mac", device.getAddress());
                    devices.put(row);
                }
            }
            JSObject answer = new JSObject();
            answer.put("devices", devices);
            call.resolve(answer);
        } catch (SecurityException e) {
            // The permission was revoked between the check and the call.
            call.reject("permission_denied");
        } catch (Throwable t) {
            call.reject(reason(t));
        }
    }

    private void send(PluginCall call) {
        final String mac = call.getString("mac");
        final String encoded = call.getString("bytes");
        io.execute(() -> {
            BluetoothSocket socket = null;
            ScheduledFuture<?> watchdog = null;
            try {
                BluetoothAdapter adapter = adapter();
                if (adapter == null) { call.reject("no_bluetooth"); return; }
                if (!adapter.isEnabled()) { call.reject("bluetooth_off"); return; }

                byte[] payload = Base64.decode(encoded, Base64.DEFAULT);
                if (payload.length == 0) { call.reject("no_bytes"); return; }

                BluetoothDevice device = adapter.getRemoteDevice(mac);
                socket = device.createRfcommSocketToServiceRecord(SPP_UUID);

                // BluetoothSocket.connect() has its own timeout of about
                // twelve seconds and no way to set it. Closing the socket
                // from another thread makes the blocked call throw, which is
                // the only way to hold it to ten — and ten matters because
                // the person is standing at the till deciding whether to
                // write the parchi out by hand.
                final BluetoothSocket closing = socket;
                watchdog = watchdogs.schedule(() -> {
                    try { closing.close(); } catch (Throwable ignored) { }
                }, TIMEOUT_MS, TimeUnit.MILLISECONDS);

                socket.connect();
                OutputStream out = socket.getOutputStream();
                for (int at = 0; at < payload.length; at += CHUNK_BYTES) {
                    out.write(payload, at, Math.min(CHUNK_BYTES, payload.length - at));
                    out.flush();
                    Thread.sleep(CHUNK_PAUSE_MS);
                }
                watchdog.cancel(false);

                JSObject answer = new JSObject();
                answer.put("ok", true);
                answer.put("bytes", payload.length);
                call.resolve(answer);
            } catch (SecurityException e) {
                call.reject("permission_denied");
            } catch (Throwable t) {
                call.reject(reason(t));
            } finally {
                if (watchdog != null) watchdog.cancel(false);
                if (socket != null) {
                    try { socket.close(); } catch (Throwable ignored) { }
                }
            }
        });
    }

    /**
     * True when this Android needs a runtime grant we do not already hold.
     *
     * Below API 31 the answer is always false: BLUETOOTH_CONNECT does not
     * exist there, the install-time BLUETOOTH pair is already granted, and
     * asking would be asking for nothing and being told no.
     */
    private boolean needsAsking() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        return getPermissionState(BLUETOOTH) != PermissionState.GRANTED;
    }

    private BluetoothAdapter adapter() {
        Context context = getContext();
        if (context == null) return null;
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    /**
     * A short machine word, not a stack trace.
     *
     * thermal.ts's ThermalPrintResult carries `reason` for the screen to
     * translate, and the string table has the sentences. Anything not
     * recognised falls through as the exception's own message, which is what
     * a person reads when something genuinely unexpected happened.
     */
    private static String reason(Throwable t) {
        String message = t.getMessage();
        if (message == null || message.length() == 0) return t.getClass().getSimpleName();
        return message;
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
        watchdogs.shutdownNow();
        super.handleOnDestroy();
    }
}
