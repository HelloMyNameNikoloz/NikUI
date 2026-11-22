'use strict';
const find = require('../media/mac-transcript-find');
module.exports = () => {
  suite('Mac rendered transcript stable occurrences');
  const rows = [{ id: 'a', text: 'Needle needle' }, { id: 'b', text: '👋 needle <script>.*' }];
  const found = find.matches('needle', rows);
  checkEqual('every occurrence has a stable item and UTF16 offset', found.map((m) => [m.id, m.start, m.end]), [['a:0', 0, 6], ['a:7', 7, 13], ['b:3', 3, 9]]);
  checkEqual('next and previous wrap', [find.select(found, 'b:3', 2, 1), find.select(found, 'a:0', 0, -1)], [0, 2]);
  const streamed = find.matches('needle', [...rows.slice(0, 1), { id: 'b', text: rows[1].text + ' needle' }]);
  checkEqual('streaming append preserves selected occurrence', streamed[find.select(streamed, 'b:3', 2, 0)].id, 'b:3');
  checkEqual('literal metacharacters are never executed as regex', find.matches('.*', rows).map((m) => m.id), ['b:18']);
  checkEqual('no matches gives no active selection', find.select([], 'a:0', 0, 1), -1);
  checkEqual('query and result work are bounded', [find.matches('x'.repeat(301), rows).length, find.matches('x', [{ id: 'many', text: 'x'.repeat(20000) }]).length], [0, 10000]);
};
