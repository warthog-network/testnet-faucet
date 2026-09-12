// scripts/find-free-port.cjs
//
// `npm run dev` shells out via PORT=$(node scripts/find-free-port.cjs) so
// stdout must be a bare integer port number. We prefer 3001 (the README's
// documented dev default) and walk up; if that window is full we let the OS
// assign. Exit 0 on success, non-zero if no port is obtainable.

const net = require("net");

const PREFERRED_START = 3001;
const PREFERRED_END = 3010;
const HOST = "127.0.0.1";

function tryBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve({ ok: false, server: null }));
    server.once("listening", () => resolve({ ok: true, server }));
    server.listen(port, HOST);
  });
}

(async () => {
  for (let port = PREFERRED_START; port <= PREFERRED_END; port++) {
    const { ok, server } = await tryBind(port);
    if (ok) {
      const assigned = server.address().port;
      await new Promise((r) => server.close(r));
      process.stdout.write(String(assigned));
      process.exit(0);
    }
  }
  const { ok, server } = await tryBind(0);
  if (!ok) process.exit(1);
  const assigned = server.address().port;
  await new Promise((r) => server.close(r));
  process.stdout.write(String(assigned));
})();
