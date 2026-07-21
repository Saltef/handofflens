#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.REVIEW_PORT || 4173);
const allowed = new Set([
  "/review.html",
  "/review.css",
  "/review.js",
  "/results/atomic-clinician-review-packet.json"
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname === "/" ? "/review.html" : url.pathname;
  if (!allowed.has(pathname)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const filePath = path.resolve(root, pathname.slice(1));
  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Atomic review interface: http://127.0.0.1:${port}`);
});
