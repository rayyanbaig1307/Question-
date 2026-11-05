const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../src');
function filesIn(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(dir, entry.name)] : []); }
const files = filesIn(root);
const routes = files.filter(file => file.startsWith(path.join(root, 'app') + path.sep) && !path.basename(file).startsWith('_')).map(file => {
  const route = path.relative(path.join(root, 'app'), file).replace(/\\/g, '/').replace(/\.tsx?$/, '').split('/').filter(part => !/^\(.*\)$/.test(part));
  if (route.at(-1) === 'index') route.pop();
  return '/' + route.join('/');
});

test('every statically declared app navigation destination names an existing route', () => {
  const destinations = [];
  for (const file of files) {
    const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === 'router' && ['push', 'replace', 'dismissTo', 'navigate'].includes(node.expression.name.text)) {
        function extract(value) {
          if (!value) return;
          if (ts.isStringLiteralLike(value)) destinations.push({ file, route: value.text });
          else if (ts.isTemplateExpression(value)) destinations.push({ file, route: value.head.text + value.templateSpans.map(span => '__id__' + span.literal.text).join('') });
          else if (ts.isConditionalExpression(value)) { extract(value.whenTrue); extract(value.whenFalse); }
          else if (ts.isObjectLiteralExpression(value)) for (const property of value.properties) if (ts.isPropertyAssignment(property) && property.name.getText(ast) === 'pathname') extract(property.initializer);
        }
        extract(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  assert.ok(destinations.length > 80, 'keep checking navigation in screens and reusable components');
  const canonical = route => route.split('?')[0].split('/').filter(Boolean).map(part => /^\[.*\]$/.test(part) || part === '__id__' ? ':id' : part).join('/');
  for (const destination of destinations) {
    const wanted = canonical(destination.route);
    assert.ok(routes.some(route => canonical(route) === wanted), `${path.relative(root, destination.file)} points to missing route ${destination.route}`);
  }
});
