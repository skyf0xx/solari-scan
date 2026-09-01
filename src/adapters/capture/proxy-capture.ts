/**
 * The forwarding proxy half of `CapturePort`: a Python stdlib HTTP/HTTPS
 * forwarding proxy (CONNECT-capable for HTTPS, plain-forward for HTTP) that
 * runs *inside* the Solari sandbox — not on the machine running the CLI.
 *
 * ============================================================================
 * WHY IN-GUEST, NOT LOCAL — AND WHAT THIS FIXES
 * ============================================================================
 * An earlier version of this file ran the proxy as a local Node server on
 * the CLI's own machine, relying on the sandbox's outbound traffic being
 * able to route back to it — a reachability path that was never confirmed
 * against Solari's actual sandbox network model. This version sidesteps the
 * question entirely: the proxy process and the install/build commands that
 * use it both run inside the same guest, in the same network namespace, so
 * "can the guest reach the proxy" stops being a question — loopback
 * (127.0.0.1) always works between two processes in the same sandbox. This
 * part is guaranteed by construction, not by an assumption about Solari's
 * network topology.
 *
 * What is NOT independently reverified here: that `SessionHandle.files.write`
 * and `SessionHandle.commands.start` behave, against a real sandbox, exactly
 * as `@solarisdk/core`'s `dist/handle.d.ts` types say (background start
 * returns promptly with a live handle; `onData` delivers stdout chunks as
 * they're written, not only after the process exits or a large buffer
 * fills). Those are the SDK's own documented contracts, already relied on
 * by `sandbox-adapter`, but this layer's `startProxy()` readiness-wait
 * depends on `onData` actually streaming — untested against a live sandbox
 * in this session, only against the fakes in `proxy-capture.test.ts`.
 * ============================================================================
 *
 * Written in Python (stdlib only: `http.server`, `socketserver`, `socket`)
 * rather than Node, deliberately: the sandbox belongs to whatever repo is
 * being scanned, which may not have Node available (or may have a Node
 * version this script can't assume), whereas Python 3's stdlib needs no
 * install and is a safer baseline dependency for a script that has to run
 * inside an arbitrary target repo's guest.
 */

import type { ObservedConnection } from "../../domain/ports.js";
import { CaptureAdapterError } from "./errors.js";
import type { SandboxCommandHandle, SandboxGuestAccess } from "./sandbox-files.js";

/** Where the proxy script is uploaded inside the guest. Under `/tmp`, not
 *  under the repo checkout (`domain/scan.ts`'s `REPO_DIR`, "repo") — this
 *  file has nothing to do with the repo being scanned and must not be
 *  swept up by its own filesystem-change detection or collide with
 *  anything the repo's build writes. Exported so `filesystem-capture.ts`'s
 *  `diffFilesystem` can exclude it — confirmed live that without this
 *  exclusion, this path itself always appears as a false-positive
 *  "created" finding on every scan, since it's written (by `startProxy()`,
 *  below) after the baseline snapshot is taken but before the post-run one. */
export const PROXY_SCRIPT_PATH = "/tmp/solari-scan-proxy.py";

/** Where the proxy logs every distinct destination host it sees, one per
 *  line. Same rationale as `PROXY_SCRIPT_PATH` for living under `/tmp`, and
 *  exported for the same reason. */
export const PROXY_LOG_PATH = "/tmp/solari-scan-proxy.log";

/** Stdout line the script prints exactly once, right after it binds its
 *  listening socket and before it starts serving — the signal `startProxy()`
 *  waits for instead of guessing at an arbitrary startup delay. */
const LISTENING_PREFIX = "LISTENING:";

/** How long `startProxy()` waits for the `LISTENING:<port>` line before
 *  giving up and treating startup as failed. */
const STARTUP_TIMEOUT_MS = 10_000;

/**
 * The Python proxy script's full source, uploaded to `PROXY_SCRIPT_PATH`
 * and run with `python3` as a background command inside the guest. CONNECT
 * requests are tunneled via a raw `socket` to the target host:port on two
 * pump threads; plain HTTP requests are re-issued via `urllib.request` to
 * the target's absolute-form URL. Every distinct destination host, on
 * either path, is appended to `PROXY_LOG_PATH`.
 */
