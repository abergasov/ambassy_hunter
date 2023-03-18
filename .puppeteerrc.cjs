const {join} = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
    experiments: {
        macArmChromiumEnabled: true,
    },
    // Changes the cache location for Puppeteer.
    cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};