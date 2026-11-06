"use strict";
/**
 * cPanel "Setup Node.js App" startup file.
 * Application root = this directory (flat deploy) or the parent that contains node/.
 * Listens on process.env.PORT (Passenger).
 *
 * Recommended env in cPanel:
 *   MUSE_PUBLIC=1
 *   MUSE_HTTPS=1
 *   MUSE_BASE=/muse
 *   MUSE_DATA=/home/salemmon/muse/data
 *   MUSE_PASSWORD=…   (set via Secure Form; never commit)
 */
const path = require("path");
const fs = require("fs");

// Sensible defaults for public hosting; cPanel env vars win when set.
if (!process.env.MUSE_PUBLIC) process.env.MUSE_PUBLIC = "1";
if (!process.env.MUSE_HTTPS) process.env.MUSE_HTTPS = "1";
if (!process.env.MUSE_BASE) process.env.MUSE_BASE = "/muse";

const HERE = __dirname;
if (!process.env.MUSE_DATA) {
  process.env.MUSE_DATA = path.join(HERE, "data");
}
fs.mkdirSync(process.env.MUSE_DATA, { recursive: true });

// server.js calls main() on load and listens on PORT / MUSE_PORT.
require("./server.js");
