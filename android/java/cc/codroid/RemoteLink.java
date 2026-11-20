package cc.codroid;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 配对链接 → 遥控端要的三样东西：中继地址、房间号、配对码。
 *
 * 电脑上网关给出的链接形如 http(s)://&lt;中继主机&gt;/#room=…&amp;code=…（见
 * gateway/gw/remote.mjs 的 pairingUrl）。遥控端不从这个地址加载页面——那样手机侧必须
 * 是 HTTPS，浏览器才给 WebCrypto；它只把链接里的主机当中继，连 ws(s)://&lt;主机&gt;/ws，
 * 页面从应用自己的回环地址加载。
 *
 * 这里不碰安卓类，scripts/java-tests.sh 里有回归（RemoteLinkTest）。
 */
public final class RemoteLink {
    public final String link;      // 原始链接，原样记住，下次直接打开
    public final String relayWs;   // ws:// 或 wss://…/ws
    public final String room;
    public final String code;

    private RemoteLink(String link, String relayWs, String room, String code) {
        this.link = link;
        this.relayWs = relayWs;
        this.room = room;
        this.code = code;
    }

    /**
     * 解析失败返回 null，并把原因写进 reason[0]（给用户看的一句话）。
     * 链接里的 room / code 是网关生成的；手工改过、只抄了一半的链接也会得到明确提示。
     */
    public static RemoteLink parse(String raw, String[] reason) {
        String s = raw == null ? "" : raw.trim();
        if (s.length() == 0) {
            reason[0] = "把电脑上生成的配对链接粘贴到这里";
            return null;
        }
        int hash = s.indexOf('#');
        if (hash < 0) {
            reason[0] = "链接里没有配对信息：应当以 #room=…&code=… 结尾";
            return null;
        }
        String base = s.substring(0, hash);
        String frag = s.substring(hash + 1);
        int sep = base.indexOf("://");
        if (sep <= 0) {
            reason[0] = "链接应当以 http://、https:// 或 ws://、wss:// 开头";
            return null;
        }
        String scheme = base.substring(0, sep).toLowerCase(Locale.ROOT);
        String wsScheme;
        if (scheme.equals("https") || scheme.equals("wss")) wsScheme = "wss";
        else if (scheme.equals("http") || scheme.equals("ws")) wsScheme = "ws";
        else {
            reason[0] = "不认识的链接类型：" + scheme;
            return null;
        }
        String rest = base.substring(sep + 3);
        int slash = rest.indexOf('/');
        String host = (slash < 0 ? rest : rest.substring(0, slash)).trim();
        if (host.length() == 0 || host.indexOf(' ') >= 0 || host.indexOf('@') >= 0) {
            reason[0] = "链接里的中继地址不对";
            return null;
        }
        Map<String, String> q = new LinkedHashMap<String, String>();
        for (String part : frag.split("&")) {
            int eq = part.indexOf('=');
            if (eq > 0) q.put(part.substring(0, eq), decode(part.substring(eq + 1)));
        }
        String room = q.containsKey("room") ? q.get("room").trim().toLowerCase(Locale.ROOT) : "";
        String code = q.containsKey("code") ? q.get("code").toUpperCase(Locale.ROOT) : "";
        code = code.replaceAll("[^A-Z0-9]", "");
        if (!room.matches("[a-f0-9]{16,64}")) {
            reason[0] = "房间号不对（应为 16~64 位十六进制）";
            return null;
        }
        if (code.length() != 26) {
            reason[0] = "配对码不对（应为 26 位）";
            return null;
        }
        return new RemoteLink(s, wsScheme + "://" + host + "/ws", room, code);
    }

    private static String decode(String v) {
        try {
            return URLDecoder.decode(v, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            return v;
        } catch (IllegalArgumentException e) {
            return v;   // 半截的 %xx：按原样用，后面的校验会给出提示
        }
    }
}