const PROXY_SCRIPT_SOURCE = `import http.server
import socket
import socketserver
import threading
import urllib.error
import urllib.request
from urllib.parse import urlparse

LOG_PATH = ${JSON.stringify(PROXY_LOG_PATH)}
_log_lock = threading.Lock()


def _log_host(host):
    if not host:
        return
    with _log_lock:
        with open(LOG_PATH, "a") as f:
            f.write(host + "\\n")


def _host_only(hostport):
    if hostport.startswith("["):
        return hostport.split("]")[0][1:]
    return hostport.rsplit(":", 1)[0] if ":" in hostport else hostport


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_CONNECT(self):
        target = self.path
        host = _host_only(target)
        try:
            port_str = target.rsplit(":", 1)[1] if ":" in target and not target.startswith("[") else "443"
            port = int(port_str)
        except (IndexError, ValueError):
            port = 443

        _log_host(host)

        try:
            upstream = socket.create_connection((host, port), timeout=10)
        except OSError:
            self.send_error(502, "Could not connect to upstream")
            return

        self.send_response(200, "Connection Established")
        self.end_headers()

        self._tunnel(self.connection, upstream)

    def _tunnel(self, client_socket, upstream):
        def pipe(src, dst):
            try:
                while True:
                    data = src.recv(8192)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        t1 = threading.Thread(target=pipe, args=(client_socket, upstream), daemon=True)
        t2 = threading.Thread(target=pipe, args=(upstream, client_socket), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        try:
            upstream.close()
        except OSError:
            pass

    def _forward(self, method):
        url = self.path
        if not (url.startswith("http://") or url.startswith("https://")):
            host = self.headers.get("Host")
            if not host:
                self.send_error(400, "No target host")
                return
            url = "http://" + host + url

        parsed = urlparse(url)
        _log_host(parsed.hostname)

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None

        headers = {k: v for k, v in self.headers.items() if k.lower() not in ("proxy-connection", "connection")}

        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                self.send_response(resp.status)
                for k, v in resp.getheaders():
                    if k.lower() in ("transfer-encoding", "connection"):
                        continue
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(resp.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read() if e.fp else b"")
        except OSError:
            self.send_error(502, "Upstream request failed")

    def do_GET(self):
        self._forward("GET")

    def do_POST(self):
        self._forward("POST")

    def do_PUT(self):
        self._forward("PUT")

    def do_DELETE(self):
        self._forward("DELETE")

    def do_HEAD(self):
        self._forward("HEAD")

    def do_PATCH(self):
        self._forward("PATCH")


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ProxyHandler)
    port = server.server_address[1]
    print("${LISTENING_PREFIX}%d" % port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
`;

function distinctHostsFromLog(logText: string): ObservedConnection[] {
  const hosts = new Set<string>();
  for (const line of logText.split("\n")) {
    const host = line.trim();
    if (host) {
      hosts.add(host);
    }
  }
  return Array.from(hosts).map((host) => ({ host }));
}

/**
 * Runs the Python forwarding proxy as a background process inside the
 * Solari sandbox, via the injected `SandboxGuestAccess`. `startProxy()`
 * uploads the script, starts it, and waits for its `LISTENING:<port>`
 * stdout line rather than sleeping an arbitrary delay; `stopProxy()` kills
 * the process and reads back its log of observed destination hosts.
 */
export class ProxyCaptureAdapter {
  private command: SandboxCommandHandle | undefined;

  constructor(private readonly guest: SandboxGuestAccess) {}

  async startProxy(): Promise<{ port: number; env: Record<string, string> }> {
    if (this.command) {
      throw new CaptureAdapterError("startProxy() called while a proxy is already running.");
    }

    try {
      await this.guest.write(PROXY_SCRIPT_PATH, PROXY_SCRIPT_SOURCE);
    } catch (err) {
      throw new CaptureAdapterError("Failed to write the proxy script into the sandbox.", { cause: err });
    }

    let command: SandboxCommandHandle;
    try {
      command = await this.guest.start("python3", { args: [PROXY_SCRIPT_PATH], background: true });
    } catch (err) {
      throw new CaptureAdapterError("Failed to start the proxy process inside the sandbox.", { cause: err });
    }

    const port = await this.waitForListening(command);
    this.command = command;

    const proxyUrl = `http://127.0.0.1:${port}`;
    return { port, env: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } };
  }

  private waitForListening(command: SandboxCommandHandle): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(
          new CaptureAdapterError(
            `Proxy process did not report "${LISTENING_PREFIX}<port>" within ${STARTUP_TIMEOUT_MS}ms.`,
          ),
        );
      }, STARTUP_TIMEOUT_MS);

      command.onData((chunk) => {
        if (settled || chunk.stream !== "stdout") {
          return;
        }
        stdoutBuffer += chunk.data;

        const lines = stdoutBuffer.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith(LISTENING_PREFIX)) {
            continue;
          }
          const port = Number(trimmed.slice(LISTENING_PREFIX.length));
          if (!Number.isInteger(port) || port <= 0) {
            continue;
          }
          settled = true;
          clearTimeout(timer);
          resolve(port);
          return;
        }
      });

      command
        .wait()
        .then((exitCode) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(
            new CaptureAdapterError(`Proxy process exited with code ${exitCode} before reporting readiness.`),
          );
        })
        .catch((err: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(new CaptureAdapterError("Proxy process failed before reporting readiness.", { cause: err }));
        });
    });
  }

  async stopProxy(): Promise<ObservedConnection[]> {
    const command = this.command;
    if (!command) {
      throw new CaptureAdapterError("stopProxy() called before startProxy() succeeded.");
    }
    this.command = undefined;

    try {
      await command.kill();
    } catch (err) {
      throw new CaptureAdapterError("Failed to stop the proxy process inside the sandbox.", { cause: err });
    }

    let logBytes: Uint8Array;
    try {
      logBytes = await this.guest.read(PROXY_LOG_PATH);
    } catch {
      // The proxy never received traffic, so it never wrote a log file —
      // zero observed connections, not an error.
      return [];
    }

    const logText = Buffer.from(logBytes).toString("utf8");
    return distinctHostsFromLog(logText);
  }
}
