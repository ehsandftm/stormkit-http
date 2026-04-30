const { Readable } = require("node:stream");

const TARGET_BASE = String(process.env.TARGET_DOMAIN || process.env.TARGET_ORIGIN || "")
  .trim()
  .replace(/\/+$/, "");

const SECRET_PATH = "/api/v1/chat/conversation/authenticated";

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "server",
  "x-powered-by",
  "via",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor"
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "server",
  "x-powered-by",
  "via"
]);

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

function copyHeadersFromRequest(req) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();

    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-stormkit-")) continue;
    if (typeof value === "undefined") continue;

    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }

  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome Safari"
    );
  }

  const forwardedFor = req.headers["x-forwarded-for"];
  const remoteAddress = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";

  if (forwardedFor) {
    headers.set(
      "x-forwarded-for",
      Array.isArray(forwardedFor) ? forwardedFor.join(", ") : String(forwardedFor)
    );
  } else if (remoteAddress) {
    headers.set("x-forwarded-for", remoteAddress);
  }

  headers.set("x-forwarded-proto", "https");

  return headers;
}

function copyHeadersToResponse(upstreamHeaders, res) {
  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();

    if (STRIP_RESPONSE_HEADERS.has(lower)) return;

    try {
      res.setHeader(key, value);
    } catch (_) {}
  });
}

function pipeWebResponseToNodeResponse(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeReadable = Readable.fromWeb(upstream.body);

  nodeReadable.on("error", function (err) {
    console.error("upstream body stream error:", err && err.message ? err.message : err);
    try {
      res.end();
    } catch (_) {}
  });

  nodeReadable.pipe(res);
}

module.exports = async function handler(req, res) {
  try {
    if (!TARGET_BASE) {
      return sendText(res, 503, "TARGET_DOMAIN is not set");
    }

    if (!TARGET_BASE.startsWith("https://") && !TARGET_BASE.startsWith("http://")) {
      return sendText(res, 503, "TARGET_DOMAIN must start with http:// or https://");
    }

    if (typeof fetch !== "function") {
      return sendText(res, 500, "Native fetch is not available in this runtime");
    }

    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);

    if (!url.pathname.startsWith(SECRET_PATH)) {
      if (url.pathname === "/" || url.pathname === "") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<!doctype html><html><body><h1>Stormkit relay running</h1></body></html>");
        return;
      }

      return sendText(res, 404, "Not Found");
    }

    if (url.searchParams.get("relay_debug") === "1") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify(
          {
            ok: true,
            route: "matched",
            method: req.method,
            targetBase: TARGET_BASE,
            path: url.pathname,
            note: "This only checks Stormkit route matching, not the VLESS/xhttp stream."
          },
          null,
          2
        )
      );
      return;
    }

    const targetUrl = TARGET_BASE + url.pathname + url.search;
    const method = String(req.method || "GET").toUpperCase();

    const fetchOptions = {
      method,
      headers: copyHeadersFromRequest(req),
      redirect: "manual"
    };

    if (method !== "GET" && method !== "HEAD") {
      fetchOptions.body = Readable.toWeb(req);
      fetchOptions.duplex = "half";
    }

    console.log("relay:", method, targetUrl);

    const upstream = await fetch(targetUrl, fetchOptions);

    res.statusCode = upstream.status;
    copyHeadersToResponse(upstream.headers, res);
    pipeWebResponseToNodeResponse(upstream, res);
  } catch (err) {
    console.error("relay error:", err && err.stack ? err.stack : err);

    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain; charset=utf-8");
    }

    res.end("Service Unavailable");
  }
};
