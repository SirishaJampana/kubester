// Loads the browser scripts into Node's global scope (they are plain <script> files).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FILES = ['js/vendor/js-yaml.min.js', 'js/util.js', 'js/runtime.js', 'js/cluster.js', 'js/controllers.js', 'js/kubelet.js', 'js/describe.js', 'js/explain.js', 'js/kubectl.js', 'js/helm.js', 'js/lesson-files.js', 'js/shell.js', 'js/guide-data.js', 'js/lessons.js'];
module.exports = function load(only) {
  for (const f of FILES) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    if (only && !only.includes(f)) continue;
    vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  }
  return globalThis.KS;
};
