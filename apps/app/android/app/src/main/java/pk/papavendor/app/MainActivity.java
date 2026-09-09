package pk.papavendor.app;

import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

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
