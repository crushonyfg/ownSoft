// Long-running model turns expire only after a period with no activity from that turn.
export function inactivityTimeout(milliseconds, expire) {
  let timer;
  let closed = false;
  const touch = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(expire, milliseconds);
  };
  touch();
  return {
    touch,
    close() {
      closed = true;
      clearTimeout(timer);
    }
  };
}
