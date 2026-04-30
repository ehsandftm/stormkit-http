const fetch = require("node-fetch");
const https = require("https");

const PUBLIC_PATH = "/api/v1/chat/conversation/authenticated";

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
  "content-encoding",
  "server",
  "via",
  "x-powered-by"
]);

function normalizeOrigin(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value || "";
}

function copyRequestHeaders(req) {
  const headers = {};

  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();

    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-stormkit-")) continue;

    if (typeof value === "undefined") continue;
    headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  if (!headers["user-agent"]) {
    headers["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome Safari";
  }

  headers["x-forwarded-proto"] = "https";

  const existingForwardedFor = getHeader(req, "x-forwarded-for");
  const remoteAddress =
    req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";

  if (existingForwardedFor) {
    headers["x-forwarded-for"] = existingForwardedFor;
  } else if (remoteAddress) {
    headers["x-forwarded-for"] = remoteAddress;
  }

  return headers;
}

function copyResponseHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIP_RESPONSE_HEADERS.has(lower)) return;
    res.setHeader(key, value);
  });
}

module.exports = async function handler(req, res) {
  const targetOrigin = normalizeOrigin(process.env.TARGET_ORIGIN || process.env.TARGET_DOMAIN);
  const allowInsecureUpstream =
    String(process.env.ALLOW_INSECURE_UPSTREAM || "").toLowerCase() === "true";

  try {
    if (!targetOrigin) {
      res.statusCode = 503;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("TARGET_ORIGIN is not set");
      return;
    }

    const incomingUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);

    if (incomingUrl.pathname !== PUBLIC_PATH) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return;
    }

    const targetUrl = `${targetOrigin}${incomingUrl.pathname}${incomingUrl.search}`;
    const method = String(req.method || "GET").toUpperCase();

    const fetchOptions = {
      method,
      headers: copyRequestHeaders(req),
      redirect: "manual",
      compress: false
    };

    if (targetUrl.startsWith("https://") && allowInsecureUpstream) {
      fetchOptions.agent = new https.Agent({
        rejectUnauthorized: false,
        keepAlive: true
      });
    }

    if (method !== "GET" && method !== "HEAD") {
      fetchOptions.body = req;
    }

    console.log("proxy", method, targetUrl);

    const upstream = await fetch(targetUrl, fetchOptions);

    res.statusCode = upstream.status;
    copyResponseHeaders(upstream, res);

    if (upstream.body) {
      upstream.body.on("error", function () {
        try {
          res.end();
        } catch (_) {}
      });

      upstream.body.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    console.error("proxy error:", error && error.stack ? error.stack : error);

    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain; charset=utf-8");
    }

    res.end("Bad Gateway");
  }
};
