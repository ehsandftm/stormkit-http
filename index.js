import express from "express";
import fetch from "node-fetch";

const app = express();

// --- Config ---
const PORT = process.env.PORT || 3000;

// Your upstream target (must be set in Stormkit env vars)
const TARGET_DOMAIN = process.env.TARGET_DOMAIN;

// This is the only path that is allowed to be proxied (as in your current code)
const SECRET_PATH = "/api/v1/chat/conversation/authenticated";

// --- Helpers ---
function normalizeTarget(target) {
  // Ensure TARGET_DOMAIN exists and does not end with slash
  if (!target || typeof target !== "string") return null;
  return target.endsWith("/") ? target.slice(0, -1) : target;
}

const NORMALIZED_TARGET = normalizeTarget(TARGET_DOMAIN);

function buildUpstreamUrl(req) {
  // Full requested URL (path + query)
  const incomingUrl = new URL(req.originalUrl, `http://${req.headers.host || "localhost"}`);

  // IMPORTANT:
  // We keep the incoming path/query exactly and just swap the origin to TARGET_DOMAIN.
  // Example: https://fr2...:8080 + /api/v1/... ?x=1
  const upstream = new URL(NORMALIZED_TARGET + incomingUrl.pathname + incomingUrl.search);
  return upstream.toString();
}

function pickHeaders(req) {
  // Forward most headers, but remove hop-by-hop / unsafe ones.
  const headers = { ...req.headers };

  // These can cause issues when proxying
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  delete headers["accept-encoding"]; // avoid gzip/br complications, let node-fetch handle
  delete headers["if-none-match"];
  delete headers["if-modified-since"];

  return headers;
}

// --- Middlewares ---
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Basic access log for debugging (Stormkit runtime logs)
app.use((req, res, next) => {
  console.log("REQ", req.method, req.url);
  next();
});

// --- Health & platform routes (prevent Stormkit from showing 404/unhealthy) ---
app.get("/", (req, res) => {
  res.status(200).send("Service is running");
});

app.get("/healthz", (req, res) => {
  res.status(200).send("ok");
});

app.get("/favicon.ico", (req, res) => {
  // No favicon, but return a valid response
  res.status(204).end();
});

// --- Main proxy handler ---
app.all("*", async (req, res) => {
  try {
    if (!NORMALIZED_TARGET) {
      return res.status(500).send("TARGET_DOMAIN is not set");
    }

    const incomingUrl = new URL(req.originalUrl, `http://${req.headers.host || "localhost"}`);
    const path = incomingUrl.pathname;

    // Allow GETs that Stormkit or browsers might do, so you don't see 404 in dashboard
    // But do NOT proxy them upstream unless they match SECRET_PATH.
    if (!path.startsWith(SECRET_PATH)) {
      // Return 200 for simple GET requests (platform checks, browser, etc.)
      if (req.method === "GET") {
        // If you prefer strict mode, change this to 404.
        return res.status(200).send("OK");
      }
      return res.status(404).send("Not Found");
    }

    // Build upstream URL
    const upstreamUrl = buildUpstreamUrl(req);

    // Prepare body
    const method = req.method.toUpperCase();
    const headers = pickHeaders(req);

    let body = undefined;

    // Only attach body for methods that can have it
    if (method !== "GET" && method !== "HEAD") {
      // If content-type is JSON or urlencoded, express has parsed it. Re-serialize.
      // If it's something else, fallback to raw handling is not present here (same as your code).
      if (req.is("application/json")) {
        body = JSON.stringify(req.body ?? {});
        headers["content-type"] = "application/json";
      } else if (req.is("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams(req.body).toString();
        body = params;
        headers["content-type"] = "application/x-www-form-urlencoded";
      } else {
        // Best effort: if body is already object, stringify; otherwise send as-is
        // (If you need true raw streaming for binary/multipart, tell me تا برات دقیقش کنم)
        body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
      }
    }

    console.log("PROXY ->", method, upstreamUrl);

    const upstreamResp = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      redirect: "manual",
    });

    // Copy status
    res.status(upstreamResp.status);

    // Copy headers (careful with some hop-by-hop)
    upstreamResp.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "transfer-encoding") return;
      if (k === "content-encoding") return;
      if (k === "content-length") return;
      res.setHeader(key, value);
    });

    // Pipe body
    const buffer = Buffer.from(await upstreamResp.arrayBuffer());
    return res.send(buffer);
  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).send("Internal Server Error");
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  console.log("TARGET_DOMAIN:", NORMALIZED_TARGET || "(not set)");
  console.log("SECRET_PATH:", SECRET_PATH);
});
