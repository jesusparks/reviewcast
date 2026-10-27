#!/usr/bin/env node
// Prints collector/browser-run.js with the topic lists from collector/process.js filled in.
// Usage: node collector/build-browser.js > /tmp/rc-inject.js
"use strict";
const fs = require("fs");
const path = require("path");
const { THEMES } = require("./process.js");
const src = fs.readFileSync(path.join(__dirname, "browser-run.js"), "utf8");
process.stdout.write(src.replace("const THEMES = __THEMES__;", "const THEMES = " + JSON.stringify(THEMES) + ";"));
