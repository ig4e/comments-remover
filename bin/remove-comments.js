#!/usr/bin/env node
const { runFromArgs } = require('../lib/cli');

(async () => {
  try {
    const exitCode = await runFromArgs(process.argv.slice(2));
    process.exit(exitCode || 0);
  } catch (err) {
    console.error(err);
    process.exit(2);
  }
})();
