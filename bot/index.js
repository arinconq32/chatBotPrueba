const { createFlow } = require("@builderbot/bot");
const { flowMenu, flowSoporte, flowVentas } = require("./flows");

const flow = createFlow([flowMenu, flowSoporte, flowVentas]);

module.exports = { flow };
