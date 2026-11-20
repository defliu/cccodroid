package cc.codroid;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/**
 * 遥控端（cccodroid remote）：手机上只做客户端，Claude Code 在电脑上跑。
 *
 * 壳沿用 cccodroid 的做法（原生 Activity + WebView），但启动时不做任何本机安装：
 * 没有开发工具包、没有手机端 claude、没有手机端网关，也不要存储 / Shizuku 权限。
 * 页面是打进 APK 的 remote/web（和中继发给浏览器的是同一份），从 127.0.0.1 的临时
 * 端口加载——回环地址是浏览器的安全上下文，WebCrypto 可用，所以中继可以只开普通
 * ws://，不必先有 HTTPS 隧道。
 *
 * 第一次打开显示配对页；粘上电脑给的配对链接后进 WebView，链接记在应用私有目录，
 * 下次直接进。右上角「⋮」可以重新配对或刷新。
 *
 * 不用 lambda：开发端的构建链（同一份源码改包名）不支持。
 */
public class RemoteActivity extends Activity {
    private static final String PREFS = "remote";
    private static final String KEY_LINK = "link";

    // 和 remote/web 的配色一致（那一页是深色的）
    private static final int BG = 0xff0f1115;
    private static final int PANEL = 0xff171a21;
    private static final int LINE = 0xff2a303c;
    private static final int FG = 0xffe7ebf3;
    private static final int DIM = 0xff8a93a6;
    private static final int ACCENT = 0xffc96442;
    private static final int BAD = 0xffe05c5c;

    private SharedPreferences prefs;
    private FrameLayout root;
    private View setupView;
    private EditText input;
    private TextView error;
    private TextView menuButton;
    private WebView web;
    private RemoteServer server;
    private String currentLink = "";
    private String lastError = "";

    @Override protected void onCreate(Bundle b) {
        setTheme(android.R.style.Theme_Material_NoActionBar);
        super.onCreate(b);
        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);

