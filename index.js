const express = require('express');
const fetch = require('node-fetch');
const app = express();

// خواندن دامین هدف از تنظیمات پنل استورم‌کیت
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const SECRET_PATH = "/api/v1/chat/conversation/authenticated";

// لیست سیاه هدرها (دقیقاً مطابق نسخه نیتلیفای شما)
const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "forwarded",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "server", "via"
]);

app.all('*', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ۱. چک کردن تنظیم بودن دامین هدف
  if (!TARGET_BASE) {
    return res.status(503).send("Service Unavailable: TARGET_DOMAIN not set.");
  }

  // ۲. مدیریت مسیرها (فقط مسیر خاص ریلای شود)
  if (!url.pathname.startsWith(SECRET_PATH)) {
    if (url.pathname === "/" || url.pathname === "") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<html><head><title>Chat Service</title></head><body><h1>Service is running</h1></body></html>`);
    }
    return res.status(404).send("Not Found");
  }

  try {
    const targetUrl = TARGET_BASE + url.pathname + url.search;

    // ۳. آماده‌سازی هدرها و پاک‌سازی هدرهای ممنوعه
    const headers = {};
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

    Object.keys(req.headers).forEach(key => {
      const k = key.toLowerCase();
      if (STRIP_HEADERS.has(k) || k.startsWith('x-stormkit-')) return;

      if (k === "user-agent") {
        headers[k] = req.headers[key] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
      } else {
        headers[key] = req.headers[key];
      }
    });

    if (clientIp) headers["x-forwarded-for"] = clientIp;
    headers["x-forwarded-proto"] = "https";

    // ۴. ارسال درخواست به سرور آمازون
    const fetchOptions = {
      method: req.method,
      headers: headers,
      redirect: "manual",
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOptions.body = req; // در نود جی‌اس درخواست خودش یک استریم است
    }

    const upstream = await fetch(targetUrl, fetchOptions);

    // ۵. کپی کردن هدرهای پاسخ و پاک‌سازی هدرهای حساس سرور
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (['server', 'x-powered-by', 'via', 'transfer-encoding'].includes(k)) return;
      res.setHeader(key, value);
    });

    res.status(upstream.status);
    upstream.body.pipe(res); // استریم کردن پاسخ برای سرعت بالاتر

  } catch (error) {
    console.error("Relay error:", error);
    res.status(502).send("Service Unavailable");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Professional Relay targeting: ${TARGET_BASE}`);
});
