const http = require('http');
const handler = require('./api/callback.js');

const PORT = process.env.PORT || 10000;

function wrapRes(rawRes) {
  rawRes.status = function(code) {
    this.statusCode = code;
    return this;
  };
  rawRes.json = function(data) {
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
  };
  rawRes.send = function(data) {
    this.end(String(data));
  };
  return rawRes;
}

const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      req.body = body ? JSON.parse(body) : {};
    } catch (e) {
      req.body = {};
    }
    try {
      await handler(req, wrapRes(res));
    } catch (err) {
      console.error('Handler error:', err.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`BruceBot AI running on port ${PORT}`);
});
