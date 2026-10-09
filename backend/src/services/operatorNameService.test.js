// Claim attribution: operator_id -> name.
//
// During a Work As / cover session the CLAIM is stored with fro_worker_id =
// the COVERED FRO and operator_id = the ACTOR, and Accounts must show the
// person who actually claimed. operator_id has no FK (it spans workers, users
// and crm_agents — migrations/182), so the name is resolved by asking all
// three tables. This pins the merge rule that decides which table wins, and the
// name/label split: a CRM agent DISPLAYS as their linked worker but STAMPS as
// their label, because receipts.agent_name is the collection grouping key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeOperatorNameRows, agentDisplayNames, resolveOperatorNames } from './operatorNameService.js';

test('workers wins over users wins over crm_agents on an id collision', () => {
  const map = mergeOperatorNameRows([
    [{ id: 'x', name: 'A Worker', login_id: 'w1' }],
    [{ id: 'x', name: 'An Admin', email: 'admin@x' }],
    [{ id: 'x', label: 'Agent Label', login_id: 'a1' }],
  ]);
  assert.equal(map.get('x').name, 'A Worker');
  assert.equal(map.get('x').label, 'A Worker');
  assert.equal(map.get('x').login, 'w1');
});

test('a source only contributes ids it actually resolved', () => {
  const map = mergeOperatorNameRows([
    [{ id: 'w', name: 'Worker One', login_id: 'w1' }],
    [{ id: 'u', name: 'User One', email: 'u@x' }],
    [{ id: 'a', label: 'Agent One', login_id: 'a1' }],
  ]);
  assert.equal(map.size, 3);
  assert.equal(map.get('u').name, 'User One');
  // No linked worker was supplied, so the label is both the display and the stamp.
  assert.equal(map.get('a').label, 'Agent One');
});

test('ids are keyed as strings so uuid formatting cannot miss', () => {
  const map = mergeOperatorNameRows([[{ id: 42, name: 'Numeric Id' }]]);
  assert.equal(map.get('42').name, 'Numeric Id');
});

test('a CRM agent carries its linked worker as the credit id', () => {
  // creditWorkerId on the FRO panel is the operator uuid; under an agent login
  // that is a crm_agents id, which matches nothing in workers. The credit reader
  // needs the LINKED worker's id, not the agent row's own.
  const map = mergeOperatorNameRows([
    [{ id: 'w1', name: 'A Worker', login_id: 'w1' }],
    [{ id: 'u1', name: 'An Admin', email: 'a@x' }],
  ]);
  assert.equal(map.get('w1').workerId, 'w1', 'a worker credits to itself');
  assert.equal(map.get('u1').workerId, 'u1');
});

test('blank rows and blank ids are skipped, not mapped to empty names', () => {
  const map = mergeOperatorNameRows([[null, {}, { id: '', name: 'Nope' }, { id: null }]]);
  assert.equal(map.size, 0);
});

test('a CRM agent displays as their linked worker but stamps as the label', () => {
  const out = agentDisplayNames({ id: 'a', label: 'Agent 21', login_id: 'agent21' }, { id: 'w', name: 'Muskan Khan', login_id: 'muskan.khan@ufs' });
  assert.deepEqual(out, { name: 'Muskan Khan', label: 'Agent 21', login: 'agent21' });
});

test('an agent with no linked worker falls back to the label for display too', () => {
  assert.deepEqual(
    agentDisplayNames({ id: 'a', label: 'Agent 22', login_id: 'agent22' }, null),
    { name: 'Agent 22', label: 'Agent 22', login: 'agent22' },
  );
});

test('a worker-as-worker cover is its own label — one name, not two', () => {
  const map = mergeOperatorNameRows([[{ id: 'w', name: 'Muskan Khan', login_id: 'muskan.khan@ufs' }]]);
  const row = map.get('w');
  assert.equal(row.name, row.label);
});

test('an empty input resolves to an empty map without touching the database', async () => {
  assert.equal((await resolveOperatorNames([])).size, 0);
  assert.equal((await resolveOperatorNames([null, '', undefined])).size, 0);
});
