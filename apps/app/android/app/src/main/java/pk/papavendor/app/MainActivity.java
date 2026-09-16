package pk.papavendor.app;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * The two native surfaces this app adds, wired in the only order that
     * works.
     *
     * THE PRINTER PLUGIN GOES BEFORE super.onCreate. BridgeActivity builds
     * the bridge inside super.onCreate, and a plugin registered after that
     * is registered with nothing.
     *
     * THE SQL BRIDGE GOES AFTER, because the WebView does not exist until
     * the bridge is built. `addJavascriptInterface` on an object injected
     * after a page has begun loading would not appear in that page's
     * JavaScript — so if this ever loses the race, the web side must NOT
     * quietly fall back to the in-memory browser database: that would be a
     * phone that scans all day and forgets everything when Android kills it.
     * apps/app/src/db/boot.ts refuses to start rather than fall back on a
     * native platform, which is what makes this ordering safe to depend on.
     *
     * WHY @JavascriptInterface AND NOT A PLUGIN for the database: SqlDriver
     * is synchronous (the scan handler may not await — CONTRIBUTING
     * principle 1) and only a JavascriptInterface method can be called
     * synchronously from JavaScript. The long version is in
     * PapaSqlBridge.java and apps/app/src/db/capacitor-driver.ts.
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PapaPrintPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge()
                .getWebView()
                .addJavascriptInterface(new PapaSqlBridge(this), PapaSqlBridge.JS_NAME);
        }
    }

    /**
     * Volume-down as a physical scan-loop button.
     *
     * A gloved hand finds a hardware button by feel; it cannot find an
     * on-screen target by feel (PLAN.md, the scan loop). The WebView never
     * receives hardware volume keys as keydown events, so the bridge
     * forwards them as a window event the web side can subscribe to:
     *
     *   window.addEventListener('papa:volume-down', ...)
     *
     * The key is consumed while the app is foregrounded — this is a
     * dedicated scanner tool, not a media app. Volume-up is left alone so
     * the phone's volume remains adjustable.
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN && getBridge() != null) {
            getBridge().triggerWindowJSEvent("papa:volume-down");
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
