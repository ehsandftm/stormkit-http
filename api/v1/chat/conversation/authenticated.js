const fetch = require("node-fetch");

// مسیر مجاز (همونی که تو کانفیگ VLESS گذاشتی)
const SECRET_PATH = "/api/v1/chat/conversation/authenticated";

// لیست سیاه هدرها (تقریباً همون چیزی که خودت داشتی)
const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "server",
  "via"
]);

function normalizeTarget(target) {
  if (!target || typeof target !== "string") return "";
  return target.replace(/\/$/, "");
}

module.exports = async function handler(req, res) {
  const TARGET_BASE = normalizeTarget(process.env.TARGET_DOMAIN);

  // 1) چک env
  if (!TARGET_BASE) {
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    return res.end("Service Unavailable: TARGET_DOMAIN not set.");
  }

  // 2) چک مسیر (برای اطمینان)
  // در Stormkit این فایل دقیقاً روی همین مسیر مپ میشه، ولی این چک رو نگه می‌داریم.
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (!url.pathname.startsWith(SECRET_PATH)) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      return res.end("Not Found");
    }

    // 3) ساخت URL مقصد
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    // 4) آماده‌سازی هدرها
    const headers = {};
    const clientIp =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      (req.socket && req.socket.remoteAddress) ||
      "";

    for (const key of Object.keys(req.headers)) {
      const k = key.toLowerCase();
      if (STRIP_HEADERS.has(k)) continue;
      if (k.startsWith("x-stormkit-")) continue;

      // user-agent رو اگر خالی بود ست کن
      if (k === "user-agent") {
        headers[k] =
          req.headers[key] ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari";
        continue;
      }

      headers[key] = req.headers[key];
    }

    if (clientIp) headers["x-forwarded-for"] = clientIp;
    headers["x-forwarded-proto"] = "https";

    // 5) ارسال درخواست به upstream
    const fetchOptions = {
      method: req.method,
      headers,
      redirect: "manual"
    };

    // مهم: برای POST/PUT/... بدنه را استریم کن (مثل نسخه خودت)
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = req;
    }

    const upstream = await fetch(targetUrl, fetchOptions);

    // 6) کپی هدرهای پاسخ
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (["server", "x-powered-by", "via", "transfer-encoding"].includes(k)) return;
      res.setHeader(key, value);
    });

    // 7) استاتوس و استریم پاسخ
    res.statusCode = upstream.status;

    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Service Unavailable");
  }
};
