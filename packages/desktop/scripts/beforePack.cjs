'use strict';

const { buildWebClient, bundleDir, verifyBundle } = require('./webClientBundle.cjs');

let prepared = false;

exports.default = function beforePack() {
  // electron-builder invokes this hook per architecture. One fresh source
  // build is enough for the process, but every target must pass validation.
  if (!prepared) {
    buildWebClient();
    prepared = true;
  }
  verifyBundle(bundleDir);
};
