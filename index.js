const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// آدرس سرور اصلی آمازون شما به همراه پورت کانفیگ X-UI
const TARGET_URL = 'http://fr2.firmware-update-service.com:8080';

// تنظیمات پروکسی برای انتقال تمام ترافیک (HTTP و WebSocket)
app.use('/', createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    ws: true, // بسیار مهم: فعال‌سازی وب‌سوکت برای ترافیک V2ray
    logLevel: 'silent',
    onProxyReq: (proxyReq, req, res) => {
        // انتقال هدرهای واقعی کلاینت به سرور آمازون برای جلوگیری از مسدودی
        if (req.headers['x-forwarded-for']) {
            proxyReq.setHeader('x-forwarded-for', req.headers['x-forwarded-for']);
        }
        if (req.headers['x-real-ip']) {
            proxyReq.setHeader('x-real-ip', req.headers['x-real-ip']);
        }
    },
    onError: (err, req, res) => {
        console.error('Relay Error:', err.message);
        res.status(500).send('Relay Connection Failed.');
    }
}));

// استورم‌کیت و سایر پلتفرم‌های ابری، پورت را از طریق متغیر محیطی اختصاص می‌دهند
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Stormkit Relay is actively listening on port ${PORT}`);
});

module.exports = app;