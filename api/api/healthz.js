module.exports = async function handler(req, res) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("api-ok");
};
