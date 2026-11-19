  // ── 远程控制（设置 → 远程控制）────────────────────────────────────────
  // 网关主动出站连中继，远程设备凭配对码接入；中继只转发密文（remote/README.md、gw/remote.mjs）。
  // 这一节只做开关、配对链接和连接状态：远程端是独立的 PWA，不在这个界面里。
  const rmPost = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), timeout: 30000 });
  let rmPoll = 0;
  let rmResetArmed = 0;

  function rmPaint(s) {
    if (!s) return;
    $("rm-on").checked = !!s.enabled;
    $("rm-block").classList.toggle("hidden", !s.enabled);
    const st = $("rm-state");
    const n = Array.isArray(s.peers) ? s.peers.length : (s.peer ? 1 : 0);
    const ok = n > 0;
    st.className = "prov-state" + (ok ? " ok" : (s.enabled ? " warn" : ""));
    st.textContent = !s.connected
      ? (s.enabled ? t("正在连接中继…") : t("未启用"))
      : n > 1 ? t("已接入 {n} 台远程设备", { n })
        : n === 1 ? t("远程设备已接入")
          : t("已连接中继，等待远程设备接入");
    $("rm-link").value = s.url || "";
    $("rm-room").textContent = s.room || "—";
    $("rm-code").textContent = s.code || "—";
    $("rm-relay").textContent = s.relay || "—";
    const hasLink = !!(s.enabled && s.url);
    $("rm-copy").disabled = !hasLink;
    $("rm-open").disabled = !hasLink;
    $("rm-reset").disabled = !s.enabled;
  }

  async function rmRefresh() {
    try { rmPaint(await api("/api/remote/status", { timeout: 15000 })); } catch {}
  }

  // 进入这一分类才轮询：连接状态是一秒一秒变的，用户看着这一页时每 3 秒刷一次
  function rmOnOpen() {
    rmRefresh();
    if (rmPoll) return;
    rmPoll = setInterval(() => {
      const pane = document.querySelector('.set-cat[data-cat="remote"]');
      if (!pane || pane.classList.contains("hidden") || !pane.getClientRects().length) { clearInterval(rmPoll); rmPoll = 0; return; }
      rmRefresh();
    }, 3000);
  }

  $("rm-on").addEventListener("change", async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    try {
      rmPaint(await rmPost(on ? "/api/remote/enable" : "/api/remote/disable"));
    } catch (err) {
      e.target.checked = !on;
      toast(err.message || t("操作失败"), true);
    } finally {
      e.target.disabled = false;
    }
  });

  $("rm-copy").addEventListener("click", async () => {
    const ok = await copyText($("rm-link").value);
    toast(ok ? t("已复制") : t("复制失败"), !ok);
  });

  $("rm-open").addEventListener("click", () => {
    const url = $("rm-link").value;
    if (url) openExternal(url);
  });

  // 重新生成 = 旧设备立刻作废，所以点一次先变成确认，4 秒内再点才真的换
  $("rm-reset").addEventListener("click", async () => {
    const btn = $("rm-reset");
    if (!rmResetArmed) {
      rmResetArmed = setTimeout(() => { rmResetArmed = 0; btn.textContent = t("重新生成配对码"); }, 4000);
      btn.textContent = t("再点一次确认（旧设备会断开）");
      return;
    }
    clearTimeout(rmResetArmed); rmResetArmed = 0;
    btn.textContent = t("重新生成配对码");
    btn.disabled = true;
    try {
      rmPaint(await rmPost("/api/remote/reset"));
      toast(t("配对码已重新生成"));
    } catch (err) {
      toast(err.message || t("操作失败"), true);
    } finally {
      btn.disabled = false;
    }
  });
