// The native close listener must prevent its automatic destroy while we flush the engine.
export function createCloseController({ isBusy, confirm, shutdown, disconnect, destroy, onError }) {
  let pending = null;
  const quit = () => {
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      try { await shutdown(); await disconnect(); await destroy(); return true; }
      catch (error) { onError(error); return false; }
    }).finally(() => { pending = null; });
    return pending;
  };
  const request = async (event) => {
    event.preventDefault();
    if (isBusy()) { confirm(); return false; }
    return quit();
  };
  return { request, quit };
}