        currentLink = prefs.getString(KEY_LINK, "");
        String why = null;
        RemoteLink rl = null;
        if (currentLink.length() > 0) {
            String[] reason = new String[1];
            rl = RemoteLink.parse(currentLink, reason);
            why = reason[0];
        }
        if (rl == null || !open(rl)) {
            showSetup(currentLink);
            String msg = why != null ? why : lastError;
            if (error != null && msg != null && msg.length() > 0) error.setText(msg);
        }
    }

    @Override protected void onDestroy() {
        releaseWeb();
        if (server != null) {
            server.close();
            server = null;
        }
        super.onDestroy();
    }

    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    // ── 配对页 ─────────────────────────────────────────────────────────

    private void showSetup(String prefill) {
        releaseWeb();
        if (setupView != null) {
            root.removeView(setupView);
            setupView = null;
        }
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22);
        box.setPadding(pad, pad, pad, pad);
        scroll.addView(box, new ScrollView.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        box.addView(label("cccodroid remote", 24, FG, true));
        addWithTop(box, label("手机只做遥控；Claude Code 在电脑上运行。", 14, DIM, false), 6);
        addWithTop(box, label("在电脑的 cccodroid「设置 → 远程控制」里生成配对链接，粘贴到这里：", 13, DIM, false), 22);

        input = new EditText(this);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        input.setTypeface(Typeface.MONOSPACE);
        input.setTextColor(FG);
        input.setHintTextColor(DIM);
        input.setHint("https://中继地址/#room=…&code=…");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setMinLines(3);
        input.setMaxLines(5);
        input.setGravity(Gravity.TOP | Gravity.START);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable ib = new GradientDrawable();
        ib.setColor(PANEL);
        ib.setCornerRadius(dp(10));
        ib.setStroke(dp(1), LINE);
        input.setBackground(ib);
        input.setText(prefill == null ? "" : prefill);
        input.setSelection(input.getText().length());
        addWithTop(box, input, 10);

        error = label("", 13, BAD, false);
        addWithTop(box, error, 8);

        TextView go = label("连接", 15, 0xffffffff, true);
        go.setGravity(Gravity.CENTER);
        GradientDrawable gb = new GradientDrawable();
        gb.setColor(ACCENT);
        gb.setCornerRadius(dp(10));
        go.setBackground(gb);
        go.setPadding(dp(16), dp(12), dp(16), dp(12));
        go.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { submit(); }
        });
        addWithTop(box, go, 16);

        addWithTop(box, label(
            "链接里的主机就是中继：同一 Wi-Fi 下用 ws://电脑IP:3011 的链接，出门在外用 "
            + "HTTPS 隧道的链接。手机端不装任何运行组件，也不会下载东西。",
            12, DIM, false), 20);

        setupView = scroll;
        root.addView(scroll, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void submit() {
        String raw = input == null ? "" : input.getText().toString();
        String[] why = new String[1];
        RemoteLink rl = RemoteLink.parse(raw, why);
        if (rl == null) {
            if (error != null) error.setText(why[0]);
            return;
        }
        if (error != null) error.setText("");
        if (!open(rl) && error != null) error.setText(lastError);
    }

    private void hideSetup() {
        if (setupView == null) return;
        root.removeView(setupView);
        setupView = null;
        input = null;
        error = null;
    }

    // ── WebView ────────────────────────────────────────────────────────

    private boolean open(RemoteLink rl) {
        try {
            if (server == null) server = RemoteServer.start(getAssets());
        } catch (Exception e) {
            lastError = "本机页面服务起不来：" + e.getMessage();
            return false;
        }
        currentLink = rl.link;
        prefs.edit().putString(KEY_LINK, rl.link).apply();
        ensureWeb();
        hideSetup();
        web.loadUrl(pageUrl(rl));
        return true;
    }

    private String pageUrl(RemoteLink rl) {
        String relay;
        try {
            relay = URLEncoder.encode(rl.relayWs, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            relay = rl.relayWs;
        }
        return "http://127.0.0.1:" + server.port() + "/?relay=" + relay
            + "#room=" + rl.room + "&code=" + rl.code;
    }

    private void ensureWeb() {
        if (web != null) return;
        WebView v = new WebView(this);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        v.setBackgroundColor(BG);
        v.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return grab(url);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return grab(req.getUrl() == null ? "" : req.getUrl().toString());
            }
        });
        web = v;
        root.addView(v, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView gear = label("⋮", 20, FG, true);
        gear.setGravity(Gravity.CENTER);
        gear.setIncludeFontPadding(false);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(0x66000000);
        gd.setCornerRadius(dp(18));
        gear.setBackground(gd);
        gear.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { menu(); }
        });
        FrameLayout.LayoutParams glp = new FrameLayout.LayoutParams(
            dp(36), dp(36), Gravity.TOP | Gravity.END);
        glp.topMargin = dp(8);
        glp.rightMargin = dp(8);
        menuButton = gear;
        root.addView(gear, glp);
    }

    /** 页面在回环上；点到外面的链接交给系统浏览器，别在这个壳里开。 */
    private boolean grab(String url) {
        if (url == null || url.length() == 0) return false;
        if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")
            || url.startsWith("about:")) return false;
        if (url.startsWith("http://") || url.startsWith("https://")) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {}
        }
        return true;
    }

    private void menu() {
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setItems(new String[]{"重新配对", "刷新页面"}, new DialogInterface.OnClickListener() {
            public void onClick(DialogInterface d, int which) {
                if (which == 0) showSetup(currentLink);
                else if (web != null) web.reload();
            }
        });
        b.show();
    }

    private void releaseWeb() {
        if (menuButton != null) {
            root.removeView(menuButton);
            menuButton = null;
        }
        if (web != null) {
            root.removeView(web);
            web.stopLoading();
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
    }

    // ── 小工具 ─────────────────────────────────────────────────────────

    private TextView label(String text, int sp, int color, boolean bold) {
        TextView v = new TextView(this);
        v.setText(text);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        v.setTextColor(color);
        if (bold) v.setTypeface(Typeface.DEFAULT_BOLD);
        return v;
    }

    private void addWithTop(LinearLayout box, View v, int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(topDp);
        box.addView(v, lp);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
