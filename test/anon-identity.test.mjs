import { test, describe } from 'node:test';
import assert from 'node:assert';
import { compareTrees } from '../src/functions.js';
const f = (kind, name) => ({ kind, name });
describe('compareTrees — anonymous functions are counted, not positioned', () => {
  test('a pure LINE SHIFT reports no removal', () => {
    const before = [f('function','promptProcess'), f('arrow','promptProcess.<anonymous@363>'), f('arrow','promptProcess.<anonymous@376>')];
    const after  = [f('function','promptProcess'), f('arrow','promptProcess.<anonymous@382>'), f('arrow','promptProcess.<anonymous@395>')];
    const r = compareTrees(before, after);
    assert.deepEqual(r.removed, [], 'a line shift must not look like a removal');
    assert.deepEqual(r.added, [], 'nor like an addition');
  });
  test('a REAL deletion of an anonymous function is still caught', () => {
    const before = [f('function','promptProcess'), f('arrow','promptProcess.<anonymous@363>'), f('arrow','promptProcess.<anonymous@376>')];
    const after  = [f('function','promptProcess'), f('arrow','promptProcess.<anonymous@382>')];
    const r = compareTrees(before, after);
    assert.equal(r.removed.length, 1, 'losing one anonymous function must be reported');
    assert.match(r.removed[0], /2 before, 1 after/);
  });
  test('a NAMED function that vanishes is still caught by name', () => {
    const r = compareTrees([f('function','doThing'), f('function','keep')], [f('function','keep')]);
    assert.deepEqual(r.removed, ['function:doThing']);
  });
  test('a shifted PARENT does not mask a child deletion', () => {
    const before = [f('arrow','match.<anonymous@214>'), f('arrow','match.<anonymous@229>'), f('arrow','other.<anonymous@300>')];
    const after  = [f('arrow','match.<anonymous@233>'), f('arrow','other.<anonymous@319>')];
    const r = compareTrees(before, after);
    assert.equal(r.removed.length, 1, 'the lost match.* child must surface');
    assert.match(r.removed[0], /match/);
  });
});
