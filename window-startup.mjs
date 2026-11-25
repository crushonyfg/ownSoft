// A failed first navigation must not leave a hidden window holding the single-instance lock.
export function windowStartup(target, { url, hidden = false, timeoutMs = 15_000,
  report = () => {}, failed = () => {} } = {}) {
  let loading;
  let presented = false;
  const alive = () => !target.isDestroyed();
  const present = () => {
    if (hidden || !alive()) return;
    if (target.isVisible ? !target.isVisible() : !presented) target.show();
    presented = true;
  };
  const reveal = () => {
    if (hidden || !alive()) return;
    if (target.isMinimized()) target.restore();
    present();
    target.focus();
  };
  async function navigate() {
    let timer;
    try {
      await Promise.race([
        target.loadURL(url),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            // A committed page can already host an active chat while a font/subframe is still
            // loading. Never reload that page just because did-finish-load is delayed.
            if (alive() && target.webContents.getURL() === url) { resolve(); return; }
            reject(new Error("应用页面加载超时。"));
            if (alive()) target.webContents.stop();
          }, timeoutMs);
        })
      ]);
    } finally { clearTimeout(timer); }
  }
  function start() {
    if (!alive()) return Promise.resolve(false);
    if (loading) return loading;
    // Creating the first renderer while the native window remains hidden can stall on some
    // Windows software-rendering setups. Display the loading window before navigation.
    present();
    loading = (async () => {
      let error;
      for (let attempt = 1; attempt <= 2 && alive(); attempt += 1) {
        try {
          await navigate();
          if (!alive()) return false;
          if (!target.webContents.getURL()) throw new Error("应用窗口尚未加载页面。");
          reveal();
          return true;
        } catch (cause) {
          error = cause;
          if (!alive()) return false;
          report(cause, attempt);
        }
      }
      if (alive()) { reveal(); failed(error); }
      return false;
    })().finally(() => { loading = null; });
    return loading;
  }
  function reopen() {
    if (!alive()) return Promise.resolve(false);
    if (loading) return loading;
    if (!target.webContents.getURL()) return start();
    reveal();
    return Promise.resolve(true);
  }
  return { start, reopen };
}
