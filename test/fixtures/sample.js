const path = require("path");

class Logger {
  constructor(prefix) {
    this.prefix = prefix;
  }

  log(message) {
    console.log(`${this.prefix}: ${message}`);
  }
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

module.exports = { Logger, formatDate };
