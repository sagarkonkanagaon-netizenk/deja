import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { repo } from './helpers.mjs';
import { addMemory } from '../src/store.mjs';
import { collect, render } from '../src/ui.mjs';

const embedded = (html) => JSON.parse(html.match(/<script id="deja-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);

test('ui: collect scopes to one project, render inlines the data', () => {
  const a = repo();
  const b = repo();
  addMemory({ project: a, kind: 'decision', title: 'API errors use problem+json', files: ['src/api.ts'] });
  addMemory({ project: b, kind: 'note', title: 'other repo' });
  const data = collect(a);
  assert.equal(data.scope, 'project');
  assert.deepEqual(data.memories.map((m) => m.title), ['API errors use problem+json']);
  assert.deepEqual(data.memories[0].files, ['src/api.ts']);
  assert.equal(collect(null).memories.length >= 2, true);
  const out = embedded(render(data));
  assert.equal(out.memories[0].title, 'API errors use problem+json');
});

test('ui: memory text cannot break out of the data script', () => {
  const r = repo();
  const evil = '</script><img src=x onerror=alert(1)>\u2028line two';
  addMemory({ project: r, kind: 'gotcha', title: evil, body: evil });
  const html = render(collect(r));
  assert.equal(html.includes('</script><img'), false);
  assert.equal(embedded(html).memories[0].title, evil);
});
