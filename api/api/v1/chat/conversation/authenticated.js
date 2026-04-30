const fetch = require("node-fetch");
const https = require("https");

const PUBLIC_PATH = "/api/v1/chat/conversation/authenticated";

const TARGET_DOMAIN = String(process.env.TARGET_DOMAIN || process.env.TARGET_ORIGIN || "")
  .trim()
  .replace(/\/+$/, "");

const UPSTREAM_HOST = String(process.env.UPSTREAM_HOST || "").trim();
const UPSTREAM_SERVERNAME = String(process.env.UPSTREAM_SERVERNAME || "").trim();

const ALLOW_INSECURE_UPSTREAM =
  String(process.env.ALLOW_INSECURE_UPSTREAM || "").toLowerCase() === "true";

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
  "server",
  "via",
  "x-powered-by"
]);

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

function copyRequestHeaders(req) {
  const headers = {};

  for (const [key, value] of Object.entries(req.headers || {})) {
    const lower = key.toLowerCase();

    if (STRIP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-stormkit-")) continue;

    headers[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  if (!headers["user-agent"]) {
    headers["user-agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome Safari";
  }

  if (UPSTREAM_HOST) {
    headers["host"] = UPSTREAM_HOST;
  }

  const existingForwardedFor = req.headers["x-forwarded-for"];
  const remoteAddress =
    req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";

  if (existingForwardedFor) {
    headers["x-forwarded-for"] = Array.isArray(existingForwardedFor)
      ? existingForwardedFor.join(", ")
      : String(existingForwardedFor);
  } else if (remoteAddress) {
    headers["x-forwarded-for"] = remoteAddress;
  }

  headers["x-forwarded-proto"] = "https";

  return headers;
}

function copyResponseHeaders(upstream, res) {
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();

    if (STRIP_RESPONSE_HEADERS.has(lower)) return;

    res.setHeader(key, value);
  });
}

function makeAgent(targetUrl) {
  if (!targetUrl.startsWith("https://")) return undefined;

  const hostname = new URL(targetUrl).hostname;

  return new https.Agent({
    keepAlive: true,
    rejectUnauthorized: !ALLOW_INSECURE_UPSTREAM,
    servername: UPSTREAM_SERVERNAME || UPSTREAM_HOST || hostname
  });
}

module.exports = async function handler(req, res) {
  try {
    if (!TARGET_DOMAIN) {
      return sendText(
        res,
        503,
        "TARGET_DOMAIN is not set. Set TARGET_DOMAIN in Stormkit Environment Variables."
      );
    }

    if (!TARGET_DOMAIN.startsWith("http://") && !TARGET_DOMAIN.startsWith("https://")) {
      return sendText(
        res,
        503,
        "TARGET_DOMAIN must start with http:// or https://"
      );
    }

    const incomingUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);

    if (incomingUrl.pathname !== PUBLIC_PATH) {
      return sendText(res, 404, "Not Found from relay handler");
    }

    if (incomingUrl.searchParams.get("relay_debug") === "1") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify(
          {
            ok: true,
            route: "matched",
            publicPath: PUBLIC_PATH,
            method: req.method,
            targetDomainConfigured: Boolean(TARGET_DOMAIN),
            upstreamHostConfigured: Boolean(UPSTREAM_HOST),
            upstreamServernameConfigured: Boolean(UPSTREAM_SERVERNAME),
            allowInsecureUpstream: ALLOW_INSECURE_UPSTREAM
          },
          null,
          2
        )
      );
      return;
    }

    const targetUrl = `${TARGET_DOMAIN}${incomingUrl.pathname}${incomingUrl.search}`;
    const method = String(req.method || "GET").toUpperCase();

    const fetchOptions = {
      method,
      headers: copyRequestHeaders(req),
      redirect: "manual",
      compress: false,
      agent: makeAgent(targetUrl)
    };

    if (method !== "GET" && method !== "HEAD") {
      fetchOptions.body = req;
    }

    console.log("relay:", method, targetUrl);

    const upstream = await fetch(targetUrl, fetchOptions);

    res.statusCode = upstream.status;
    copyResponseHeaders(upstream, res);

    if (upstream.body) {
      upstream.body.on("error", function (err) {
        console.error("upstream body error:", err);
        try {
          res.end();
        } catch (_) {}
      });

      upstream.body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("relay error:", err && err.stack ? err.stack : err);

    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain; charset=utf-8");
    }

    res.end("Bad Gateway from relay");
  }
};
