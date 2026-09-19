const helpers = require("./utils/math");

function legacyTotal(items: unknown[]): number {
  return helpers.calculateTotal(items);
}

module.exports = { legacyTotal };
