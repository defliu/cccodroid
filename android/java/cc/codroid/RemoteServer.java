package cc.codroid;

import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * 遥控端的页面服务器：只监听 127.0.0.1 的临时端口，只发 APK 里那三个文件。
 *
 * 页面必须从 http://127.0.0.1 加载：浏览器把回环地址当安全上下文，WebCrypto 才可用
 * （遥控端不需要 HTTPS 隧道的原因就在这里）。不对外网卡监听，也不读应用私有目录以外
 * 的东西；路径是写死的白名单，没有目录穿越这回事。
 */
final class RemoteServer implements Closeable {
    private static final String CSP =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        + "img-src 'self' data: blob:; connect-src ws: wss:; base-uri 'none'; form-action 'none'";

    private final ServerSocket socket;
    private final AssetManager assets;
    private final Thread thread;
    private volatile boolean closed;

    static RemoteServer start(AssetManager assets) throws IOException {
        ServerSocket s = new ServerSocket();
        s.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
        RemoteServer server = new RemoteServer(s, assets);
        server.thread.start();
        return server;
    }

    private RemoteServer(ServerSocket socket, AssetManager assets) {
        this.socket = socket;
        this.assets = assets;
        this.thread = new Thread(new Runnable() {
            public void run() { loop(); }
        }, "cccodroid-remote-http");
        this.thread.setDaemon(true);
    }

    int port() {
        return socket.getLocalPort();
    }

    private void loop() {
        while (!closed) {
            final Socket c;
            try {
                c = socket.accept();
            } catch (IOException e) {
                continue;   // 端口关了（closed 已置上）就退出循环；别的 IO 错误继续等
            }
            // 一条连接一个线程：WebView 可能先开一条空连接预热，不能把真正的请求堵在后面
            Thread t = new Thread(new Runnable() {
                public void run() {
                    try { handle(c); } finally { try { c.close(); } catch (IOException ignored) {} }
                }
            }, "cccodroid-remote-http-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private void handle(Socket c) {
        try {
            c.setSoTimeout(5000);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            int b;
            while ((b = in.read()) >= 0) {
                line.write(b);
                if (b == '\n') break;   // 只看请求行，后面的头不关心
            }
            String req = new String(line.toByteArray(), StandardCharsets.ISO_8859_1).trim();
            String[] bits = req.split(" ");
            String path = bits.length >= 2 ? bits[1] : "/";
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);

            String file;
            String type;
            if (path.equals("/") || path.equals("/index.html")) {
                file = "remote/index.html";
                type = "text/html; charset=utf-8";
            } else if (path.equals("/app.js")) {
                file = "remote/app.js";
                type = "text/javascript; charset=utf-8";
            } else if (path.equals("/protocol.mjs")) {
                file = "remote/protocol.mjs";
                type = "text/javascript; charset=utf-8";
            } else {
                send(c.getOutputStream(), 404, "text/plain; charset=utf-8",
                    "not found".getBytes(StandardCharsets.UTF_8), false);
                return;
            }
            boolean head = bits.length >= 1 && "HEAD".equalsIgnoreCase(bits[0]);
            send(c.getOutputStream(), 200, type, readAsset(file), head);
        } catch (IOException ignored) {
        }
    }

    private void send(OutputStream out, int code, String type, byte[] body, boolean headOnly) throws IOException {
        String head = "HTTP/1.1 " + (code == 200 ? "200 OK" : "404 Not Found") + "\r\n"
            + "Content-Type: " + type + "\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Cache-Control: no-store\r\n"
            + "X-Content-Type-Options: nosniff\r\n"
            + "Content-Security-Policy: " + CSP + "\r\n"
            + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        if (!headOnly) out.write(body);
        out.flush();
    }

    private byte[] readAsset(String name) throws IOException {
        InputStream in = assets.open(name);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } finally {
            try { in.close(); } catch (IOException ignored) {}
        }
    }

    @Override public void close() {
        closed = true;
        try { socket.close(); } catch (IOException ignored) {}
        thread.interrupt();
    }
}
