package cc.codroid;

/**
 * RemoteLink 的纯逻辑回归（不依赖安卓运行时）：配对链接只该被解释成中继地址 + 房间 + 配对码。
 * 跑法见 scripts/java-tests.sh。
 */
public final class RemoteLinkTest {
    private static int failed;

    public static void main(String[] args) {
        // 网关 pairingUrl 的典型形状：http(s)://<中继主机>/#room=…&code=…
        RemoteLink a = parse("http://192.168.1.5:3011/#room=0123456789abcdef0123456789abcdef&code=ABCDEFGHJKLMNPQRSTUVWXYZ23");
        check(a != null, "局域网链接应当能解析");
        check("ws://192.168.1.5:3011/ws".equals(a.relayWs), "http 链接要连 ws，得到 " + a.relayWs);
        check("0123456789abcdef0123456789abcdef".equals(a.room), "房间号原样保留");
        check("ABCDEFGHJKLMNPQRSTUVWXYZ23".equals(a.code), "配对码原样保留");

        RemoteLink b = parse("https://api.example.com:42965/#room=0123456789abcdef&code=abcdefghjklmnpqrstuvwxyz23");
        check(b != null, "公网链接应当能解析");
        check("wss://api.example.com:42965/ws".equals(b.relayWs), "https 链接要连 wss，得到 " + b.relayWs);
        check("ABCDEFGHJKLMNPQRSTUVWXYZ23".equals(b.code), "小写配对码要规范成大写");

        RemoteLink c = parse("wss://relay.example.com/ws#code=ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-23&room=0123456789ABCDEF");
        check(c != null, "ws(s) 链接也认");
        check("wss://relay.example.com/ws".equals(c.relayWs), "ws 链接保留 wss");
        check("0123456789abcdef".equals(c.room), "大写房间号规范成小写");
        check("ABCDEFGHJKLMNPQRSTUVWXYZ23".equals(c.code), "带连字符的配对码要去掉分隔符");

        check(parse("", new String[1]) == null, "空链接要拒绝");
        check(parse("http://192.168.1.5:3011/", new String[1]) == null, "没有 #room=… 要拒绝");
        check(parse("ftp://x/#room=0123456789abcdef&code=ABCDEFGHJKLMNPQRSTUVWXYZ23", new String[1]) == null,
            "不认识的协议要拒绝");
        check(parse("http://192.168.1.5:3011/#room=xyz&code=ABCDEFGHJKLMNPQRSTUVWXYZ23", new String[1]) == null,
            "房间号不是十六进制要拒绝");
        check(parse("http://192.168.1.5:3011/#room=0123456789abcdef&code=SHORT", new String[1]) == null,
            "配对码不够 26 位要拒绝");

        String[] why = new String[1];
        parse("http://x/#room=0123456789abcdef", why);
        check(why[0] != null && why[0].contains("26"), "配对码缺失时要说清楚原因：" + why[0]);

        if (failed > 0) {
            System.out.println("RemoteLinkTest: FAIL " + failed);
            System.exit(1);
        }
        System.out.println("RemoteLinkTest OK");
    }

    private static RemoteLink parse(String s) {
        return parse(s, new String[1]);
    }

    private static RemoteLink parse(String s, String[] why) {
        return RemoteLink.parse(s, why);
    }

    private static void check(boolean ok, String what) {
        if (!ok) {
            failed++;
            System.out.println("✗ " + what);
        }
    }
}
