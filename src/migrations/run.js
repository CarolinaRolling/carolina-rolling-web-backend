// Moved: schema migrations now live in src/db/migrations and run with `npm run migrate`
// (and automatically at startup). This old entry point just forwards there.
require('../db/cli.js');
