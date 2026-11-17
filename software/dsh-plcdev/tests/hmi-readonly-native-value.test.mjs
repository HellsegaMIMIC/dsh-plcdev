import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildTools, packages } from './dependencies.mjs';
const { build } = buildTools;
const { JSDOM } = packages('jsdom');

const root = fileURLToPath(new URL('../../../', import.meta.url));
const nativeFile = path.join(root, '.tools/fuxa/FUXA-1.3.5/client/src/app/gauges/controls/value/value.component.ts');
const available = await access(nativeFile).then(() => true, () => false);

// Build through the real saved-revision candidate adapter, in disposable copies.
// No TaskService, model, editor, native server, Runtime or hardware is started.
function candidates() {
  const source = String.raw`
import copy, json
from pathlib import Path
from tools.test_workbench_project_inspection import ProjectInspectionTests, dump
from workbench_agent_adapters import AgentAdapters, _snapshot
from workbench_hmi_value import value_targets
from workbench_projects import read_user_project
fixture = ProjectInspectionTests()
fixture.setUp()
try:
    original = json.loads(fixture.hmi.read_text(encoding='utf-8'))
    adapter = AgentAdapters(state_root=fixture.home/'value-candidates')
    output = []
    for restricted in (False, True):
        before = copy.deepcopy(original)
        view = before['hmi']['views'][0]
        template = next(item for item in view['items'].values() if item.get('property',{}).get('variableId') == 'plcdev_countDisplay')
        if restricted:
            template['hide'] = True
            template['property']['permission'] = 2
            template['property']['permissionRoles'] = {'show':['engineer'], 'enabled':['engineer']}
        else:
            template['hide'] = False
            template['property']['permission'] = 0
            template['property']['permissionRoles'] = {'show':[], 'enabled':[]}
        dump(fixture.hmi, before)
        project = read_user_project(fixture.project['manifestPath'])
        baseline = _snapshot(project)
        target = next(row for row in value_targets(project) if row['signalId'] == 'count')
        request = '在画面 ID“' + target['viewId'] + '”添加信号 ID“count”的只读数值显示。'
        candidate = adapter.propose_hmi_readonly_value(project, task_id='native-value-'+str(restricted),
            expected_revision=baseline['projectRevision'], view_id=target['viewId'], signal_id='count', request=request)
        result = read_user_project(candidate['candidateManifest'])
        after = json.loads(Path(result['hmi']).read_text(encoding='utf-8'))
        assert _snapshot(project) == baseline, 'Native candidate changed its source'
        output.append({'restricted':restricted,'before':before,'after':after,'viewId':target['viewId'],'templateId':template['id']})
    print(json.dumps(output))
finally:
    fixture.tearDown()
`;
  const result = spawnSync(process.env.PLCDEV_TEST_PYTHON || 'python', ['-c', source], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('actual FUXA ValueComponent updates generated public/private displays without changing old node structure',
  { skip: !available && 'Installed FUXA 1.3.5 TypeScript source is not present', timeout: 90000 }, async t => {
    const source = await readFile(nativeFile, 'utf8');
    const compiled = await build({ stdin: { contents: source, loader: 'ts', sourcefile: nativeFile },
      write: false, bundle: false, format: 'cjs', target: 'es2022',
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
    const errors = [];
    class GaugeBaseComponent {
      static getUnit() { return undefined; }
      static getDigits() { return undefined; }
    }
    const mocks = {
      '@angular/core': { Component: () => value => value },
      '../../gauge-base/gauge-base.component': { GaugeBaseComponent },
      '../../../_models/hmi': { GaugeActionsType: { hide: 'hide', show: 'show', blink: 'blink' } },
      '../../gauge-property/gauge-property.component': { GaugeDialogType: { ValueAndUnit: 'value' } },
      '../../../_helpers/utils': { Utils: { toFiniteNumber: value => Number.isFinite(Number(value)) ? Number(value) : null } },
    };
    const module = { exports: {} };
    vm.runInNewContext(compiled.outputFiles[0].text, {
      module, exports: module.exports,
      require(name) { assert.ok(Object.hasOwn(mocks, name), 'Unexpected native import ' + name); return mocks[name]; },
      console: { error(...values) { errors.push(values.map(String).join(' ')); } },
    }, { filename: nativeFile, timeout: 3000 });
    const { ValueComponent } = module.exports;
    assert.equal(typeof ValueComponent.processValue, 'function');
    t.diagnostic('Native FUXA source SHA256: ' + createHash('sha256').update(source).digest('hex'));
    for (const fixture of candidates()) {
      const before = fixture.before.hmi.views.find(view => view.id === fixture.viewId);
      const after = fixture.after.hmi.views.find(view => view.id === fixture.viewId);
      const beforeDom = new JSDOM(before.svgcontent, { contentType: 'image/svg+xml' });
      const afterDom = new JSDOM(after.svgcontent, { contentType: 'image/svg+xml' });
      try {
        const original = beforeDom.window.document, document = afterDom.window.document;
        const added = Object.keys(after.items).filter(id => !Object.hasOwn(before.items, id));
        assert.equal(added.length, 1);
        const id = added[0], item = after.items[id], element = document.getElementById(id);
        assert.equal(element.children.length, 1, 'Native processValue requires one child');
        assert.equal(element.children[0].id, 'value_' + id);
        assert.deepEqual(item.property, before.items[fixture.templateId].property, 'Keep all native access and binding properties');
        assert.equal(item.hide, before.items[fixture.templateId].hide);
        assert.deepEqual(fixture.after.devices, fixture.before.devices);
        for (const old of Object.values(before.items)) {
          assert.deepEqual(after.items[old.id], old, 'Existing metadata changed: ' + old.id);
          const oldBefore = original.getElementById(old.id), oldAfter = document.getElementById(old.id);
          assert.equal(oldAfter.children.length, oldBefore.children.length, 'Existing control child count changed: ' + old.id);
          assert.deepEqual([...oldAfter.children].map(node => node.id), [...oldBefore.children].map(node => node.id));
        }
        const caption = document.getElementById('PLCD_readcaption_' + id.slice(-16));
        assert.equal(!!caption, !fixture.restricted, 'Only explicitly public display has an independent caption');
        const captionText = caption?.textContent;
        const oldCount = after.items[fixture.templateId], oldCountNode = document.getElementById(fixture.templateId);
        for (const value of [0, 1, 2, 3]) {
          ValueComponent.processValue(item, { node: element }, { id: item.property.variableId, value }, {});
          assert.equal(element.children[0].textContent, String(value), 'New display did not update');
          ValueComponent.processValue(oldCount, { node: oldCountNode }, { id: oldCount.property.variableId, value }, {});
          assert.equal(oldCountNode.children[0].textContent, String(value), 'Existing display stopped updating');
          assert.equal(caption?.textContent, captionText, 'Native value update changed its caption');
        }
        assert.deepEqual(errors, [], 'Native processor logged an error');
        t.diagnostic((fixture.restricted ? 'Restricted' : 'Public') + ' candidate: values 0/1/2/3 update; source and existing node structure preserved.');
      } finally {
        beforeDom.window.close(); afterDom.window.close();
      }
    }
  });
